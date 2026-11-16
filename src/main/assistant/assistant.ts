import { randomUUID } from 'node:crypto'
import { formatSources, gatherContext, nearestNotes, type Source } from './context'
import { addWaiting, listWaiting, ownerIsMe } from '../waiting/waiting'
import { eventsForDay } from '../calendar/sync'
import { runAgent, trailText, type AgentSource } from './agent'
import type { ToolDeps, ToolSource } from './tools'
import type { MailBody } from '../google/mailBody'
import { localRoute } from './local/router'
import { chatDigestText } from '../chat/digest'
import { quickSummary, renderQuickSummary, actionCandidates, quickFollowup } from './local/extract'
import { z } from 'zod'
import { EntitySuggestion } from '../../shared/contract'
import { suggestDuplicates } from '../entities/dedupe'
import type { Db } from '../db'
import type { TaskItem, Vault } from '../vault/vault'
import type { ChatMessage, Citation, Proposal } from '../../shared/contract'
import { parseQuickAdd } from '../../shared/quickadd'
import { LlmUnavailable, type JsonRequest, type JsonResult } from '../llm/router'
import { ANSWER_LENGTH } from './proposals'
import { classifyIntent } from './intent'
import { instantFromWall, todayIn, wallClock } from '../../shared/tz'
import {
  candidates,
  fresh,
  markAnnounced,
  pruneAnnounced,
  type Candidate,
  type MailAwait
} from './proactive'
import { fitContext, profileFor, type AiProfile } from '../../shared/aiProfile'
import { personaFor } from '../../shared/personas'
import {
  BriefOut,
  CatchUpOut,
  DayOut,
  EmailOut,
  LABEL,
  SummaryOut,
  SYSTEM,
  WeekOut,
  emailProposal,
  render,
  weekEmailBody,
  type ActionKind
} from './actions'
import {
  AskOut,
  askSystemPrompt,
  CaptureOut,
  type CaptureOut as CaptureOutT,
  captureSystemPrompt,
  mergeEdits,
  resolveCapture,
  resolveTask,
  type ResolveCtx
} from './proposals'

/** The slice of the LLM router the assistant needs (a fake in tests). */
export interface JsonGenerator {
  generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>>
}

export interface AssistantDeps {
  db: Db
  llm: JsonGenerator
  vault: () => Vault
  addReminder: (text: string, at: Date) => string
  getSettings: () => {
    meAliases: string[]
    timezone: string
    llm: { enabled: boolean; mode?: string }
    assistant?: { persona: string }
  }
  /** Write the missing @ and # into text that is about to be saved (cards, Waiting On lines). */
  tagText?: (text: string) => Promise<string>
  /** Read one email thread's text in memory (never stored). Only used when readMail() is true. */
  mailBodies?: (ids: string[]) => Promise<MailBody[]>
  readMail?: () => boolean
  /** Tell the window what the assistant is doing right now. */
  onProgress?: (label: string) => void
  /** Messages the assistant sends on its own. Missing in tests that do not use them. */
  proactive?: {
    enabled: () => boolean
    persona: () => string
    tasks: () => import('../vault/vault').TaskItem[]
    awaiting: () => MailAwait[]
    hours: () => { start: number; end: number; eod: number }
    onNew: (items: { message: ChatMessage; urgent: boolean }[]) => void
  }
  /** What the one-click actions read. Missing in tests that do not use them. */
  sources?: ActionSources
  /** Email address for a person's name, from mail already synced (or null). */
  guessEmail?: (name: string) => string | null
  /** Open a visible, pre-filled Gmail compose window. Never sends. */
  compose?: (d: { to?: string; subject: string; body: string }) => void
  now?: () => Date
  /** The settings time zone. Missing = the computer's clock (tests). */
  zone?: () => string | undefined
}

export interface ActionSources {
  note(path: string): Promise<{ title: string; date: string; body: string } | null>
  prep(eventId: string): { title: string; text: string } | null
  week(weekStart?: string): { label: string; weekStart: string; markdown: string }
  day(): { text: string }
  entity(id: string): { name: string; text: string } | null
}

export interface ActionRequest {
  kind: ActionKind
  path?: string
  eventId?: string
  weekStart?: string
  entityId?: string
  ephemeral?: boolean
  quick?: boolean
}

interface Row {
  id: string
  role: 'user' | 'assistant'
  content: string
  action_payload_json: string | null
  created_at: string
  trigger_type: string
  is_read: number
}

interface Payload {
  proposals: Proposal[]
  citations: Citation[]
  notice: string | null
  via: 'llm' | 'local' | null
  followups?: string[]
}

const HISTORY_LIMIT = 60

const ENTITY_AI = z.object({
  merges: z
    .array(z.object({ names: z.array(z.string()).min(2), reason: z.string().default('') }))
    .default([]),
  categories: z
    .array(
      z.object({
        name: z.string(),
        to: z.enum(['person', 'customer', 'project', 'system', 'place']),
        reason: z.string().default('')
      })
    )
    .default([])
})

