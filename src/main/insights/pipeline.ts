import { createHash } from 'node:crypto'
import type { Db } from '../db'
import type { JsonGenerator } from '../assistant/assistant'
import { groupRows, type ChatRow } from '../chat/triage'
import { cleanChat, cleanEmail, cleanNotes } from './clean'
import { extractFromUtterances, gateForModel } from './extract'
import { extractWithModel } from './model'
import { alreadyRead, markRead, saveInsights, similarity, type InsightRow } from './store'
import type { Candidate, ExtractCtx, SourceInfo, Utterance } from './types'

export interface PipelineDeps {
  db: Db
  /** The small model, when one is set up and allowed. Rules alone are used without it. */
  llm: JsonGenerator | null
  me: () => string[]
  now?: () => Date
  /**
   * False when the AI has little room left (nearly out of budget, rate-limited): reading is then
   * postponed, not downgraded, so a source gets the model's answer later instead of rules only.
   */
  headroom?: () => boolean
  /** How many model reads this run may still start (spreads a big backlog over several runs). */
  modelRuns?: { left: number }
  /** Filled in by the pipeline: sources postponed this run. */
  stats?: { deferred: number }
}

const sha = (s: string): string => createHash('sha1').update(s).digest('hex')
const shortDay = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Model answers first; rules fill in only what the model missed with high confidence. */
export function mergeCandidates(model: Candidate[], rules: Candidate[]): Candidate[] {
  const out = [...model]
  for (const r of rules) {
    if (r.confidence < 0.7) continue
    if (out.some((m) => similarity(m.text, r.text) >= 0.5)) continue
    out.push(r)
  }
  return out
}

/** Read one source: rules always, the model when it can help; save what is new. */
export async function readSource(
  deps: PipelineDeps,
  key: string,
  src: SourceInfo,
  us: Utterance[]
): Promise<InsightRow[]> {
  const now = deps.now?.() ?? new Date()
  const hash = sha(JSON.stringify(us))
  if (alreadyRead(deps.db, key, hash)) return []
  const ctx: ExtractCtx = { now, me: deps.me(), source: src.type === 'note' ? 'meeting' : src.type }
  const rules = extractFromUtterances(us, ctx, src.type === 'chat' || us.length > 1)
  let found = rules
  const gated = gateForModel(us, ctx)
  if (deps.llm && gated.length > 40) {
    // Wait rather than settle for rules only: nothing is saved or marked read, so it is retried.
    if ((deps.headroom && !deps.headroom()) || (deps.modelRuns && deps.modelRuns.left <= 0)) {
      if (deps.stats) deps.stats.deferred++
      return []
    }
    if (deps.modelRuns) deps.modelRuns.left--
    try {
      const viaModel = await extractWithModel(deps.llm, gated, ctx, hash)
      found = mergeCandidates(viaModel, rules)
    } catch {
      found = rules // no key, over budget or a bad answer: the free path still works
    }
  }
  const added = saveInsights(deps.db, src, found)
  markRead(deps.db, key, hash)
  return added
}

/** Conversations from the last couple of weeks that changed since they were last read. */
export async function insightsFromChat(deps: PipelineDeps): Promise<number> {
  const rows = deps.db
    .prepare(
      `SELECT id, space, space_name, space_type, sender, sender_id, text, created_at, thread, from_me, mentions_me, has_question
         FROM chat_messages WHERE created_at > datetime('now','-14 days')
          AND space NOT IN (SELECT space FROM chat_spaces WHERE mode = 'ignore')
        ORDER BY created_at`
    )
    .all() as unknown as ChatRow[]
  let n = 0
  for (const [key, msgs] of groupRows(rows)) {
    const last = msgs[msgs.length - 1]
    const other = msgs.find((m) => !m.from_me)
    const title = last.space_type === 'dm' && other ? other.sender : last.space_name
    const us: Utterance[] = msgs.map((m) => ({
      who: m.from_me ? 'Me' : m.sender,
      text: cleanChat(m.text),
      fromMe: !!m.from_me
    }))
    const at = last.created_at.includes('T')
      ? last.created_at
      : last.created_at.replace(' ', 'T') + 'Z'
    const added = await readSource(
      deps,
      `chat:${key}`,
      {
        type: 'chat',
        ref: { space: last.space, conversation: key, lastMessageId: last.id },
        label: `Chat · ${title} · ${shortDay(at)}`,
        at
      },
      us
    )
    n += added.length
  }
  return n
}

/** A meeting's notes (Gemini or your own): what was decided, who does what, what is open. */
export async function insightsFromMeeting(
  deps: PipelineDeps,
  m: {
    eventId: string | null
    title: string
    date: string
    text: string
    notePath: string | null
    fileId: string | null
  }
): Promise<number> {
  const added = await readSource(
    deps,
    `meeting:${m.fileId ?? m.eventId ?? m.notePath ?? m.title}`,
    {
      type: 'meeting',
      ref: { eventId: m.eventId, notePath: m.notePath, fileId: m.fileId },
      label: `Meeting · ${m.title} · ${shortDay(m.date)}`,
      at: m.date.length === 10 ? `${m.date}T12:00:00Z` : m.date
    },
    [{ who: '', text: cleanNotes(m.text), fromMe: false }]
  )
  return added.length
}

/** An email thread body (read in memory, never stored): asks, commitments, decisions. */
export async function insightsFromEmail(
  deps: PipelineDeps,
  m: { threadId: string; subject: string; at: string; from: string; body: string }
): Promise<number> {
  const text = cleanEmail(m.body)
  if (text.length < 20) return 0
  const added = await readSource(
    deps,
    `email:${m.threadId}`,
    {
      type: 'email',
      ref: { threadId: m.threadId },
      label: `Email · ${m.subject.slice(0, 50)} · ${shortDay(m.at)}`,
      at: m.at
    },
    [{ who: m.from, text, fromMe: false }]
  )
  return added.length
}
