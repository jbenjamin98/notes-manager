import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { Db } from '../db'
import {
  CALLERS,
  clearGeminiModelCache,
  DEFAULT_BASE,
  DEFAULT_MODELS,
  LlmHttpError,
  PROVIDERS,
  type ChatMsg,
  type ProviderId,
  type RateLimits,
  type Tier
} from './providers'

export type { ProviderId, Tier, ChatMsg, RateLimits } from './providers'

export interface LlmConfig {
  enabled: boolean
  /** Preference order. A provider without a key is skipped. */
  order: ProviderId[]
  /** Providers the user switched off (they keep their key but are never called). */
  disabled?: ProviderId[]
  /** Optional per-provider model overrides (free-tier model names change often). */
  models?: Partial<Record<ProviderId, Partial<Record<Tier, string>>>>
  baseUrls?: Partial<Record<ProviderId, string>>
}

export interface RouterDeps {
  db: Db
  getConfig: () => LlmConfig
  getKey: (p: ProviderId) => string | null
  /** Tokens per day this app may spend (0 or missing = unlimited). Counts what providers reported. */
  dailyBudget?: () => number
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

/** Why a call could not be made at all (the caller falls back to local behaviour). */
export class LlmUnavailable extends Error {
  constructor(
    public reason: 'disabled' | 'no-key' | 'busy' | 'failed' | 'budget',
    message: string
  ) {
    super(message)
  }
}

export type ProviderState = 'ready' | 'cooldown' | 'auth-failed' | 'no-key' | 'disabled'

export interface RouterStatus {
  enabled: boolean
  providers: {
    id: ProviderId
    hasKey: boolean
    enabled: boolean
    state: ProviderState
    until: number | null
    lastError: string | null
    /** What this app has sent to the provider (counted locally). */
    usage: { lastMinute: number; today: number; failedToday: number; tokensToday: number }
    /** What the provider itself last reported for its rate-limit window, if it reports one. */
    limits: (RateLimits & { seenAt: number }) | null
  }[]
}

const BREAKER_FAILS = 3
const BREAKER_MS = 2 * 60_000
const AUTH_COOLDOWN_MS = 10 * 60_000
const DEFAULT_429_MS = 60_000
const CACHE_TTL_MS = 60 * 60_000

interface Health {
  fails: number
  openUntil: number
  authFailedUntil: number
  lastError: string | null
}

export interface JsonRequest<T> {
  tier: Tier
  system: string
  user: string
  schema: z.ZodType<T>
  /** Same key + same tier => reuse a recent answer (for questions, not for capture). */
  cacheKey?: string
  /** Use only this provider (for the Settings "Test" button). */
  only?: ProviderId
  /** How long a cached answer stays valid (default 1 hour). */
  cacheTtlMs?: number
  /** Longest answer to allow (output tokens). */
  maxOut?: number
  /** What this call is for ("ask", "capture", "action:summarize-note"...), for the spend meter. */
  feature?: string
  /** One repair attempt for invalid JSON (default on; Light mode turns it off to save tokens). */
  repair?: boolean
}

export interface JsonResult<T> {
  data: T
  provider: ProviderId
  model: string
  cached: boolean
}

const stripFences = (s: string): string =>
  s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

export class LlmRouter {
  private health = new Map<ProviderId, Health>()

  constructor(private deps: RouterDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private h(p: ProviderId): Health {
    let x = this.health.get(p)
    if (!x) {
      x = { fails: 0, openUntil: 0, authFailedUntil: 0, lastError: null }
      this.health.set(p, x)
    }
    return x
  }

  private recentCalls(p: ProviderId): number {
    return (
      this.deps.db
        .prepare('SELECT count(*) AS c FROM llm_usage WHERE provider = ? AND ts > ?')
        .get(p, this.now() - 60_000) as { c: number }
    ).c
  }

  private model(p: ProviderId, tier: Tier): string {
    return this.deps.getConfig().models?.[p]?.[tier] || DEFAULT_MODELS[p][tier]
  }

  /** Forget cooldowns for a provider (its key just changed). */
  resetHealth(p: ProviderId): void {
    this.health.delete(p)
    if (p === 'gemini') clearGeminiModelCache()
  }

  private usage(p: ProviderId): RouterStatus['providers'][number]['usage'] {
    const midnight = new Date(this.now())
    midnight.setHours(0, 0, 0, 0)
    const r = this.deps.db
      .prepare(
        'SELECT count(*) AS n, coalesce(sum(1 - ok), 0) AS bad, coalesce(sum(coalesce(tokens_in,0) + coalesce(tokens_out,0)), 0) AS tok FROM llm_usage WHERE provider = ? AND ts >= ?'
      )
      .get(p, midnight.getTime()) as { n: number; bad: number; tok: number }
    return { lastMinute: this.recentCalls(p), today: r.n, failedToday: r.bad, tokensToday: r.tok }
  }

  private savedLimits(p: ProviderId): (RateLimits & { seenAt: number }) | null {
    const row = this.deps.db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get('llm.limits.' + p) as { value: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value) as RateLimits & { seenAt: number }
    } catch {
      return null
    }
  }

