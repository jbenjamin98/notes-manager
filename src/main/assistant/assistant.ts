import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import type { Vault } from '../vault/vault'
import type { ChatMessage, Citation, Proposal } from '../../shared/contract'
import { parseQuickAdd } from '../../shared/quickadd'
import { LlmUnavailable, type JsonRequest, type JsonResult } from '../llm/router'
import { classifyIntent, mentionsCui, redact } from './intent'
import { retrieve, type Hit } from './retrieve'
import {
  AskOut,
  ASK_SYSTEM_PROMPT,
  CaptureOut,
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
    llm: { enabled: boolean; blockCui: boolean }
  }
  now?: () => Date
}

interface Row {
  id: string
  role: 'user' | 'assistant'
  content: string
  action_payload_json: string | null
  created_at: string
}

interface Payload {
  proposals: Proposal[]
  citations: Citation[]
  notice: string | null
  via: 'llm' | 'local' | null
}

const HISTORY_LIMIT = 60

export class Assistant {
  constructor(private deps: AssistantDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
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
      via: p.via ?? null
    }
  }

  private store(role: 'user' | 'assistant', content: string, payload?: Payload): ChatMessage {
    const id = randomUUID()
    this.deps.db
      .prepare(
        `INSERT INTO assistant_messages (id, role, trigger_type, content, action_payload_json, is_read)
         VALUES (?,?, 'chat', ?, ?, 1)`
      )
      .run(id, role, content, payload ? JSON.stringify(payload) : null)
    return this.get(id)!
  }

  private get(id: string): ChatMessage | null {
    const r = this.deps.db
      .prepare(
        `SELECT id, role, content, action_payload_json, created_at FROM assistant_messages WHERE id = ? AND trigger_type = 'chat'`
      )
      .get(id) as unknown as Row | undefined
    return r ? this.toMessage(r) : null
  }

  history(): ChatMessage[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, role, content, action_payload_json, created_at FROM assistant_messages
          WHERE trigger_type = 'chat' ORDER BY rowid DESC LIMIT ?`
      )
      .all(HISTORY_LIMIT) as unknown as Row[]
    return rows.reverse().map((r) => this.toMessage(r))
  }

  clear(): void {
    this.deps.db.exec("DELETE FROM assistant_messages WHERE trigger_type = 'chat'")
  }

  async send(text: string, mode: 'auto' | 'ask' | 'capture' = 'auto'): Promise<ChatMessage[]> {
    const picked =
      mode === 'auto'
        ? classifyIntent(text)
        : { intent: mode, text: classifyIntent(`/${mode === 'ask' ? 'ask' : 'note'} ${text}`).text }
    const user = this.store('user', text.trim())
    const cfg = this.deps.getSettings().llm
    const cui = cfg.blockCui && mentionsCui(picked.text)
    const reply =
      picked.intent === 'ask'
        ? await this.ask(picked.text, cui)
        : await this.capture(picked.text, cui)
    return [user, reply]
  }

  // ---------------------------------------------------------------------------------- capture

  private async capture(text: string, cui: boolean): Promise<ChatMessage> {
    const ctx = this.ctx()
    if (cui) {
      return this.store(
        'assistant',
        'This mentions CUI, so it was not sent to any AI. Here is a plain parse you can check.',
        {
          proposals: this.localCapture(text, ctx),
          citations: [],
          notice: 'Kept on this computer: CUI is never sent to an AI service.',
          via: 'local'
        }
      )
    }
    try {
      const tz = this.deps.getSettings().timezone
      const res = await this.deps.llm.generateJson({
        tier: 'extract',
        system: captureSystemPrompt(ctx, tz),
        user: redact(text).slice(0, 6000),
        schema: CaptureOut
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

  private async ask(question: string, cui: boolean): Promise<ChatMessage> {
    const hits = retrieve(this.deps.db, question, 6)
    if (hits.length === 0) {
      return this.store('assistant', 'I could not find anything about that in your notes.', {
        proposals: [],
        citations: [],
        notice: null,
        via: 'local'
      })
    }
    const sendable = hits.filter((h) => !h.blocked)
    const withheld = hits.length - sendable.length
    const local = (why: string | null): ChatMessage =>
      this.store('assistant', localAnswer(hits), {
        proposals: [],
        citations: hits.map(cite),
        notice: why,
        via: 'local'
      })

    if (cui) return local('Kept on this computer: CUI is never sent to an AI service.')
    if (sendable.length === 0)
      return local('These notes are marked CUI, so they were not sent to an AI service.')

    try {
      const snippets = sendable
        .map(
          (h, i) =>
            `[${i + 1}] ${h.title} (${h.date})${h.heading ? ' - ' + h.heading : ''}\n${redact(h.text)}`
        )
        .join('\n\n')
      const res = await this.deps.llm.generateJson({
        tier: 'chat',
        system: ASK_SYSTEM_PROMPT,
        user: `Question: ${redact(question)}\n\nSnippets:\n${snippets}`,
        schema: AskOut,
        cacheKey: sendable.map((h) => h.chunkId).join(',')
      })
      const cited = res.data.cited.filter((n) => n >= 1 && n <= sendable.length)
      const used = (cited.length ? cited : sendable.map((_, i) => i + 1)).map(
        (n) => sendable[n - 1]
      )
      return this.store('assistant', res.data.answer, {
        proposals: [],
        citations: used.map((h, i) => ({ ...cite(h), n: sendable.indexOf(h) + 1 || i + 1 })),
        notice: withheld
          ? `${withheld} CUI note${withheld === 1 ? ' was' : 's were'} not sent to the AI.`
          : null,
        via: 'llm'
      })
    } catch (err) {
      return local(failureNotice(err))
    }
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
    if (final.kind === 'task') {
      const r = await vault.appendInboxTask(
        {
          description: final.description,
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
        body: final.body
      })
      applied = { ...final, status: 'applied', appliedPath: path }
    } else {
      if (!final.at) throw new Error('Pick a time for the reminder first.')
      const when = new Date(final.at)
      if (Number.isNaN(when.getTime()) || when.getTime() <= ctx.now.getTime()) {
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

const cite = (h: Hit): Citation => ({
  n: h.n,
  path: h.path,
  title: h.title,
  date: h.date,
  heading: h.heading
})

function localAnswer(hits: Hit[]): string {
  const lines = hits.slice(0, 4).map((h) => {
    const text = h.text.replace(/\s+/g, ' ').slice(0, 220)
    return `[${h.n}] ${h.title} (${h.date}): ${text}`
  })
  return `Closest matches in your notes:\n${lines.join('\n')}`
}

function failureNotice(err: unknown): string {
  if (err instanceof LlmUnavailable) {
    if (err.reason === 'disabled')
      return 'AI is turned off in Settings, so this was done on your computer.'
    if (err.reason === 'no-key')
      return 'No AI key yet (Settings), so this was done on your computer.'
    if (err.reason === 'busy') return 'The AI is busy right now, so this was done on your computer.'
  }
  return 'The AI did not answer, so this was done on your computer.'
}
