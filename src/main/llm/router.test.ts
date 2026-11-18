import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { openDb } from '../db'
import { LlmRouter, LlmUnavailable, type LlmConfig, type ProviderId } from './router'
import { PROVIDER_IDS, parseDurationMs, parseLimits, parseRetryAfter } from './providers'

interface Step {
  status?: number
  headers?: Record<string, string>
  /** The JSON text the model "wrote" (success only). */
  text?: string
  delayMs?: number
  models?: string[]
}
type Seen = { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }

/** A fake of every provider on one local port (`/<provider>/...`). Each plays back a script. */
async function fakeProviders(): Promise<{
  base: Record<ProviderId, string>
  script: Record<ProviderId, Step[]>
  seen: Record<ProviderId, Seen[]>
  server: Server
}> {
  const script = Object.fromEntries(PROVIDER_IDS.map((p) => [p, [] as Step[]])) as Record<
    ProviderId,
    Step[]
  >
  const seen = Object.fromEntries(PROVIDER_IDS.map((p) => [p, [] as Seen[]])) as Record<
    ProviderId,
    Seen[]
  >
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const p = req.url!.split('/')[1] as ProviderId
      seen[p].push({ path: req.url!, headers: req.headers, body: JSON.parse(raw || '{}') })
      const step = script[p].shift() ?? { status: 200, text: '{"ok":true}' }
      setTimeout(() => {
        res.statusCode = step.status ?? 200
        for (const [k, v] of Object.entries(step.headers ?? {})) res.setHeader(k, v)
        res.setHeader('content-type', 'application/json')
        if (req.method === 'GET' && req.url?.includes('/models')) {
          res.end(
            JSON.stringify({
              models: (step.models ?? ['gemini-3.5-flash-lite', 'gemini-3-flash-preview']).map(
                (m) => ({ name: 'models/' + m, supportedGenerationMethods: ['generateContent'] })
              )
            })
          )
          return
        }
        if ((step.status ?? 200) >= 400) {
          res.end(JSON.stringify({ error: { message: 'scripted failure' } }))
          return
        }
        const text = step.text ?? '{"ok":true}'
        res.end(
          JSON.stringify(
            p === 'gemini'
              ? {
                  candidates: [{ content: { parts: [{ text }] } }],
                  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 }
                }
              : p === 'anthropic'
                ? {
                    content: [{ type: 'text', text }],
                    usage: { input_tokens: 9, output_tokens: 4 }
                  }
                : {
                    choices: [{ message: { content: text } }],
                    usage: { prompt_tokens: 13, completion_tokens: 5 }
                  }
          )
        )
      }, step.delayMs ?? 0)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const base = Object.fromEntries(
    PROVIDER_IDS.map((p) => [p, `http://127.0.0.1:${port}/${p}`])
  ) as Record<ProviderId, string>
  return { base, script, seen, server }
}

const schema = z.object({ answer: z.string(), n: z.number() })
const ok = (answer = 'hi', n = 1): string => JSON.stringify({ answer, n })
const req = { tier: 'chat' as const, system: 'sys', user: 'hello', schema }