const SCHEMA: Record<ActionKind, z.ZodType> = {
  'summarize-note': SummaryOut,
  'extract-actions': CaptureOut,
  'draft-followup': EmailOut,
  'prep-brief': BriefOut,
  'week-update': WeekOut,
  'day-brief': DayOut,
  'catch-up': CatchUpOut,
  'chat-digest': BriefOut
}

const plain = (notice: string | null): Payload => ({
  proposals: [],
  citations: [],
  notice,
  via: 'local'
})

export class Assistant {
  constructor(private deps: AssistantDeps) {}

  private now(): Date {
    return wallClock(this.deps.now?.() ?? new Date(), this.deps.zone?.())
  }

  /** Who is speaking: the persona's character sheet (a two-sentence version in Quick mode). */
  private tone(): string {
    const p = personaFor(this.deps.getSettings().assistant?.persona)
    return `
Write any text meant for the user (replies, summaries, headlines, notes to them) in this voice, while keeping every fact exact: ${this.profile().mode === 'light' ? p.voiceShort : p.voice}`
  }

  private profile(): AiProfile {
    return profileFor(this.deps.getSettings().llm.mode)
  }

  private ctx(): ResolveCtx {
    const v = this.deps.vault()
    const s = this.deps.getSettings()
    return {
      now: this.now(),
      people: v.personIndex(),
      meNames: new Set(['me', ...s.meAliases.map((a) => a.toLowerCase())]),
      knownAccounts: v.knownAccounts()
    }
  }

  private toMessage(r: Row): ChatMessage {
    const p: Partial<Payload> = r.action_payload_json
      ? (JSON.parse(r.action_payload_json) as Partial<Payload>)
      : {}
    return {
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      proposals: p.proposals ?? [],
      citations: p.citations ?? [],
      notice: p.notice ?? null,
      via: p.via ?? null,
      followups: p.followups ?? [],
      kind: (['brief', 'pre_meeting', 'overdue', 'nudge'].includes(r.trigger_type)
        ? r.trigger_type
        : 'chat') as ChatMessage['kind'],
      unread: r.is_read === 0
    }
  }

  private store(
    role: 'user' | 'assistant',
    content: string,
    payload?: Payload,
    trigger = 'chat',
    unread = false
  ): ChatMessage {
    const id = randomUUID()
    this.deps.db
      .prepare(
        `INSERT INTO assistant_messages (id, role, trigger_type, content, action_payload_json, is_read)
         VALUES (?,?, ?, ?, ?, ?)`
      )
      .run(id, role, trigger, content, payload ? JSON.stringify(payload) : null, unread ? 0 : 1)
    return this.get(id)!
  }

  private get(id: string): ChatMessage | null {
    const r = this.deps.db
      .prepare(
        `SELECT id, role, content, action_payload_json, created_at, trigger_type, is_read FROM assistant_messages WHERE id = ?`
      )
      .get(id) as unknown as Row | undefined
    return r ? this.toMessage(r) : null
  }

