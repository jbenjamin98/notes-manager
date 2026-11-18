import type { Db } from '../db'
import { isAutomatedSender } from './relevance'

/**
 * How much a mail thread matters to you, as a score with the reasons behind it. Pure and cheap:
 * it runs at read time over stored facts, so a changed weight or a new signal applies at once.
 *
 *   important (4+)  a real person who needs something from you, or something you starred
 *   maybe (2 to 4)  probably worth a look (an FYI from someone you know, a customer thread)
 *   noise (< 2)     bulk, automated, cc'd, old: hidden behind "Hidden"
 */
export type Level = 'important' | 'maybe' | 'noise'

export interface ImportanceFacts {
  starred: boolean
  unread: boolean
  iParticipated: boolean
  lastSenderIsMe: boolean
  senderEmail: string | null
  senderName: string | null
  subject: string
  snippet: string
  /** Hours since the last message. */
  ageHours: number
  /** Header-based signals; null when the source did not provide them (an older script). */
  toMe: boolean | null
  ccMe: boolean | null
  bulk: boolean | null
  importantLabel: boolean | null
  msgCount: number | null
}

export interface ImportanceCtx {
  /** Learned weight per sender: an exact address, or "@domain" (counted at half). */
  weights: Map<string, number>
  /** How many threads you have replied to from each address. */
  repliedTo: Map<string, number>
  /** A person you know (your lists, meeting guests). */
  knownPerson?: (name: string | null, email: string | null) => boolean
  /** Text that names one of your customers, systems or projects. */
  topic?: (text: string) => boolean
  /** Your names, to spot "Priya, can you..." */
  meAliases?: string[]
}

export interface Importance {
  score: number
  level: Level
  reasons: string[]
}

const ASKS =
  /\?|\b(please|can you|could you|would you|will you|let me know|need you|need your|your (input|approval|review|feedback)|action required|waiting (on|for) you|follow(ing)? up|reminder)\b/i
const DEADLINE =
  /\b(asap|urgent|today|tomorrow|tonight|by (monday|tuesday|wednesday|thursday|friday|eod|end of day|cob)|deadline|due)\b/i

export const LEVELS = { important: 4, maybe: 2 }

export const levelOf = (score: number): Level =>
  score >= LEVELS.important ? 'important' : score >= LEVELS.maybe ? 'maybe' : 'noise'

/** The weight that applies to a sender: their own address, plus half of their domain's. */
export function senderWeight(weights: Map<string, number>, email: string | null): number {
  if (!email) return 0
  const e = email.toLowerCase()
  const domain = e.split('@')[1]
  return (weights.get(e) ?? 0) + (domain ? (weights.get(`@${domain}`) ?? 0) * 0.5 : 0)
}

export function scoreThread(t: ImportanceFacts, ctx: ImportanceCtx): Importance {
  let score = 0
  const reasons: string[] = []
  const add = (n: number, why: string): void => {
    score += n
    reasons.push(why)
  }
  const text = `${t.subject} ${t.snippet}`

  if (t.starred) add(5, 'Starred')
  if (t.importantLabel) add(2, 'Gmail marks it important')
  if (t.toMe === true && t.ccMe !== true) add(2, 'Sent to you')
  if (t.ccMe === true && t.toMe !== true) add(-2, 'You are only copied')
  if (t.bulk) add(-6, 'Bulk mail')
  const automated = isAutomatedSender(t.senderEmail, t.senderName)
  if (automated) add(-5, 'Automated sender')
  // An older script gives no header facts: a person's mail is then worth a look, not hidden.
  if (t.toMe === null && t.bulk === null && !automated) add(2, 'From a person')

  const known = ctx.knownPerson?.(t.senderName, t.senderEmail) ?? false
  const replies = t.senderEmail ? (ctx.repliedTo.get(t.senderEmail.toLowerCase()) ?? 0) : 0
  if (known) add(3, 'Someone you know')
  else if (replies >= 2) add(3, 'You reply to them')
  if (ctx.topic?.(text)) add(2, 'About one of your customers or projects')
  const me = (ctx.meAliases ?? []).filter((a) => a.length >= 3)
  if (
    me.some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))
  )
    add(2, 'Mentions you')
  if (ASKS.test(t.snippet) || ASKS.test(t.subject)) add(2, 'Asks something')
  if (DEADLINE.test(text)) add(1, 'Has a deadline')
  if (t.unread) add(1, 'Unread')
  if (t.iParticipated && (t.msgCount ?? 0) >= 3) add(1, 'A real conversation')

  const learned = senderWeight(ctx.weights, t.senderEmail)
  if (learned !== 0)
    add(
      learned,
      learned > 0 ? 'You marked this sender important' : 'You marked this sender not important'
    )

  if (t.ageHours > 24 * 14) add(-2, 'Older than two weeks')
  else if (t.ageHours > 24 * 7) add(-1, 'Older than a week')

  return { score, level: levelOf(score), reasons }
}

// ------------------------------------------------------------------ learning

const clamp = (n: number): number => Math.max(-12, Math.min(12, n))

/** Change what one sender (and half of their domain) is worth. Returns the new weight of the address. */
export function adjustSender(db: Db, email: string, delta: number): number {
  const e = email.toLowerCase()
  const domain = e.split('@')[1]
  const bump = (key: string, d: number): number => {
    const cur =
      (
        db.prepare('SELECT weight FROM sender_weights WHERE key = ?').get(key) as
          { weight: number } | undefined
      )?.weight ?? 0
    const next = clamp(cur + d)
    db.prepare(
      `INSERT INTO sender_weights (key, weight, important_n, not_n, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET weight = excluded.weight,
         important_n = important_n + excluded.important_n, not_n = not_n + excluded.not_n,
         updated_at = CURRENT_TIMESTAMP`
    ).run(key, next, d > 0 ? 1 : 0, d < 0 ? 1 : 0)
    return next
  }
  const own = bump(e, delta)
  if (domain) bump(`@${domain}`, delta)
  return own
}

export function loadWeights(db: Db): Map<string, number> {
  const rows = db.prepare('SELECT key, weight FROM sender_weights').all() as unknown as {
    key: string
    weight: number
  }[]
  return new Map(rows.map((r) => [r.key, r.weight]))
}

export function loadRepliedTo(db: Db): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT lower(sender_email) AS e, COUNT(*) AS n FROM email_threads
        WHERE i_participated = 1 AND sender_email IS NOT NULL GROUP BY lower(sender_email)`
    )
    .all() as unknown as { e: string; n: number }[]
  return new Map(rows.map((r) => [r.e, r.n]))
}
