/**
 * What deserves to be BROUGHT IN from the user's mail. Decided at read time from stored facts,
 * so changing a label handler or muting a sender applies instantly with no re-crawl.
 *
 * Principle: mail you deliberately routed (a label you made, a star, a reply you wrote) is a
 * signal; mail that merely arrived (bulk, automated, archived unseen) is noise.
 */

export type LabelHandler = 'ignore' | 'info' | 'tasks'

export interface RelevanceFacts {
  starred: boolean
  labels: string[]
  iParticipated: boolean
  inInbox: boolean
  subject: string
  senderEmail: string | null
  senderName: string | null
}

export interface RelevanceCtx {
  handlerOf: (label: string) => LabelHandler
  mutedEmails: Set<string>
  /** lowercase, without "@" */
  mutedDomains: Set<string>
}

/** 'label' = a label set to Tasks; 'counted' = only labels set to Counts (shown as a number, never listed). */
export type KeepReason = 'starred' | 'label' | 'counted' | 'mine' | 'inbox'
export type DropReason = 'muted' | 'ignored-label' | 'calendar' | 'automated' | 'archived'
export type Verdict = { keep: true; reason: KeepReason } | { keep: false; reason: DropReason }

/** Calendar responses/invitations and auto-replies: never worth a follow-up. */
const CALENDAR_NOISE =
  /^\s*(accepted|declined|tentatively accepted|invitation|updated invitation|invitation from google calendar|canceled event|cancelled event|automatic reply)\s*[:@]/i

export const isCalendarNoise = (subject: string): boolean => CALENDAR_NOISE.test(subject)

const AUTOMATED_LOCAL =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|noreply|notifications?|alerts?|mailer-daemon|postmaster|bounces?|automated|auto[-_.]?(reply|mail|confirm)|system|daemon|newsletter|news|updates?|digest|donotreply|reply)([-_.+=].*)?$/i
const BULK_SUBDOMAIN =
  /^(mail|email|e|em|news|newsletter|updates|marketing|campaign|bounce|mg|send|msg)\./i

export function isAutomatedSender(email: string | null, name: string | null): boolean {
  if (!email) return false
  const [local, domain = ''] = email.toLowerCase().split('@')
  if (AUTOMATED_LOCAL.test(local)) return true
  if (BULK_SUBDOMAIN.test(domain)) return true
  return /\b(no-?reply|do not reply|notifications?)\b/i.test(name ?? '')
}

export function isMuted(email: string | null, ctx: RelevanceCtx): boolean {
  if (!email) return false
  const e = email.toLowerCase()
  const domain = e.split('@')[1] ?? ''
  if (ctx.mutedEmails.has(e)) return true
  // "x.com" also mutes mail.x.com and every other subdomain.
  for (const d of ctx.mutedDomains) if (domain === d || domain.endsWith(`.${d}`)) return true
  return false
}

export function classify(t: RelevanceFacts, ctx: RelevanceCtx): Verdict {
  if (t.starred) return { keep: true, reason: 'starred' }
  if (isMuted(t.senderEmail, ctx)) return { keep: false, reason: 'muted' }
  if (t.labels.length > 0) {
    const handlers = t.labels.map(ctx.handlerOf)
    if (handlers.every((h) => h === 'ignore')) return { keep: false, reason: 'ignored-label' }
    return { keep: true, reason: handlers.some((h) => h === 'tasks') ? 'label' : 'counted' }
  }
  if (isCalendarNoise(t.subject)) return { keep: false, reason: 'calendar' }
  if (t.iParticipated) return { keep: true, reason: 'mine' }
  if (isAutomatedSender(t.senderEmail, t.senderName)) return { keep: false, reason: 'automated' }
  if (t.inInbox) return { keep: true, reason: 'inbox' }
  return { keep: false, reason: 'archived' }
}

/** Normalise user input: "Joe@X.com" -> "joe@x.com"; "https://x.com" / "@x.com" / "x.com" -> "@x.com". */
export function normalizeMute(input: string): string | null {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  if (!s) return null
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s
  const domain = s.replace(/^@/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? `@${domain}` : null
}