  history(): ChatMessage[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, role, content, action_payload_json, created_at, trigger_type, is_read FROM assistant_messages
          ORDER BY rowid DESC LIMIT ?`
      )
      .all(HISTORY_LIMIT) as unknown as Row[]
    return rows.reverse().map((r) => this.toMessage(r))
  }

  clear(): void {
    this.deps.db.exec('DELETE FROM assistant_messages')
  }

  unread(): number {
    return (
      this.deps.db
        .prepare('SELECT count(*) AS c FROM assistant_messages WHERE is_read = 0')
        .get() as {
        c: number
      }
    ).c
  }

  markRead(): void {
    this.deps.db.exec('UPDATE assistant_messages SET is_read = 1 WHERE is_read = 0')
  }

  /**
   * Things said before being asked (morning brief, a meeting about to start, overdue work, a reply
   * owed, the end-of-day wrap-up). Rules decide when; the persona's fixed phrases decide what, so this
   * costs no tokens. Each is announced once.
   */
  async proactiveTick(
    real: Date = new Date()
  ): Promise<{ message: ChatMessage; urgent: boolean }[]> {
    const p = this.deps.proactive
    if (!p || !p.enabled() || this.ticking) return []
    this.ticking = true
    try {
      return await this.proactiveRun(p, real)
    } finally {
      this.ticking = false
    }
  }

  private ticking = false

  /** The model writes the message in the persona's voice; the fixed phrase is the fallback. */
  private async compose(c: Candidate, persona: string, today: string): Promise<string> {
    const s = this.deps.getSettings()
    if (!s.llm.enabled) return c.body
    const key = `pro.composed.${today}`
    const n = Number(
      (
        this.deps.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
          { value: string } | undefined
      )?.value ?? 0
    )
    if (n >= 12) return c.body // a small daily cap on these automatic calls
    this.deps.db
      .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
      .run(key, String(n + 1))
    try {
      const p = personaFor(persona)
      const res = await this.deps.llm.generateJson({
        tier: 'extract',
        feature: 'proactive',
        system: [
          p.voice,
          '',
          'You are the user’s work assistant and you are messaging them unprompted, in a small chat window.',
          `Purpose: ${c.purpose}`,
          'Write 1 to 3 short sentences in your own voice, built only from the facts given. Be specific (names, titles, times) and say what you would do first. No greeting boilerplate, no headings, no lists, never invent anything.',
          'Reply with ONLY a JSON object: {"message": string}.'
        ].join('\n'),
        user: `Facts:\n${c.facts}`,
        schema: z.object({ message: z.string() }),
        maxOut: 260,
        repair: false,
        cacheKey: `pro:${c.key}:${persona}`,
        cacheTtlMs: 3 * 3600_000
      })
      const m = res.data.message.trim()
      return m.length >= 8 ? m : c.body
    } catch {
      return c.body
    }
  }

  private async proactiveRun(
    p: NonNullable<AssistantDeps['proactive']>,
    real: Date
  ): Promise<{ message: ChatMessage; urgent: boolean }[]> {
    const wall = wallClock(this.deps.now?.() ?? real, this.deps.zone?.())
    const h = p.hours()
    const list = fresh(
      this.deps.db,
      candidates({
        now: wall,
        db: this.deps.db,
        persona: p.persona(),
        tasks: p.tasks(),
        awaitingMe: p.awaiting(),
        workStartMin: h.start,
        workEndMin: h.end,
        eodMin: h.eod
      })
    )
    const out: { message: ChatMessage; urgent: boolean }[] = []
    for (const c of list) {
      markAnnounced(this.deps.db, c, real)
      const body = await this.compose(
        c,
        p.persona(),
        `${wall.getFullYear()}-${wall.getMonth() + 1}-${wall.getDate()}`
      )
      const message = this.store(
        'assistant',
        body,
        {
          proposals: [],
          citations: [],
          notice: null,
          via: body === c.body ? 'local' : 'llm',
          followups: c.chips
        },
        c.trigger,
        true
      )
      out.push({ message, urgent: c.urgent })
    }
    if (out.length) {
      pruneAnnounced(this.deps.db)
      p.onNew(out)
    }
    return out
  }

  async send(
    text: string,
    mode: 'auto' | 'ask' | 'capture' = 'auto',
    quiet = false
  ): Promise<ChatMessage[]> {
    const t = text.trim()
    const user = quiet ? null : this.store('user', t)
    const out = (reply: ChatMessage): ChatMessage[] => (user ? [user, reply] : [reply])
    // Only an explicit "/note" (or the "turn this into tasks" button) goes straight to capture.
    const cap = /^\/(note|capture|add)\s+/i.exec(t)
    if (mode === 'capture' || cap)
      return out(await this.capture(cap ? t.slice(cap[0].length).trim() : t))
    const ask = /^\/ask\s+/i.exec(t)
    const question = ask ? t.slice(ask[0].length).trim() : t
    // Everything else is a conversation: the assistant decides what you meant.
    return out(await this.converse(question))
  }

  // ------------------------------------------------------------------------------- converse

  private digest(tasks: TaskItem[], today: string): string {
    const mine = tasks.filter((t) => t.isMine && t.status === 'open')
    const overdue = mine.filter((t) => t.due !== null && t.due < today).length
    const dueToday = mine.filter((t) => t.due === today).length
    const now = this.now()
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const meetings = eventsForDay(this.deps.db, today)
    const next = meetings.find((m) => m.start > hm)
    const waiting = ((): number => {
      try {
        return listWaiting(this.deps.db).length
      } catch {
        return 0
      }
    })()
    return [
      `it is ${hm}`,
      `${mine.length} open tasks (${overdue} overdue, ${dueToday} due today)`,
      `${meetings.length} meeting${meetings.length === 1 ? '' : 's'} today${next ? ` (next: ${next.title} at ${next.start})` : ''}`,
      `${waiting} thing${waiting === 1 ? '' : 's'} other people owe you`
    ].join('; ')
  }

  /**
   * Talk to the assistant. It decides whether you are asking, chatting or dumping to-dos, looks
   * things up when it needs to (agent.ts), and answers in its persona's voice. If AI is not
   * available the older rule-based answers are used instead.
   */
  private async converse(question: string): Promise<ChatMessage> {
    const prof = this.profile()
    const now = this.deps.now?.() ?? new Date()
    const today = todayIn(this.deps.zone?.(), now)
    let tasks: TaskItem[]
    try {
      tasks = this.deps.vault().listTasks()
    } catch {
      tasks = []
    }
    const settings = this.deps.getSettings()
    const persona = personaFor(settings.assistant?.persona)
    const chars = Math.round(prof.contextChars / 2)
    const seed: ToolSource[] = gatherContext(this.deps.db, question, {
      tasks,
      today,
      budget: {
        notes: prof.retrieveK,
        noteChars: prof.snippetChars,
        extraChars: Math.round(prof.contextChars / 2)
      }
    }).map((s) => ({
      kind: s.kind === 'entity' ? ('person' as const) : s.kind,
      label: s.label,
      text: s.text,
      path: s.path,
      title: s.title,
      date: s.date,
      heading: s.heading
    }))
    const tools: ToolDeps = {
      db: this.deps.db,
      vault: this.deps.vault,
      today,
      me: settings.meAliases,
      chars,
      mailBodies: this.deps.mailBodies,
      readMail: this.deps.readMail ?? (() => false)
    }
    const r = await runAgent(
      this.deps.llm,
      tools,
      {
        question,
        history: this.recentTurns(prof.historyTurns, question),
        voice: prof.mode === 'light' ? persona.voiceShort : persona.voice,
        today,
        me: settings.meAliases,
        digest: this.digest(tasks, today),
        seed,
        maxSteps: prof.agentSteps,
        tier: prof.askTier,
        maxOut: prof.maxOut,
        repair: prof.repair,
        length: ANSWER_LENGTH[prof.mode] ?? ANSWER_LENGTH.normal,
        followups: prof.followups
      },
      (label) => this.deps.onProgress?.(label)
    )
    const citeOf = (x: AgentSource): Citation | null =>
      x.path ? { n: x.n, path: x.path, title: x.title, date: x.date, heading: x.heading } : null
    if (r.ok) {
      const used = (r.cited.length ? r.cited : []).map((n) => r.sources[n - 1]).filter(Boolean)
      const offer = r.offer ? [`${r.offer.label}::capture:`] : []
      return this.store('assistant', r.answer, {
        proposals: [],
        citations: uniqueCites(used.map(citeOf)),
        notice: trailText(r.trail),
        via: 'llm',
        followups: [...offer, ...r.followups]
      })
    }
    // The AI could not be reached at all: fall back to the rule-based answers.
    if (r.first || r.sources.length === 0) return this.legacy(question, r.error)
    // It got part way (for example Google slowed us down): say what was found.
    return this.store('assistant', localSummary(r.sources), {
      proposals: [],
      citations: uniqueCites(r.sources.map(citeOf)),
      notice: failureNotice(r.error),
      via: 'local'
    })
  }

  /** The original rule-based behaviour: used only when the AI cannot be used. */
  private async legacy(text: string, err: unknown): Promise<ChatMessage> {
    const picked = classifyIntent(text)
    const msg =
      picked.intent === 'ask' ? await this.ask(picked.text) : await this.capture(picked.text)
    if (msg.via === 'local' && !msg.notice) return this.setNotice(msg, failureNotice(err))
    return msg
  }

  private setNotice(msg: ChatMessage, notice: string): ChatMessage {
    const p: Payload = {
      proposals: msg.proposals,
      citations: msg.citations,
      notice,
      via: msg.via,
      followups: msg.followups
    }
    this.deps.db
      .prepare('UPDATE assistant_messages SET action_payload_json = ? WHERE id = ?')
      .run(JSON.stringify(p), msg.id)
    return this.get(msg.id)!
  }

  // ---------------------------------------------------------------------------------- capture

  private async capture(text: string): Promise<ChatMessage> {
    const ctx = this.ctx()
    try {
      const tz = this.deps.getSettings().timezone
      const prof = this.profile()
      const res = await this.deps.llm.generateJson({
        tier: prof.actionTier,
        feature: 'capture',
        system: captureSystemPrompt(ctx, tz),
        user: text.slice(0, Math.min(6000, prof.contextChars)),
        schema: CaptureOut,
        maxOut: prof.maxOut,
        repair: prof.repair
      })
      const proposals = resolveCapture(res.data, ctx)
      const content =
        proposals.length === 0
          ? res.data.reply || 'I did not find anything to capture in that.'
          : res.data.reply ||
            `I found ${proposals.length} thing${proposals.length === 1 ? '' : 's'} to review.`
      return this.store('assistant', content, {
        proposals,
        citations: [],
        notice: null,
        via: 'llm'
      })
    } catch (err) {
      const proposals = this.localCapture(text, ctx)
      return this.store(
        'assistant',
        'The AI could not be used, so here is a plain parse you can check.',
        {
          proposals,
          citations: [],
          notice: failureNotice(err),
          via: 'local'
        }
      )
    }
  }

  /** No AI: each line becomes a task, parsed by the same rules as quick-add. */
  private localCapture(text: string, ctx: ResolveCtx): Proposal[] {
    return text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '').trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((line) => {
        const q = parseQuickAdd(line, ctx.now)
        return resolveTask(
          {
            description: q.description,
            owner: q.ownerExplicit ? q.owner : null,
            due: q.due,
            priority: q.priority,
            est_minutes: q.estMinutes
          },
          ctx
        )
      })
      .filter((p) => p.description)
  }

  // -------------------------------------------------------------------------------------- ask

  /** The last few exchanges, so "and what about Sarah?" makes sense. */
  private recentTurns(turns: number, exclude: string): string {
    if (turns <= 0) return ''
    const rows = this.deps.db
      .prepare(
        `SELECT role, content FROM assistant_messages WHERE trigger_type = 'chat' ORDER BY rowid DESC LIMIT ?`
      )
      .all(turns * 2 + 1) as unknown as { role: string; content: string }[]
    return rows
      .reverse()
      .filter((r) => r.content !== exclude)
      .slice(-turns * 2)
      .map((r) => `${r.role === 'user' ? 'User' : 'Assistant'}: ${r.content.slice(0, 300)}`)
      .join('\n')
  }

  private async ask(question: string): Promise<ChatMessage> {
    const prof = this.profile()
    // "What's due today?" is a lookup, not a question for a language model: answer it for free.
    if (
      this.deps.sources &&
      /^(what('?s| is| do i have)|show me|list)\b.*\b(due|overdue|on my plate)\b/i.test(
        question.trim()
      )
    ) {
      return this.store('assistant', this.deps.sources.day().text, {
        proposals: [],
        citations: [],
        notice: 'Answered on your computer. No AI used.',
        via: 'local'
      })
    }
    const lookup = localRoute(this.deps.db, question, this.deps.now?.() ?? new Date())
    if (lookup)
      return this.store('assistant', lookup.text, {
        proposals: [],
        citations: [],
        notice: 'Answered on your computer. No AI used.',
        via: 'local'
      })
    // Everything relevant: notes, your tasks, meetings, Waiting On, insights, people named.
    const now = this.deps.now?.() ?? new Date()
    const today = todayIn(this.deps.zone?.(), now)
    let tasks: TaskItem[]
    try {
      tasks = this.deps.vault().listTasks()
    } catch {
      tasks = []
    }
    const sources = gatherContext(this.deps.db, question, {
      tasks,
      today,
      budget: {
        notes: prof.retrieveK,
        noteChars: prof.snippetChars,
        extraChars: Math.round(prof.contextChars / 2)
      }
    })
    if (sources.length === 0)
      return this.store('assistant', nothingFound(this.deps.db, question), {
        proposals: [],
        citations: [],
        notice: 'Nothing matched in your notes, tasks, calendar or inbox.',
        via: 'local'
      })
    const citeOf = (x: Source): Citation | null =>
      x.path ? { n: x.n, path: x.path, title: x.title, date: x.date, heading: x.heading } : null
    const local = (why: string | null): ChatMessage =>
      this.store('assistant', localSummary(sources), {
        proposals: [],
        citations: uniqueCites(sources.map(citeOf)),
        notice: why,
        via: 'local'
      })

    try {
      const history = this.recentTurns(prof.historyTurns, question)
      const res = await this.deps.llm.generateJson({
        tier: prof.askTier,
        feature: 'ask',
        system: askSystemPrompt(prof.followups, prof.mode) + this.tone(),
        user:
          (history ? 'Earlier in this chat:\n' + history + '\n\n' : '') +
          'Today is ' +
          today +
          '.\nQuestion: ' +
          question +
          '\n\nSources:\n' +
          formatSources(sources),
        schema: AskOut,
        maxOut: prof.maxOut,
        repair: prof.repair,
        cacheKey:
          sources.map((x) => x.chunkId ?? x.kind + x.text.length).join(',') +
          '|' +
          prof.mode +
          '|' +
          history.length
      })
      const cited = res.data.cited.filter((n) => n >= 1 && n <= sources.length)
      const used = (cited.length ? cited : sources.map((x) => x.n)).map((n) => sources[n - 1])
      return this.store('assistant', res.data.answer, {
        proposals: [],
        // Cited sources that are not notes (a meeting, a task) still point at the notes used.
        citations: uniqueCites(
          used.map(citeOf).some(Boolean)
            ? used.map(citeOf)
            : sources
                .filter((x) => x.kind === 'note')
                .slice(0, 3)
                .map(citeOf)
        ),
        notice: null,
        via: 'llm',
        followups: prof.followups ? res.data.followups.slice(0, 3) : []
      })
    } catch (err) {
      return local(failureNotice(err))
    }
  }

  // ----------------------------------------------------------------------------- entity helper

  /**
   * Suggest merges and recategorisations. Only names, categories, nicknames and note counts are sent
   * (never note text). Falls back to the
   * built-in rules when no AI is available.
   */
  async suggestEntities(): Promise<{
    suggestions: z.infer<typeof EntitySuggestion>[]
    via: 'llm' | 'local'
    notice: string | null
  }> {
    const v = this.deps.vault()
    const all = v.manageList()
    const local = (
      notice: string | null
    ): {
      suggestions: z.infer<typeof EntitySuggestion>[]
      via: 'local'
      notice: string | null
    } => ({
      suggestions: suggestDuplicates(
        all.map((e) => ({
          category: e.category,
          name: e.name,
          aliases: e.aliases,
          notes: e.notes
        })),
        v.currentRegistry()
      ).map((d) => ({
        kind: 'merge' as const,
        category: d.category as never,
        names: d.names,
        to: null,
        reason: d.reason,
        score: d.score,
        ambiguous: d.ambiguous
      })),
      via: 'local',
      notice
    })
    const send = all.slice(0, 160)
    if (send.length < 2) return local(null)
    const prof = this.profile()
    const lines = send
      .map(
        (e) =>
          `${e.name} | ${e.category} | ${e.notes} notes${e.aliases.length ? ' | also: ' + e.aliases.join(', ') : ''}`
      )
      .join('\n')
    try {
      const res = await this.deps.llm.generateJson({
        tier: prof.actionTier,
        feature: 'names',
        system:
          'You clean up a list of people, companies, projects, systems and places taken from someone\'s meeting notes. Reply with ONLY JSON: {"merges":[{"names":[canonical, other, ...],"reason":string}],"categories":[{"name":string,"to":"person"|"customer"|"project"|"system"|"place","reason":string}]}. ' +
          'Suggest a merge only when names clearly refer to the same thing (nicknames, initials, spelling, a company with and without a prefix). A bare first name that could be several people must NOT be merged: leave it out. "customer" means a company. Suggest a category change only when the current one is clearly wrong. Use ONLY names from the list. At most 12 of each.',
        user: lines,
        schema: ENTITY_AI,
        maxOut: prof.maxOut,
        repair: prof.repair,
        cacheKey: 'entities:' + send.length,
        cacheTtlMs: 6 * 3600_000
      })
      const byName = new Map(all.map((e) => [e.name.toLowerCase(), e]))
      const out: z.infer<typeof EntitySuggestion>[] = []
      for (const m of res.data.merges.slice(0, 12)) {
        const found = m.names
          .map((n) => byName.get(n.toLowerCase()))
          .filter((e): e is NonNullable<typeof e> => !!e)
        const cats = new Set(found.map((e) => e.category))
        if (found.length < 2 || cats.size !== 1) continue
        out.push({
          kind: 'merge',
          category: found[0].category,
          names: found.map((e) => e.name),
          to: null,
          reason: m.reason,
          score: 0.85,
          ambiguous: false
        })
      }
      for (const c of res.data.categories.slice(0, 12)) {
        const e = byName.get(c.name.toLowerCase())
        if (!e || e.category === c.to) continue
        out.push({
          kind: 'category',
          category: e.category,
          names: [e.name],
          to: c.to,
          reason: c.reason,
          score: 0.8,
          ambiguous: false
        })
      }
      return { suggestions: out, via: 'llm', notice: null }
    } catch (err) {
      return local(failureNotice(err))
    }
  }

  // ------------------------------------------------------------------------------------ actions

  /**
   * One-click actions on the note, meeting, week or person the user is looking at. The context is
   * assembled locally and trimmed to the mode's budget; the answer comes back as text plus approve-first cards.
   */
  async runAction(a: ActionRequest): Promise<ChatMessage[]> {
    const src = this.deps.sources
    // Ephemeral exchanges (the automatic Home brief) are returned but never saved to the chat history.
    const put = (role: 'user' | 'assistant', content: string, payload?: Payload): ChatMessage =>
      a.ephemeral
        ? {
            id: randomUUID(),
            role,
            content,
            createdAt: new Date().toISOString(),
            proposals: payload?.proposals ?? [],
            citations: payload?.citations ?? [],
            notice: payload?.notice ?? null,
            via: payload?.via ?? null,
            followups: payload?.followups ?? [],
            kind: 'chat',
            unread: false
          }
        : this.store(role, content, payload)
    const prof = this.profile()
    if (!src) throw new Error('Actions are not available yet.')

    // 1. Gather the context locally.
    let title = ''
    let text: string
    let weekFacts: { markdown: string; label: string } | null = null
    if (
      a.kind === 'summarize-note' ||
      a.kind === 'extract-actions' ||
      a.kind === 'draft-followup'
    ) {
      const n = a.path ? await src.note(a.path) : null
      if (!n) return [put('assistant', 'That note is no longer available.', plain(null))]
      title = n.title
      text = `${n.title} (${n.date})\n\n${n.body}`
    } else if (a.kind === 'prep-brief') {
      const p = a.eventId ? src.prep(a.eventId) : null
      if (!p) return [put('assistant', 'That meeting is no longer on your calendar.', plain(null))]
      title = p.title
      text = p.text
    } else if (a.kind === 'week-update') {
      const w = src.week(a.weekStart)
      title = w.label
      text = w.markdown
      weekFacts = { markdown: w.markdown, label: w.label }
    } else if (a.kind === 'day-brief') {
      text = src.day().text
    } else if (a.kind === 'chat-digest') {
      const d = chatDigestText(this.deps.db, this.deps.now?.() ?? new Date())
      if (!d)
        return [
          put('user', LABEL[a.kind]('')),
          put('assistant', 'Nothing in Chat needs you right now.', plain(null))
        ]
      text = d
    } else {
      const e = a.entityId ? src.entity(a.entityId) : null
      if (!e) return [put('assistant', 'That item is no longer in your notes.', plain(null))]
      title = e.name
      text = e.text
    }
    const user = put('user', LABEL[a.kind](title))

    // Quick (free): answer from rules on this computer. Falls through to the AI when rules can't.
    if (a.quick) {
      const q = this.quickAction(a.kind, title, text, weekFacts)
      if (q)
        return [
          user,
          put('assistant', q.content, {
            proposals: q.proposals,
            citations: [],
            notice: 'Quick answer on your computer. No AI used.',
            via: 'local'
          })
        ]
    }

    // 2. Ask the model, within the mode's budget.
    try {
      const res = await this.deps.llm.generateJson({
        tier: prof.actionTier,
        feature: 'action:' + a.kind,
        system: SYSTEM[a.kind] + this.tone(),
        user: fitContext(text, prof.contextChars),
        schema: SCHEMA[a.kind],
        maxOut: prof.maxOut,
        repair: prof.repair,
        cacheKey: 'action:' + a.kind + ':' + prof.mode,
        cacheTtlMs: 6 * 3600_000
      })
      return [user, put('assistant', ...this.fromModel(a, res.data, weekFacts))]
    } catch (err) {
      const local = this.localAction(a.kind, text, weekFacts)
      return [
        user,
        put(
          'assistant',
          local?.content ??
            'The AI is needed for this one. Add a key in Settings, or try again in a minute.',
          {
            proposals: local?.proposals ?? [],
            citations: [],
            notice: failureNotice(err),
            via: 'local'
          }
        )
      ]
    }
  }

  private fromModel(
    a: ActionRequest,
    data: unknown,
    week: { markdown: string; label: string } | null
  ): [string, Payload] {
    const ok = (content: string, proposals: Proposal[] = []): [string, Payload] => [
      content,
      { proposals, citations: [], notice: null, via: 'llm' }
    ]
    switch (a.kind) {
      case 'summarize-note':
        return ok(render.summary(data as never))
      case 'prep-brief':
      case 'chat-digest':
        return ok(render.brief(data as never))
      case 'day-brief':
        return ok(render.day(data as never))
      case 'catch-up':
        return ok(render.catchUp(data as never))
      case 'extract-actions': {
        const ctx = this.ctx()
        const tasks = resolveCapture({ ...(data as CaptureOutT), notes: [], reminders: [] }, ctx)
        return ok(
          tasks.length
            ? `I found ${tasks.length} action item${tasks.length === 1 ? '' : 's'} not yet on a checkbox. Add the ones you want.`
            : 'I did not find any action items that are not already in the note.',
          tasks
        )
      }
      case 'draft-followup': {
        const d = data as z.infer<typeof EmailOut>
        const to = d.recipient_name ? (this.deps.guessEmail?.(d.recipient_name) ?? null) : null
        return ok('Here is a draft. Edit it, then open it in Gmail to review and send yourself.', [
          emailProposal(to, d.subject, d.body)
        ])
      }
      default: {
        const w = data as z.infer<typeof WeekOut>
        return ok(render.week(w), [
          emailProposal(null, `Weekly update: ${week?.label ?? ''}`, weekEmailBody(w))
        ])
      }
    }
  }

  /** What can still be done with no AI at all. */
  /** Rule-based versions of the one-click actions: select and arrange what is already in the text. */
  private quickAction(
    kind: ActionKind,
    title: string,
    text: string,
    week: { markdown: string; label: string } | null
  ): { content: string; proposals: Proposal[] } | null {
    if (kind === 'summarize-note') {
      const s = quickSummary(text)
      return s ? { content: renderQuickSummary(s), proposals: [] } : null
    }
    if (kind === 'extract-actions') {
      const cands = actionCandidates(text)
      if (cands.length === 0) return null
      const proposals = this.localCapture(cands.join('\n'), this.ctx())
      return {
        content: `I found ${proposals.length} possible action item${proposals.length === 1 ? '' : 's'}. Check them before adding.`,
        proposals
      }
    }
    if (kind === 'draft-followup') {
      const s = quickSummary(text)
      if (!s || (!s.decisions.length && !s.nextSteps.length)) return null
      const f = quickFollowup(title, s)
      return {
        content: `${f.subject}

${f.body}`,
        proposals: [emailProposal(null, f.subject, f.body)]
      }
    }
    // The meeting brief, catch-up and day plan are already assembled from your notes, tasks and calendar.
    return (
      this.localAction(kind, text, week) ??
      (kind === 'prep-brief' || kind === 'catch-up' || kind === 'chat-digest'
        ? { content: text, proposals: [] }
        : null)
    )
  }

  private localAction(
    kind: ActionKind,
    text: string,
    week: { markdown: string; label: string } | null
  ): { content: string; proposals: Proposal[] } | null {
    if (kind === 'week-update' && week)
      return {
        content: week.markdown,
        proposals: [emailProposal(null, `Weekly update: ${week.label}`, week.markdown)]
      }
    if (kind === 'day-brief') return { content: text, proposals: [] }
    return null
  }

  // -------------------------------------------------------------------------------- proposals

  async apply(
    messageId: string,
    index: number,
    edits?: Record<string, unknown>
  ): Promise<ChatMessage> {
    const msg = this.get(messageId)
    const p = msg?.proposals[index]
    if (!msg || !p) throw new Error('That suggestion is no longer available.')
    if (p.status !== 'pending') return msg
    const ctx = this.ctx()
    const final = mergeEdits(p, edits, ctx)
    const vault = this.deps.vault()
    let applied: Proposal
    if (final.kind === 'task' && !ownerIsMe(final.owner, this.deps.getSettings().meAliases)) {
      // Someone else's action is not your task: keep it as a Waiting On note line.
      const r = await addWaiting(
        this.deps.db,
        vault,
        {
          who: final.owner,
          text: (await this.deps.tagText?.(final.description)) ?? final.description,
          due: final.due
        },
        ctx.now
      )
      applied = { ...final, status: 'applied', appliedPath: r.path }
    } else if (final.kind === 'task') {
      const r = await vault.appendInboxTask(
        {
          description: (await this.deps.tagText?.(final.description)) ?? final.description,
          owner: final.owner,
          due: final.due,
          priority: final.priority,
          estMinutes: final.estMinutes,
          ownerExplicit: final.ownerExplicit
        },
        ctx.now
      )
      applied = { ...final, status: 'applied', appliedPath: r.path }
    } else if (final.kind === 'note') {
      const path = await vault.createNote({
        kind: final.noteKind,
        title: final.title,
        date: final.date,
        account: final.account ?? undefined,
        body: (await this.deps.tagText?.(final.body)) ?? final.body
      })
      applied = { ...final, status: 'applied', appliedPath: path }
    } else if (final.kind === 'email') {
      if (!this.deps.compose) throw new Error('Email drafting is not available.')
      // Opens a visible, pre-filled compose window. The user reads it and presses Send themselves.
      this.deps.compose({ to: final.to ?? undefined, subject: final.subject, body: final.body })
      applied = { ...final, status: 'applied' }
    } else {
      if (!final.at) throw new Error('Pick a time for the reminder first.')
      // The card's time is wall-clock time in the settings zone; store the real instant.
      const when = instantFromWall(new Date(final.at), this.deps.zone?.())
      const realNow = this.deps.zone?.() ? new Date() : ctx.now
      if (Number.isNaN(when.getTime()) || when.getTime() <= realNow.getTime()) {
        throw new Error('Pick a time in the future.')
      }
      this.deps.addReminder(final.text, when)
      applied = { ...final, status: 'applied' }
    }
    return this.setProposal(msg, index, applied)
  }

  dismiss(messageId: string, index: number): ChatMessage {
    const msg = this.get(messageId)
    const p = msg?.proposals[index]
    if (!msg || !p) throw new Error('That suggestion is no longer available.')
    if (p.status !== 'pending') return msg
    return this.setProposal(msg, index, { ...p, status: 'dismissed' })
  }

  private setProposal(msg: ChatMessage, index: number, p: Proposal): ChatMessage {
    const proposals = msg.proposals.map((x, i) => (i === index ? p : x))
    const payload: Payload = {
      proposals,
      citations: msg.citations,
      notice: msg.notice,
      via: msg.via
    }
    this.deps.db
      .prepare('UPDATE assistant_messages SET action_payload_json = ? WHERE id = ?')
      .run(JSON.stringify(payload), msg.id)
    return this.get(msg.id)!
  }
}

/** Citations that point at notes, one per note. */
function uniqueCites(list: (Citation | null)[]): Citation[] {
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const c of list) {
    if (!c || seen.has(c.path)) continue
    seen.add(c.path)
    out.push(c)
  }
  return out
}

interface LocalSource {
  n: number
  kind: string
  label: string
  text: string
}

/** Without AI: the sources themselves, grouped and readable. */
function localSummary(sources: LocalSource[]): string {
  const by = (k: string): LocalSource[] => sources.filter((x) => x.kind === k)
  const out: string[] = []
  const notes = by('note').slice(0, 4)
  if (notes.length)
    out.push(
      'From your notes:\n' +
        notes
          .map((x) => '[' + x.n + '] ' + x.label + ': ' + x.text.replace(/\s+/g, ' ').slice(0, 220))
          .join('\n')
    )
  const tasks = by('task')
  if (tasks.length)
    out.push('Your tasks:\n' + tasks.map((x) => '- ' + x.text + ' (' + x.label + ')').join('\n'))
  const meetings = by('meeting')
  if (meetings.length)
    out.push(
      'Meetings:\n' +
        meetings.map((x) => '- ' + x.label.replace('Meeting · ', '') + ': ' + x.text).join('\n')
    )
  const waiting = by('waiting')
  if (waiting.length)
    out.push('Waiting on others:\n' + waiting.map((x) => '- ' + x.label + ': ' + x.text).join('\n'))
  const more = [...by('insight'), ...by('entity')]
  if (more.length)
    out.push('Also relevant:\n' + more.map((x) => '- ' + x.label + ': ' + x.text).join('\n'))
  return out.join('\n\n')
}

/** Nothing matched: say so, then point somewhere useful instead of ending the conversation. */
function nothingFound(db: Db, question: string): string {
  const near = nearestNotes(db, question)
  const lines = ["I couldn't find anything about that in your notes, tasks, calendar or inbox."]
  if (near.length)
    lines.push(
      'The closest notes by title are:\n' +
        near.map((x) => '- ' + x.title + ' (' + x.date + ')').join('\n')
    )
  lines.push(
    'Try a person, project or meeting name ("What did we decide with Acme?"), or ask "What is on my plate today?".'
  )
  return lines.join('\n\n')
}

function failureNotice(err: unknown): string {
  if (err instanceof LlmUnavailable) {
    if (err.reason === 'disabled')
      return 'AI is turned off in Settings, so this was done on your computer.'
    if (err.reason === 'no-key')
      return 'No AI key yet (Settings), so this was done on your computer.'
    if (err.reason === 'busy') return 'The AI is busy right now, so this was done on your computer.'
    if (err.reason === 'budget') return err.message
  }
  return 'The AI did not answer, so this was done on your computer.'
}