  /** Tokens spent today, by what they were spent on. */
  usageByFeature(): { feature: string; tokens: number }[] {
    const midnight = new Date(this.now())
    midnight.setHours(0, 0, 0, 0)
    return this.deps.db
      .prepare(
        "SELECT coalesce(feature, 'other') AS feature, sum(coalesce(tokens_in,0) + coalesce(tokens_out,0)) AS tokens FROM llm_usage WHERE ts >= ? GROUP BY 1 HAVING tokens > 0 ORDER BY tokens DESC"
      )
      .all(midnight.getTime()) as { feature: string; tokens: number }[]
  }

  /** Tokens spent today across providers (as reported by them), and the daily budget. */
  budget(): { used: number; limit: number } {
    const midnight = new Date(this.now())
    midnight.setHours(0, 0, 0, 0)
    const r = this.deps.db
      .prepare(
        'SELECT coalesce(sum(coalesce(tokens_in,0) + coalesce(tokens_out,0)), 0) AS tok FROM llm_usage WHERE ts >= ?'
      )
      .get(midnight.getTime()) as { tok: number }
    return { used: r.tok, limit: this.deps.dailyBudget?.() ?? 0 }
  }

  status(): RouterStatus {
    const cfg = this.deps.getConfig()
    const now = this.now()
    return {
      enabled: cfg.enabled,
      providers: cfg.order.map((id) => {
        const hasKey = !!this.deps.getKey(id)
        const enabled = !cfg.disabled?.includes(id)
        const x = this.h(id)
        const state: ProviderState = !hasKey
          ? 'no-key'
          : !enabled
            ? 'disabled'
            : x.authFailedUntil > now
              ? 'auth-failed'
              : x.openUntil > now || this.recentCalls(id) >= PROVIDERS[id].rpm
                ? 'cooldown'
                : 'ready'
        return {
          id,
          hasKey,
          enabled,
          state,
          until:
            Math.max(x.openUntil, x.authFailedUntil) > now
              ? Math.max(x.openUntil, x.authFailedUntil)
              : null,
          lastError: x.lastError,
          usage: this.usage(id),
          limits: this.savedLimits(id)
        }
      })
    }
  }

  private log(
    p: ProviderId,
    model: string,
    ok: boolean,
    tin: number | null,
    tout: number | null,
    feature: string | null
  ): void {
    this.deps.db
      .prepare(
        'INSERT INTO llm_usage (provider, model, ts, ok, tokens_in, tokens_out, feature) VALUES (?,?,?,?,?,?,?)'
      )
      .run(p, model, this.now(), ok ? 1 : 0, tin, tout, feature)
    this.deps.db.exec("DELETE FROM llm_usage WHERE ts < strftime('%s','now','-3 days') * 1000")
  }

