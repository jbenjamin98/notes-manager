import type { Db } from '../db'

/**
 * Chat triage: which conversations need you, which are waiting on someone else, and what is noise.
 * Entirely deterministic and explainable (every score is a sum of named reasons), so it costs no
 * AI tokens and can be corrected: thumbs up/down nudge the per-reason weights, stored locally.
 */
export type Bucket = 'needs-you' | 'waiting' | 'fyi' | 'noise'

export type Reason =
  | 'dm'
  | 'mention'
  | 'reply-to-me'
  | 'question'
  | 'deadline'
  | 'topic'
  | 'frequent'
  | 'recent'
  | 'unanswered'

export const REASON_LABEL: Record<Reason, string> = {
  dm: 'Direct message',
  mention: 'Mentions you',
  'reply-to-me': 'Reply in your thread',
  question: 'Asks a question',
  deadline: 'Has a deadline',
  topic: 'About something you track',
  frequent: 'Someone you talk to often',
  recent: 'Recent',
  unanswered: 'Waiting for your reply'
}

export const DEFAULT_WEIGHTS: Record<Reason, number> = {
  dm: 3,
  mention: 3,
  'reply-to-me': 3,
  question: 2,
  deadline: 2,
  topic: 1.5,
  frequent: 1,
  recent: 1,
  unanswered: 1
}

export interface ChatRow {
  id: string
  space: string
  space_name: string
  space_type: string
  sender: string
  sender_id: string | null
  text: string
  created_at: string
  thread: string | null
  from_me: number
  mentions_me: number
  has_question: number
}

export interface Conversation {
  key: string
  space: string
  spaceName: string
  spaceType: string
  title: string
  lastAt: string
  lastText: string
  lastSender: string
  lastFromMe: boolean
  messages: number
  score: number
  reasons: Reason[]
  bucket: Bucket
  /** Hours since the last message. */
  ageHours: number
  /** Hours I have left someone's message unanswered (0 when I answered or it needs no answer). */
  awaitingMeHours: number
  /** Hours since my question/request got no reply (0 when not waiting). */
  awaitingThemHours: number
}

export interface Commitment {
  convKey: string
  space: string
  spaceName: string
  text: string
  at: string
}

export interface TriageOptions {
  now?: Date
  /** Does this text mention something the user tracks (a project, company, person)? */
  topicHit?: (text: string) => boolean
  /** Hours before an unanswered message counts as overdue. */
  awaitingMeAfter?: number
  awaitingThemAfter?: number
}

const DEADLINE =
  /\b(by (eod|end of (day|week)|tomorrow|monday|tuesday|wednesday|thursday|friday|\d{1,2}(:\d{2})?\s*(am|pm)?)|asap|urgent|today|tonight|deadline|due (today|tomorrow|friday|monday))\b/i
