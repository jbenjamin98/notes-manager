import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db'
import type { Vault } from '../vault/vault'
import { votedKinds } from '../entities/discover'
import {
  applySuggested,
  autoTag,
  autoTagDocument,
  compileTagVocab,
  findNewNames,
  protectedRanges,
  TOPIC_STOP,
  untaggedWordCount,
  needsModel,
  type CompiledTagVocab,
  type Suggested
} from '../../shared/autotag'

import { LlmUnavailable, type JsonRequest, type JsonResult } from '../llm/router'
/** Model calls a day (on top of the per-minute limit and the provider's own budget). */ const DAILY_CAP = 120

/**
 * Main-process side of auto-tagging: tags text on submit (quick capture, Co-Pilot cards, Waiting On
 * lines) and answers the editor's "what is new in this line?" question, using the small model for
 * topics and names nobody has listed yet. Everything the model says is checked: each tag must be
 * words that really are in the line.
 */
export interface TagDeps {
  db: Db
  vault: () => Vault
  llm: { generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> }
  settings: () => {
    meAliases: string[]
    llm: { enabled: boolean }
    autoTag: {
      enabled: boolean
      ai: boolean
      ignore: string[]
      kinds?: Record<string, string>
      topics?: string[]
    }
  }
  now?: () => number
  /** False when the AI provider is close to its rate limit: tagging never takes the last calls from the Co-Pilot. */
  headroom?: () => boolean
}

const Out = z.object({
  tags: z
    .array(
      z.object({
        text: z.string(),
        kind: z.enum(['topic', 'person', 'customer', 'project', 'system', 'place'])
      })
    )
    .nullish()
})

const SYSTEM = [
  'You tag one line a person just wrote in their work notes, so it links to the right people, companies and topics.',
  'Return ONLY JSON: {"tags":[{"text": the exact words from the line, "kind": "topic"|"person"|"customer"|"project"|"system"|"place"}]}.',
  'Lean toward tagging: if a word might be worth a tag, include it. A missed tag costs more than an extra one. Pick at most 4 topics and at most 5 named things.',
  '- A topic is one lowercase-able word that names something the line is about (firewall, budget, cats, onboarding, migration). Skip only vague filler (thing, issue, work, team), verbs, dates, numbers and pronouns.',
  '- A named thing is a specific person, company, project, system or place that is written in the line with a capital letter (Matt, Acme, Denver, Jira).',
  '- Copy each text EXACTLY as written in the line. Never invent words. Skip anything that already starts with @ or #.',
  '- If nothing in the line is worth tagging, return {"tags":[]}.'
].join('\n')

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16)

export class AutoTagger {
  private minute: number[] = []
  constructor(private deps: TagDeps) {}

  /** Built fresh each time: this only runs when something is saved or a line is finished. */
  private vocab(): CompiledTagVocab {
    return compileTagVocab(
      this.deps.vault().tagVocabulary(this.deps.settings().autoTag.topics ?? [])
    )
  }

  private me(): Set<string> {
    return new Set(['me', ...this.deps.settings().meAliases.map((a) => a.toLowerCase())])
  }

  private voted: { at: number; kinds: Record<string, string> } | null = null

  /** What you told it (recategorise) beats what your notes' wording says (voting across all mentions). */
  private kinds(): Record<string, string> {
    const now = this.deps.now?.() ?? Date.now()
    if (!this.voted || now - this.voted.at > 10 * 60_000) {
      let kinds: Record<string, string> = {}
      try {
        kinds = votedKinds(this.deps.db, this.vocab(), this.me())
      } catch {
        /* voting is an extra; a failure just means no votes */
      }
      this.voted = { at: now, kinds }
    }
    return { ...this.voted.kinds, ...(this.deps.settings().autoTag.kinds ?? {}) }
  }

  private ignore(): Set<string> {
    return new Set(this.deps.settings().autoTag.ignore.map((w) => w.toLowerCase()))
  }

  /** Model calls made today and the daily limit (shown in Settings). */
  usage(): { today: number; cap: number } {
    const key = `autotag.ai.${new Date(this.deps.now?.() ?? Date.now()).toISOString().slice(0, 10)}`
    const row = this.deps.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      { value: string } | undefined
    return { today: Number(row?.value ?? 0), cap: DAILY_CAP }
  }

  /** Under a handful of model calls a minute, and a daily cap, on top of the token budget. */
  private allowAi(): boolean {
    const now = this.deps.now?.() ?? Date.now()
    this.minute = this.minute.filter((t) => now - t < 60_000)
    if (this.minute.length >= 6) return false
    if (this.deps.headroom && !this.deps.headroom()) return false
    const key = `autotag.ai.${new Date(now).toISOString().slice(0, 10)}`
    const n = Number(
      (
        this.deps.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
          { value: string } | undefined
      )?.value ?? 0
    )
    if (n >= DAILY_CAP) return false
    this.deps.db
      .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
      .run(key, String(n + 1))
    this.minute.push(now)
    return true
  }