  private async callOnce(
    p: ProviderId,
    model: string,
    key: string,
    messages: ChatMsg[],
    maxOut?: number,
    feature: string | null = null
  ): Promise<{ text: string; model: string }> {
    const cfg = this.deps.getConfig()
    const f = this.deps.fetchImpl ?? fetch
    const base = cfg.baseUrls?.[p] ?? DEFAULT_BASE[p]
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.deps.timeoutMs ?? 30_000)
    try {
      const res = await CALLERS[PROVIDERS[p].kind](
        f,
        base,
        key,
        model,
        messages,
        ctrl.signal,
        maxOut
      )
      const usedModel = res.model ?? model
      this.log(p, usedModel, true, res.tokensIn, res.tokensOut, feature)
      if (res.limits) {
        this.deps.db
          .prepare(
            'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
          )
          .run('llm.limits.' + p, JSON.stringify({ ...res.limits, seenAt: this.now() }))
      }
      return { text: res.text, model: usedModel }
    } catch (err) {
      this.log(p, model, false, null, null, feature)
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Ask for JSON matching `schema`, trying providers in order. Validates with zod and, if the model
   * wrote something invalid, asks once more with the exact problems. Falls through to the next
   * provider on rate limits, auth errors, outages and unrepairable output.
   */
  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const cfg = this.deps.getConfig()
    if (!cfg.enabled)
      throw new LlmUnavailable('disabled', 'AI features are turned off in Settings.')
    const now = this.now()

    const cacheId = req.cacheKey
      ? createHash('sha256')
          .update(`${req.tier}\n${req.system}\n${req.user}\n${req.cacheKey}`)
          .digest('hex')
      : null
    if (cacheId) {
      const hit = this.deps.db
        .prepare('SELECT response_json AS r, created_at AS at FROM llm_cache WHERE key = ?')
        .get(cacheId) as { r: string; at: string } | undefined
      if (hit && now - new Date(hit.at + 'Z').getTime() < (req.cacheTtlMs ?? CACHE_TTL_MS)) {
        const parsed = req.schema.safeParse(JSON.parse(hit.r))
        if (parsed.success)
          return { data: parsed.data, provider: cfg.order[0], model: 'cache', cached: true }
      }
    }

    // Cached answers (above) are free. Anything that would call a provider respects the daily budget.
    const b = this.budget()
    if (b.limit > 0 && b.used >= b.limit && !req.only)
      throw new LlmUnavailable(
        'budget',
        `Today's AI budget (${b.limit.toLocaleString()} tokens) is used up, so this was done on your computer. Raise it in Settings → AI Co-Pilot.`
      )
    const keyed = cfg.order.filter(
      (p) => !!this.deps.getKey(p) && (req.only ? req.only === p : !cfg.disabled?.includes(p))
    )
    if (keyed.length === 0)
      throw new LlmUnavailable(
        'no-key',
        'Add an API key for at least one AI provider in Settings to turn on AI.'
      )
    const usable = keyed.filter((p) => {
      const x = this.h(p)
      return (
        x.openUntil <= now && x.authFailedUntil <= now && this.recentCalls(p) < PROVIDERS[p].rpm
      )
    })
    if (usable.length === 0)
      throw new LlmUnavailable(
        'busy',
        'The AI providers are busy or cooling down. Try again in a minute.'
      )

    const errors: string[] = []
    for (const p of usable) {
      const key = this.deps.getKey(p)!
      const model = this.model(p, req.tier)
      const messages: ChatMsg[] = [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user }
      ]
      try {
        const first = await this.callOnce(p, model, key, messages, req.maxOut, req.feature ?? null)
        let text = first.text
        let data: T | undefined
        for (let attempt = 0; attempt < 2 && data === undefined; attempt++) {
          let problem: string | null = null
          try {
            const parsed = req.schema.safeParse(JSON.parse(stripFences(text)))
            if (parsed.success) data = parsed.data
            else
              problem = parsed.error.issues
                .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
                .join('; ')
          } catch {
            problem = 'the output was not valid JSON'
          }
          if (data === undefined && attempt === 0 && req.repair !== false) {
            text = (
              await this.callOnce(
                p,
                first.model,
                key,
                [
                  ...messages,
                  { role: 'assistant', content: text },
                  {
                    role: 'user',
                    content: `That was invalid (${problem}). Reply with ONLY corrected JSON that matches the required shape.`
                  }
                ],
                req.maxOut,
                req.feature ?? null
              )
            ).text
          } else if (data === undefined) {
            throw new Error(`unrepairable output (${problem})`)
          }
        }
        const x = this.h(p)
        x.fails = 0
        x.lastError = null
        if (cacheId) {
          this.deps.db
            .prepare(
              'INSERT INTO llm_cache (key, response_json, created_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET response_json = excluded.response_json, created_at = CURRENT_TIMESTAMP'
            )
            .run(cacheId, JSON.stringify(data))
        }
        return { data: data as T, provider: p, model: first.model, cached: false }
      } catch (err) {
        const x = this.h(p)
        const msg = (err as Error).message
        x.lastError = msg.slice(0, 200)
        errors.push(`${p}: ${msg.slice(0, 120)}`)
        if (err instanceof LlmHttpError && err.status === 429) {
          x.openUntil = this.now() + Math.max(5, err.retryAfterSec ?? DEFAULT_429_MS / 1000) * 1000
        } else if (err instanceof LlmHttpError && (err.status === 401 || err.status === 403)) {
          x.authFailedUntil = this.now() + AUTH_COOLDOWN_MS
        } else {
          x.fails++
          if (x.fails >= BREAKER_FAILS) {
            x.openUntil = this.now() + BREAKER_MS
            x.fails = 0
          }
        }
      }
    }
    throw new LlmUnavailable('failed', `The AI providers could not answer (${errors.join(' | ')}).`)
  }
}