describe('LlmRouter against fake provider servers', () => {
  const servers: Server[] = []
  afterEach(async () => {
    while (servers.length) await new Promise((r) => servers.pop()!.close(r))
  })

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  async function setup(
    opts: {
      keys?: Partial<Record<ProviderId, string | undefined>>
      enabled?: boolean
      timeoutMs?: number
      order?: ProviderId[]
      disabled?: ProviderId[]
      models?: LlmConfig['models']
    } = {}
  ) {
    const fake = await fakeProviders()
    servers.push(fake.server)
    const db = openDb(':memory:')
    const clock = { t: Date.now() }
    const cfg: LlmConfig = {
      enabled: opts.enabled ?? true,
      order: opts.order ?? ['gemini', 'groq', 'openai', 'anthropic', 'openrouter'],
      disabled: opts.disabled,
      models: opts.models,
      baseUrls: fake.base
    }
    // Gemini and Groq have keys by default; others only when asked.
    const keys: Partial<Record<ProviderId, string | undefined>> = {
      gemini: 'G-KEY',
      groq: 'Q-KEY',
      ...opts.keys
    }
    const router = new LlmRouter({
      db,
      getConfig: () => cfg,
      getKey: (p) => keys[p] ?? null,
      now: () => clock.t,
      timeoutMs: opts.timeoutMs
    })
    router.resetHealth('gemini')
    return { fake, db, router, clock, cfg }
  }

  it('calls Gemini first with its key, JSON mime type and the right model, and logs usage', async () => {
    const { fake, db, router } = await setup()
    fake.script.gemini.push({ text: ok('from gemini') })
    const r = await router.generateJson(req)
    expect(r).toMatchObject({
      data: { answer: 'from gemini' },
      provider: 'gemini',
      model: 'gemini-flash-latest',
      cached: false
    })
    const call = fake.seen.gemini[0]
    expect(call.path).toBe('/gemini/models/gemini-flash-latest:generateContent')
    expect(call.headers['x-goog-api-key']).toBe('G-KEY')
    expect((call.body.generationConfig as { responseMimeType: string }).responseMimeType).toBe(
      'application/json'
    )
    expect(JSON.stringify(call.body)).toContain('"systemInstruction"')
    expect(db.prepare('SELECT provider, ok, tokens_in, tokens_out FROM llm_usage').all()).toEqual([
      { provider: 'gemini', ok: 1, tokens_in: 11, tokens_out: 7 }
    ])
    fake.script.gemini.push({ text: ok() })
    await router.generateJson({ ...req, tier: 'extract' })
    expect(fake.seen.gemini[1].path).toContain('gemini-flash-lite-latest')
  })

  it('fails over to the next provider on a 429, remembers the cooldown, then recovers', async () => {
    const { fake, router, clock } = await setup()
    fake.script.gemini.push({ status: 429, headers: { 'retry-after': '30' } })
    fake.script.groq.push({ text: ok('from groq') }, { text: ok('again') })
    const r = await router.generateJson(req)
    expect(r).toMatchObject({ provider: 'groq', data: { answer: 'from groq' } })
    expect(fake.seen.groq[0].headers.authorization).toBe('Bearer Q-KEY')
    expect(fake.seen.groq[0].path).toBe('/groq/chat/completions')
    expect(router.status().providers.find((p) => p.id === 'gemini')!.state).toBe('cooldown')

    await router.generateJson(req)
    expect(fake.seen.gemini).toHaveLength(1) // not asked again during the cooldown

    clock.t += 31_000 // Retry-After has passed
    fake.script.gemini.push({ text: ok('back') })
    expect((await router.generateJson(req)).provider).toBe('gemini')
  })

  it('never calls a provider the user switched off, but still lets them test it', async () => {
    const { fake, router } = await setup({ disabled: ['gemini'] })
    fake.script.groq.push({ text: ok('groq it is') })
    expect((await router.generateJson(req)).provider).toBe('groq')
    expect(fake.seen.gemini).toHaveLength(0)
    expect(router.status().providers.find((p) => p.id === 'gemini')).toMatchObject({
      state: 'disabled',
      enabled: false,
      hasKey: true
    })
    fake.script.gemini.push({ text: ok('test ok') })
    expect((await router.generateJson({ ...req, only: 'gemini' })).provider).toBe('gemini')
  })

  it('follows the user-chosen order, and a provider without a key is skipped', async () => {
    const { fake, router } = await setup({
      order: ['openai', 'groq', 'gemini'],
      keys: { openai: undefined }
    })
    fake.script.groq.push({ text: ok('second choice') })
    expect((await router.generateJson(req)).provider).toBe('groq')
    expect(fake.seen.openai).toHaveLength(0)
    expect(router.status().providers.map((p) => p.id)).toEqual(['openai', 'groq', 'gemini'])
    expect(router.status().providers[0].state).toBe('no-key')
  })

  it('speaks Claude and OpenAI dialects with the right headers and models', async () => {
    const { fake, router } = await setup({
      order: ['anthropic', 'openai'],
      keys: { anthropic: 'A-KEY', openai: 'O-KEY' }
    })
    fake.script.anthropic.push({ text: ok('from claude') })
    const r = await router.generateJson(req)
    expect(r).toMatchObject({ provider: 'anthropic', data: { answer: 'from claude' } })
    const call = fake.seen.anthropic[0]
    expect(call.path).toBe('/anthropic/messages')
    expect(call.headers['x-api-key']).toBe('A-KEY')
    expect(call.headers['anthropic-version']).toBe('2023-06-01')
    expect(call.body.system).toBe('sys')
    expect(call.body.model).toBe('claude-sonnet-5-5')
    expect(JSON.stringify(call.body.messages)).not.toContain('"system"')

    fake.script.anthropic.push({ status: 500 }, { status: 500 })
    fake.script.openai.push({ text: ok('from openai') })
    const r2 = await router.generateJson({ ...req, tier: 'extract' })
    expect(r2).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini' })
    expect(fake.seen.openai[0].headers.authorization).toBe('Bearer O-KEY')
  })

  it('shows local usage counts and the remaining limits a provider reports', async () => {
    const { fake, router } = await setup({
      order: ['openai', 'anthropic'],
      keys: { openai: 'O', anthropic: 'A' }
    })
    fake.script.openai.push({
      text: ok(),
      headers: {
        'x-ratelimit-remaining-requests': '58',
        'x-ratelimit-limit-requests': '60',
        'x-ratelimit-remaining-tokens': '90000',
        'x-ratelimit-limit-tokens': '100000'
      }
    })
    await router.generateJson(req)
    fake.script.anthropic.push({ status: 500 })
    await expect(router.generateJson({ ...req, only: 'anthropic' })).rejects.toBeInstanceOf(
      LlmUnavailable
    )
    const [openai, anthropic] = router.status().providers
    expect(openai.usage).toMatchObject({ today: 1, lastMinute: 1, failedToday: 0, tokensToday: 18 })
    expect(openai.limits).toMatchObject({
      remainingRequests: 58,
      limitRequests: 60,
      remainingTokens: 90000,
      limitTokens: 100000
    })
    expect(anthropic.usage).toMatchObject({ today: 1, failedToday: 1 })
    expect(anthropic.limits).toBeNull()
  })

  it('asks the model to repair invalid output once, with the exact problems, then succeeds', async () => {
    const { fake, router } = await setup()
    fake.script.gemini.push({ text: '```json\n{"answer": 5}\n```' })
    fake.script.gemini.push({ text: ok('fixed', 2) })
    const r = await router.generateJson(req)
    expect(r.data).toEqual({ answer: 'fixed', n: 2 })
    expect(fake.seen.gemini).toHaveLength(2)
    const repair = JSON.stringify(fake.seen.gemini[1].body)
    expect(repair).toContain('That was invalid')
    expect(repair).toContain('answer')
  })

  it('falls through to the next provider when output cannot be repaired', async () => {
    const { fake, router } = await setup()
    fake.script.gemini.push({ text: 'not json at all' }, { text: 'still not json' })
    fake.script.groq.push({ text: ok('rescued') })
    const r = await router.generateJson(req)
    expect(r).toMatchObject({ provider: 'groq', data: { answer: 'rescued' } })
  })

  it('treats a rejected key (401) as a long cooldown for that provider only, until a new key is saved', async () => {
    const { fake, router } = await setup()
    fake.script.gemini.push({ status: 401 })
    fake.script.groq.push({ text: ok() }, { text: ok() })
    await router.generateJson(req)
    expect(router.status().providers.find((p) => p.id === 'gemini')).toMatchObject({
      state: 'auth-failed'
    })
    await router.generateJson(req)
    expect(fake.seen.gemini).toHaveLength(1)
    router.resetHealth('gemini')
    fake.script.gemini.push({ text: ok('new key') })
    expect((await router.generateJson(req)).provider).toBe('gemini')
  })

  it('opens a circuit breaker after repeated server errors, then recovers', async () => {
    const { fake, router, clock } = await setup({ keys: { groq: undefined } })
    fake.script.gemini.push({ status: 500 }, { status: 500 }, { status: 500 })
    for (let i = 0; i < 3; i++)
      await expect(router.generateJson(req)).rejects.toBeInstanceOf(LlmUnavailable)
    expect(fake.seen.gemini).toHaveLength(3)
    await expect(router.generateJson(req)).rejects.toMatchObject({ reason: 'busy' })
    expect(fake.seen.gemini).toHaveLength(3)
    clock.t += 2 * 60_000 + 1000
    fake.script.gemini.push({ text: ok('recovered') })
    expect((await router.generateJson(req)).data.answer).toBe('recovered')
  })

  it('respects a per-minute budget using the persisted usage log', async () => {
    const { fake, db, router, clock } = await setup()
    const ins = db.prepare('INSERT INTO llm_usage (provider, model, ts, ok) VALUES (?,?,?,1)')
    for (let i = 0; i < 10; i++) ins.run('gemini', 'm', clock.t - 5000)
    fake.script.groq.push({ text: ok('groq took it') })
    const r = await router.generateJson(req)
    expect(r.provider).toBe('groq')
    expect(fake.seen.gemini).toHaveLength(0)
  })

  it('reports why it cannot call: disabled, no key, nothing available', async () => {
    await expect((await setup({ enabled: false })).router.generateJson(req)).rejects.toMatchObject({
      reason: 'disabled'
    })
    await expect(
      (await setup({ keys: { gemini: undefined, groq: undefined } })).router.generateJson(req)
    ).rejects.toMatchObject({ reason: 'no-key' })
    const s = await setup({ disabled: ['gemini', 'groq'] })
    await expect(s.router.generateJson(req)).rejects.toMatchObject({ reason: 'no-key' })
    const f = await setup()
    f.fake.script.gemini.push({ status: 500 })
    f.fake.script.groq.push({ status: 500 })
    await expect(f.router.generateJson(req)).rejects.toMatchObject({
      reason: 'failed',
      message: expect.stringContaining('gemini')
    })
  })

  it('caches repeated questions for an hour, but never caches when no cacheKey is given', async () => {
    const { fake, router } = await setup()
    fake.script.gemini.push({ text: ok('first') })
    const a = await router.generateJson({ ...req, cacheKey: 'q1' })
    const b = await router.generateJson({ ...req, cacheKey: 'q1' })
    expect([a.cached, b.cached]).toEqual([false, true])
    expect(b.data.answer).toBe('first')
    expect(fake.seen.gemini).toHaveLength(1)
    fake.script.gemini.push({ text: ok('fresh') })
    expect((await router.generateJson(req)).data.answer).toBe('fresh')
  })

  it('passes the output limit to each provider, and skips the repair retry when asked to', async () => {
    const { fake, router } = await setup({
      order: ['gemini', 'openai', 'anthropic'],
      keys: { openai: 'O', anthropic: 'A' }
    })
    fake.script.gemini.push({ text: ok() })
    await router.generateJson({ ...req, maxOut: 321 })
    expect(
      (fake.seen.gemini[0].body.generationConfig as { maxOutputTokens: number }).maxOutputTokens
    ).toBe(321)
    fake.script.openai.push({ text: ok() })
    await router.generateJson({ ...req, maxOut: 222, only: 'openai' })
    expect(fake.seen.openai[0].body.max_tokens).toBe(222)
    fake.script.anthropic.push({ text: ok() })
    await router.generateJson({ ...req, maxOut: 111, only: 'anthropic' })
    expect(fake.seen.anthropic[0].body.max_tokens).toBe(111)

    fake.script.gemini.push({ text: 'not json' }, { text: ok('would have been repaired') })
    await expect(
      router.generateJson({ ...req, repair: false, only: 'gemini' })
    ).rejects.toBeInstanceOf(LlmUnavailable)
    expect(fake.seen.gemini).toHaveLength(2) // the first call above plus this one: no second attempt
  })

  it('records what each call was for, for the spend meter', async () => {
    const fake = await fakeProviders()
    servers.push(fake.server)
    const db = openDb(':memory:')
    const router = new LlmRouter({
      db,
      getConfig: () => ({ enabled: true, order: ['gemini'], baseUrls: fake.base }),
      getKey: () => 'K'
    })
    fake.script.gemini.push({ text: ok('a') }, { text: ok('b') })
    await router.generateJson({ ...req, feature: 'ask' })
    await router.generateJson({ ...req, feature: 'action:summarize-note' })
    expect(
      router
        .usageByFeature()
        .map((u) => u.feature)
        .sort()
    ).toEqual(['action:summarize-note', 'ask'])
    expect(router.usageByFeature()[0].tokens).toBe(18)
  })

  it('stops calling providers once the daily token budget is spent, but cached answers stay free', async () => {
    const fake = await fakeProviders()
    servers.push(fake.server)
    const db = openDb(':memory:')
    const router = new LlmRouter({
      db,
      dailyBudget: () => 25,
      getConfig: () => ({ enabled: true, order: ['gemini'], baseUrls: fake.base }),
      getKey: () => 'K'
    })
    fake.script.gemini.push({ text: ok('first') }) // reports 11 + 7 = 18 tokens
    await router.generateJson({ ...req, cacheKey: 'c' })
    expect(router.budget()).toEqual({ used: 18, limit: 25 })
    fake.script.gemini.push({ text: ok('second') }) // 18 -> 36, over the limit
    await router.generateJson(req)
    await expect(router.generateJson(req)).rejects.toMatchObject({ reason: 'budget' })
    expect((await router.generateJson({ ...req, cacheKey: 'c' })).cached).toBe(true) // free
    expect(fake.seen.gemini).toHaveLength(2)
  })

  it('times out a hung provider and moves on', async () => {
    const { fake, router } = await setup({ timeoutMs: 150 })
    fake.script.gemini.push({ delayMs: 1000, text: ok('too slow') })
    fake.script.groq.push({ text: ok('on time') })
    const r = await router.generateJson(req)
    expect(r.provider).toBe('groq')
  })

  it('falls back to an available Gemini model when a retired model returns 404 and caches the replacement', async () => {
    const { fake, db, router } = await setup({
      models: { gemini: { extract: 'gemini-2.5-flash-lite' } }
    })
    fake.script.gemini.push(
      { status: 404 },
      { models: ['gemini-2.5-pro', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview'] },
      { text: ok('from 3.5 lite') },
      { text: ok('cached model') }
    )
    const r1 = await router.generateJson({ ...req, tier: 'extract', only: 'gemini' })
    expect(r1).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      data: { answer: 'from 3.5 lite' }
    })
    expect(fake.seen.gemini.map((c) => c.path)).toEqual([
      '/gemini/models/gemini-2.5-flash-lite:generateContent',
      '/gemini/models?pageSize=200',
      '/gemini/models/gemini-3.5-flash-lite:generateContent'
    ])
    expect(db.prepare('SELECT model FROM llm_usage').all()).toEqual([
      { model: 'gemini-3.5-flash-lite' }
    ])

    const r2 = await router.generateJson({ ...req, tier: 'extract', only: 'gemini' })
    expect(r2).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      data: { answer: 'cached model' }
    })
    expect(fake.seen.gemini).toHaveLength(4)
    expect(fake.seen.gemini[3].path).toBe('/gemini/models/gemini-3.5-flash-lite:generateContent')
  })

  describe('rate-limit and usage tracking', () => {
    it('reads Retry-After as seconds or an HTTP date, and OpenAI-style durations', () => {
      expect(parseRetryAfter('30')).toBe(30)
      const now = Date.parse('2026-11-18T10:00:00Z')
      expect(parseRetryAfter('Wed, 18 Nov 2026 10:01:30 GMT', now)).toBe(90)
      expect(parseRetryAfter(null)).toBeNull()
      expect(parseDurationMs('6m0s')).toBe(360_000)
      expect(parseDurationMs('1.5s')).toBe(1500)
      expect(parseDurationMs('250ms')).toBe(250)
      expect(parseDurationMs('1h2m')).toBe(3_720_000)
    })

    it('captures when each allowance refills, for both header styles', () => {
      const now = 1_000_000
      const oa = parseLimits(
        new Headers({
          'x-ratelimit-remaining-requests': '3',
          'x-ratelimit-limit-requests': '30',
          'x-ratelimit-reset-requests': '2s',
          'x-ratelimit-reset-tokens': '1m'
        }),
        'openai',
        now
      )
      expect(oa).toMatchObject({
        remainingRequests: 3,
        limitRequests: 30,
        resetRequestsAt: now + 2000,
        resetTokensAt: now + 60_000
      })
      const an = parseLimits(
        new Headers({
          'anthropic-ratelimit-tokens-remaining': '100',
          'anthropic-ratelimit-tokens-reset': '2026-11-18T10:00:00Z'
        }),
        'anthropic',
        now
      )
      expect(an).toMatchObject({
        remainingTokens: 100,
        resetTokensAt: Date.parse('2026-11-18T10:00:00Z')
      })
    })

    it('treats an overloaded 529 like a rate limit: cools down, logs why, and keeps the 429 headers', async () => {
      const { fake, db, router } = await setup()
      fake.script.gemini.push({
        status: 529,
        headers: {
          'retry-after': '20',
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-limit-requests': '10'
        }
      })
      fake.script.groq.push({ text: ok('groq') })
      const r = await router.generateJson({ ...req, feature: 'insights' })
      expect(r.provider).toBe('groq')
      const gem = router.status().providers.find((p) => p.id === 'gemini')!
      expect(gem.state).toBe('cooldown')
      expect(gem.limits).toMatchObject({ remainingRequests: 0, limitRequests: 10 })
      expect(router.recentEvents()[0]).toMatchObject({
        provider: 'gemini',
        status: 529,
        retryAfterSec: 20,
        feature: 'insights'
      })
      expect(db.prepare('SELECT count(*) AS c FROM llm_events').get()).toEqual({ c: 1 })
    })

    it('counts answers reused from the cache, and they cost no tokens', async () => {
      const { fake, db, router } = await setup()
      fake.script.gemini.push({ text: ok('once') })
      const cached = { ...req, cacheKey: 'same-question' }
      await router.generateJson(cached)
      expect(router.cacheHitsToday()).toBe(0)
      const again = await router.generateJson(cached)
      expect(again.cached).toBe(true)
      await router.generateJson(cached)
      expect(router.cacheHitsToday()).toBe(2)
      expect(fake.seen.gemini).toHaveLength(1)
      expect(db.prepare('SELECT count(*) AS c FROM llm_usage').get()).toEqual({ c: 1 })
    })

    it('folds calls older than a few days into a daily history instead of deleting them', async () => {
      const { fake, db, router, clock } = await setup()
      fake.script.gemini.push({ text: ok('old') })
      clock.t -= 5 * 86_400_000
      await router.generateJson({ ...req, feature: 'ask' })
      clock.t += 5 * 86_400_000
      fake.script.gemini.push({ text: ok('new') })
      clock.t += 2 * 3_600_000 // past the hourly rollup gate
      await router.generateJson({ ...req, feature: 'capture' })
      const raw = db.prepare('SELECT count(*) AS c FROM llm_usage').get() as { c: number }
      expect(raw.c).toBe(1)
      const daily = db.prepare('SELECT feature, calls, tokens_in FROM llm_usage_daily').all()
      expect(daily).toEqual([{ feature: 'ask', calls: 1, tokens_in: 11 }])
      const days = router.history(7)
      expect(days).toHaveLength(7)
      expect(days.reduce((n, d) => n + d.calls, 0)).toBe(2)
    })
  })
})