  /** New topics and names in one line: the verb-cue finder, plus the model when allowed. */
  async suggest(line: string): Promise<{ tags: Suggested[]; via: 'llm' | 'rules' | 'none' }> {
    const s = this.deps.settings()
    if (!s.autoTag.enabled) return { tags: [], via: 'none' }
    const v = this.vocab()
    const me = this.me()
    const ignore = this.ignore()
    const tags: Suggested[] = findNewNames(line, v, me, { ignore, kinds: this.kinds() }).map(
      (n) => ({ text: n.text, kind: n.kind, ...(n.maybe ? { maybe: true } : {}) })
    )
    let via: 'llm' | 'rules' = 'rules'
    const worthAsking =
      s.autoTag.ai &&
      s.llm.enabled &&
      line.trim().length >= 8 &&
      untaggedWordCount(line) >= 2 &&
      needsModel(
        line,
        v,
        tags.map((t) => t.text)
      )
    if (worthAsking && this.allowAi()) {
      try {
        const res = await this.deps.llm.generateJson({
          tier: 'extract',
          feature: 'autotag',
          system: SYSTEM,
          user: `Line: ${line}`,
          schema: Out,
          maxOut: 200,
          repair: false,
          cacheKey: `autotag:${hash(line)}`,
          cacheTtlMs: 24 * 3600_000
        })
        via = 'llm'
        tags.push(...this.check(line, res.data.tags ?? [], v, me, ignore))
      } catch (err) {
        if (!(err instanceof LlmUnavailable)) {
          /* a model hiccup is not worth bothering anyone about */
        }
      }
    }
    // One tag per exact text.
    const seen = new Set<string>()
    const out = tags.filter((t) => {
      const k = t.text.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    return { tags: out, via }
  }

  /** Keep only tags that are real words of the line, within the limits, and not already known. */
  private check(
    line: string,
    tags: Suggested[],
    v: CompiledTagVocab,
    me: Set<string>,
    ignore: Set<string>
  ): Suggested[] {
    const skip = protectedRanges(line)
    const out: Suggested[] = []
    let topics = 0
    let names = 0
    for (const t of tags) {
      const text = t.text.trim()
      if (!text || text.length > 60) continue
      const at = line.indexOf(text)
      if (at < 0) continue // the model made it up
      if (skip.some(([a, b]) => at < b && at + text.length > a)) continue
      if (/[@#]/.test(line.slice(Math.max(0, at - 1), at))) continue
      const k = text.toLowerCase()
      if (ignore.has(k) || me.has(k) || v.byTerm.has(k) || v.byTerm.has(text)) continue
      if (t.kind === 'topic') {
        if (/\s/.test(text) || TOPIC_STOP.has(k) || text.length < 3 || topics >= 4) continue
        topics++
      } else {
        // A name is written with a capital letter and is not an ordinary word.
        if (text[0] === text[0].toLowerCase() || names >= 5) continue
        if (TOPIC_STOP.has(k)) continue
        names++
      }
      out.push({ text, kind: t.kind })
    }
    return out
  }

  /** Add the new names to your lists (so `@Matt` means something), then write the tags into the text. */
  async tagNewThings(text: string, tags: Suggested[]): Promise<string> {
    const names = tags.filter((t) => t.kind !== 'topic')
    for (const n of names)
      await this.deps
        .vault()
        .upsertRegistryEntry(n.kind as Exclude<Suggested['kind'], 'topic'>, n.text, [])
    return applySuggested(text, tags, { ignore: this.ignore() }).text
  }

  /** Tag a whole note with what your lists know (no model): returns the new text and how many tags. */
  tagDocument(content: string): { text: string; count: number } {
    if (!this.deps.settings().autoTag.enabled) return { text: content, count: 0 }
    return autoTagDocument(content, this.vocab(), { ignore: this.ignore() })
  }

  /**
   * Tag text that is being saved (quick capture, a Co-Pilot card, a Waiting On line): the words
   * your lists already know, then (unless `fast`) new names and topics from the model.
   */
  async tagOnSubmit(
    text: string,
    opts: { fast?: boolean; timeoutMs?: number } = {}
  ): Promise<string> {
    const s = this.deps.settings()
    if (!s.autoTag.enabled || !text.trim()) return text
    const first = autoTag(text, this.vocab(), { ignore: this.ignore() }).text
    const slow = opts.fast ? null : this.suggest(first)
    if (!slow) {
      // Names after a verb cue still count without the model.
      const rules = findNewNames(first, this.vocab(), this.me(), {
        ignore: this.ignore(),
        kinds: this.kinds()
      })
        .filter((n) => !n.maybe) // a weak guess is never written for you at save time
        .map((n) => ({ text: n.text, kind: n.kind }))
      return rules.length ? this.tagNewThings(first, rules) : first
    }
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), opts.timeoutMs ?? 2500))
    const got = await Promise.race([slow, timeout])
    const sure = got?.tags.filter((t) => !t.maybe) ?? []
    return sure.length ? this.tagNewThings(first, sure) : first
  }
}
