import type { Db } from '../db'
import type { MailBody } from '../google/mailBody'
import { cleanEmail } from './clean'
import { readSource, type PipelineDeps } from './pipeline'
import { worthwhileThreadIds } from '../gmail/sync'
import { alreadyRead, markRead } from './store'
import type { Utterance } from './types'

/** Machine-sent mail has nothing to act on. */
export const AUTOMATED =
  /(no-?reply|do-?not-?reply|notifications?@|newsletter|mailer-daemon|automated|alerts?@|jira@|digest@|@.*\.(?:atlassian|slack|zoom|calendar)\b|calendar-notification)/i

export interface MailCandidate {
  id: string
  subject: string
  lastAt: string
}

/**
 * Which threads are worth reading in full: recent, written by a person, and either unread, starred
 * or waiting on me. Bounded per run, and a thread is only read again when a new message arrives.
 */
export function mailCandidates(db: Db, limit = 25, allow?: Set<string>): MailCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, subject, sender_email AS email, last_message_at AS lastAt, last_sender_is_me AS mine, unread, starred
         FROM email_threads
        WHERE last_message_at >= date('now','-4 days') AND in_sent = 0 OR (starred = 1 AND last_message_at >= date('now','-14 days'))
        ORDER BY last_message_at DESC LIMIT 200`
    )
    .all() as unknown as {
    id: string
    subject: string
    email: string | null
    lastAt: string | null
    mine: number
    unread: number
    starred: number
  }[]
  const out: MailCandidate[] = []
  for (const r of rows) {
    if (!r.lastAt || (r.email && AUTOMATED.test(r.email))) continue
    // Muted, dismissed, bulk and unimportant mail is never read by the model.
    if (allow && !allow.has(r.id)) continue
    if (!(r.unread || r.starred || !r.mine)) continue
    if (alreadyRead(db, `emailseen:${r.id}`, r.lastAt)) continue
    out.push({ id: r.id, subject: r.subject, lastAt: r.lastAt })
    if (out.length >= limit) break
  }
  return out
}

const shortDay = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/**
 * Read candidate threads in full, in memory: keep the insights, a short snippet and the ids, never
 * the message text. Returns how many new insights were found.
 */
export async function insightsFromMail(
  deps: PipelineDeps,
  fetchBodies: (ids: string[]) => Promise<MailBody[]>,
  selfEmail: string | null
): Promise<number> {
  const cands = mailCandidates(
    deps.db,
    25,
    worthwhileThreadIds(deps.db, {}, { meAliases: deps.me() })
  )
  if (cands.length === 0) return 0
  const threads = await fetchBodies(cands.map((c) => c.id))
  const byId = new Map(cands.map((c) => [c.id, c]))
  let n = 0
  for (const t of threads) {
    const cand = byId.get(t.threadId) ?? cands.find((c) => c.id.includes(t.threadId))
    const us: Utterance[] = t.messages
      .map((m) => ({
        who: m.from,
        text: cleanEmail(m.text),
        fromMe: !!selfEmail && m.fromEmail.toLowerCase() === selfEmail.toLowerCase()
      }))
      .filter((u) => u.text.length >= 12)
    const last = t.messages[t.messages.length - 1]
    if (us.length > 0 && last) {
      const added = await readSource(
        deps,
        `email:${t.threadId}`,
        {
          type: 'email',
          ref: { threadId: cand?.id ?? t.threadId },
          label: `Email · ${t.subject.slice(0, 50)} · ${shortDay(last.at)}`,
          at: last.at
        },
        us
      )
      n += added.length
    }
    if (cand) markRead(deps.db, `emailseen:${cand.id}`, cand.lastAt)
  }
  return n
}