const ASK = /\b(can|could|would|will) you\b|\bplease\b|\bneed (you|your)\b|\blet me know\b/i
const COMMIT =
  /\b(i('| wi)ll (send|share|check|look|get back|follow up|update|review|set up|schedule|find out|have)|let me (check|look|find|get)|will do|on it|i can take (that|this))\b/i

const GAP_HOURS = 6

function toMs(s: string): number {
  return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
}

/** DMs and group chats have no threads: split them into conversations at long silences. */
export function groupRows(rows: ChatRow[]): Map<string, ChatRow[]> {
  const sorted = [...rows].sort((a, b) => toMs(a.created_at) - toMs(b.created_at))
  const out = new Map<string, ChatRow[]>()
  const lastIn = new Map<string, { key: string; at: number }>()
  for (const r of sorted) {
    let key: string
    if (r.thread && r.space_type === 'space') key = `${r.space}|${r.thread}`
    else {
      const prev = lastIn.get(r.space)
      const at = toMs(r.created_at)
      key =
        prev && at - prev.at < GAP_HOURS * 3_600_000
          ? prev.key
          : `${r.space}|${r.thread ?? 'w' + at}`
      lastIn.set(r.space, { key, at })
    }
    const list = out.get(key)
    if (list) list.push(r)
    else out.set(key, [r])
  }
  return out
}

export function loadWeights(db: Db): Record<Reason, number> {
  const w = { ...DEFAULT_WEIGHTS }
  for (const r of db.prepare('SELECT feature, weight FROM chat_weights').all() as {
    feature: string
    weight: number
  }[])
    if (r.feature in w) w[r.feature as Reason] = r.weight
  return w
}

export function triageRows(
  rows: ChatRow[],
  weights: Record<Reason, number>,
  frequent: Set<string>,
  opts: TriageOptions = {}
): { conversations: Conversation[]; commitments: Commitment[] } {
  const now = (opts.now ?? new Date()).getTime()
  const meAfter = opts.awaitingMeAfter ?? 2
  const themAfter = opts.awaitingThemAfter ?? 8
  const conversations: Conversation[] = []
  const commitments: Commitment[] = []

  for (const [key, msgs] of groupRows(rows)) {
    const last = msgs[msgs.length - 1]
    const lastMs = toMs(last.created_at)
    const ageHours = Math.max(0, (now - lastMs) / 3_600_000)
    const theirs = msgs.filter((m) => !m.from_me)
    const mine = msgs.filter((m) => m.from_me)
    const reasons = new Set<Reason>()

    if (last.space_type === 'dm' && theirs.length) reasons.add('dm')
    if (theirs.some((m) => m.mentions_me)) reasons.add('mention')
    if (mine.length && theirs.some((m) => toMs(m.created_at) > toMs(mine[0].created_at)))
      reasons.add('reply-to-me')
    const lastTheirs = theirs[theirs.length - 1]
    if (lastTheirs && (lastTheirs.has_question || ASK.test(lastTheirs.text)))
      reasons.add('question')
    if (theirs.some((m) => DEADLINE.test(m.text))) reasons.add('deadline')
    if (opts.topicHit && msgs.some((m) => opts.topicHit!(m.text))) reasons.add('topic')
    if (theirs.some((m) => frequent.has(m.sender_id ?? m.sender))) reasons.add('frequent')
    if (ageHours < 24) reasons.add('recent')

    // Waiting on me: their message is last, and it is aimed at me.
    const aimed =
      last.space_type === 'dm' ||
      reasons.has('mention') ||
      (reasons.has('reply-to-me') && !last.from_me)
    let awaitingMeHours = 0
    if (
      !last.from_me &&
      aimed &&
      (reasons.has('question') || last.space_type === 'dm') &&
      ageHours >= meAfter
    )
      awaitingMeHours = ageHours
    if (awaitingMeHours) reasons.add('unanswered')

    // Waiting on them: my message was last and asked something.
    let awaitingThemHours = 0
    if (last.from_me && (last.has_question || ASK.test(last.text)) && ageHours >= themAfter)
      awaitingThemHours = ageHours

    for (const m of mine)
      if (COMMIT.test(m.text))
        commitments.push({
          convKey: key,
          space: m.space,
          spaceName: m.space_name,
          text: m.text,
          at: m.created_at
        })

    let score = 0
    for (const r of reasons) score += weights[r]
    if (last.from_me && !awaitingThemHours) score = Math.min(score, 1)

    const bucket: Bucket = awaitingThemHours
      ? 'waiting'
      : awaitingMeHours || (!last.from_me && score >= 5)
        ? 'needs-you'
        : score >= 3
          ? 'fyi'
          : 'noise'

    conversations.push({
      key,
      space: last.space,
      spaceName: last.space_name,
      spaceType: last.space_type,
      title:
        last.space_type === 'dm' && theirs.length
          ? theirs[theirs.length - 1].sender
          : last.space_name,
      lastAt: last.created_at,
      lastText: last.text,
      lastSender: last.sender,
      lastFromMe: !!last.from_me,
      messages: msgs.length,
      score: Math.round(score * 10) / 10,
      reasons: [...reasons],
      bucket,
      ageHours: Math.round(ageHours * 10) / 10,
      awaitingMeHours: Math.round(awaitingMeHours * 10) / 10,
      awaitingThemHours: Math.round(awaitingThemHours * 10) / 10
    })
  }
  conversations.sort((a, b) => b.score - a.score || toMs(b.lastAt) - toMs(a.lastAt))
  return { conversations, commitments }
}

/** People I answer often count as important: sender ids I have replied after at least 3 times. */
export function frequentSenders(rows: ChatRow[]): Set<string> {
  const count = new Map<string, number>()
  const sorted = [...rows].sort((a, b) => toMs(a.created_at) - toMs(b.created_at))
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1]
    const m = sorted[i]
    if (m.from_me && !p.from_me && p.space === m.space) {
      const k = p.sender_id ?? p.sender
      count.set(k, (count.get(k) ?? 0) + 1)
    }
  }
  return new Set([...count].filter(([, n]) => n >= 3).map(([k]) => k))
}

export function triage(
  db: Db,
  opts: TriageOptions = {}
): { conversations: Conversation[]; commitments: Commitment[] } {
  const rows = db
    .prepare(
      `SELECT id, space, space_name, space_type, sender, sender_id, text, created_at, thread, from_me, mentions_me, has_question
       FROM chat_messages WHERE created_at > datetime('now','-14 days') ORDER BY created_at`
    )
    .all() as unknown as ChatRow[]
  const ignored = new Set(
    (
      db.prepare("SELECT space FROM chat_spaces WHERE mode = 'ignore'").all() as { space: string }[]
    ).map((r) => r.space)
  )
  const live = rows.filter((r) => !ignored.has(r.space))
  return triageRows(live, loadWeights(db), frequentSenders(rows), opts)
}

/** Thumbs up/down on a conversation: nudge the weight of every reason that surfaced it. */
export function recordFeedback(
  db: Db,
  convKey: string,
  reasons: Reason[],
  relevant: boolean
): void {
  const w = loadWeights(db)
  const up = db.prepare(
    'INSERT INTO chat_weights (feature, weight) VALUES (?, ?) ON CONFLICT(feature) DO UPDATE SET weight = excluded.weight'
  )
  db.exec('BEGIN')
  try {
    for (const r of reasons) {
      const next = Math.min(6, Math.max(0.2, w[r] + (relevant ? 0.25 : -0.25)))
      up.run(r, Math.round(next * 100) / 100)
    }
    db.prepare(
      `INSERT INTO chat_feedback (conv_key, relevant, reasons, created_at) VALUES (?,?,?,datetime('now'))
       ON CONFLICT(conv_key) DO UPDATE SET relevant = excluded.relevant, reasons = excluded.reasons`
    ).run(convKey, relevant ? 1 : 0, JSON.stringify(reasons))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** "Something I track": curated customers, systems and projects named in the text (whole words). */
export function topicMatcher(db: Db): (text: string) => boolean {
  const names = (
    db
      .prepare(
        "SELECT name FROM entities WHERE in_registry = 1 AND category IN ('customer','system','project') AND length(name) >= 3"
      )
      .all() as { name: string }[]
  ).map((r) => r.name.toLowerCase())
  return (text) => {
    const t = text.toLowerCase()
    return names.some((n) => {
      const i = t.indexOf(n)
      return i >= 0 && !/\w/.test(t[i - 1] ?? ' ') && !/\w/.test(t[i + n.length] ?? ' ')
    })
  }
}
