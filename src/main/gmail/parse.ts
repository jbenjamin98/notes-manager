/**
 * Pure helpers for scraped Gmail rows. The scraper hands over raw row data from the standard
 * UI; everything that decides what it MEANS lives here so it can be tested without a browser.
 * Only metadata is handled here (subject, sender, labels, time). Thread text is read elsewhere, in memory.
 */

export interface RawRow {
  /** data-legacy-thread-id (hex) if present. */
  legacyId: string | null
  /** data-thread-id, e.g. "#thread-f:1850..." */
  threadId: string | null
  senders: { name: string; email: string }[]
  subject: string
  snippet: string
  /** Full timestamp from the time cell's title, e.g. "Fri, Nov 13, 2026, 10:47 AM". */
  timeTitle: string
  unread: boolean
  starred: boolean
  /** Label chip names on the row (system "Inbox" included). */
  labels: string[]
}

export interface ThreadRecord {
  id: string
  linkId: string | null
  subject: string
  snippet: string
  senderName: string | null
  senderEmail: string | null
  lastSenderIsMe: boolean
  lastMessageAt: string | null
  unread: boolean
  starred: boolean
  labels: string[]
  /** The thread sits in the Inbox (shows an "Inbox" chip). */
  inInbox: boolean
  /** Any message in the thread is from me. */
  iParticipated: boolean
}

/** Built-in Gmail labels: never offered as user labels. */
const SYSTEM_LABELS = new Set(
  [
    'inbox',
    'sent',
    'sent mail',
    'drafts',
    'starred',
    'important',
    'spam',
    'trash',
    'unread',
    'chats',
    'snoozed',
    'scheduled',
    'all mail',
    'category personal',
    'primary',
    'social',
    'promotions',
    'updates',
    'forums'
  ].map((s) => s.toLowerCase())
)

export const isUserLabel = (name: string): boolean =>
  !!name.trim() && !SYSTEM_LABELS.has(name.trim().toLowerCase())

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Fri, Nov 13, 2026, 10:47 AM" -> "2026-11-13T10:47" (naive local). Null if unrecognised. */
export function parseGmailTime(title: string): string | null {
  const t = title.replace(/[\u202f\u00a0]/g, ' ')
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(t)
  if (!m) return null
  const month = MONTHS.indexOf(m[1].slice(0, 3))
  if (month < 0) return null
  let h = Number(m[4]) % 12
  if (m[6].toUpperCase() === 'PM') h += 12
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${m[3]}-${p(month + 1)}-${p(Number(m[2]))}T${p(h)}:${m[5]}`
}

/** Your address, from the page title: "Inbox (4) - you@example.com - Mail". */

/** User labels only, trimmed, de-duplicated case-insensitively (Gmail label names are). */
export function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of labels) {
    const l = raw.trim()
    if (!isUserLabel(l) || seen.has(l.toLowerCase())) continue
    seen.add(l.toLowerCase())
    out.push(l)
  }
  return out
}

export function normalizeRows(rows: RawRow[], selfEmail: string | null): ThreadRecord[] {
  const out: ThreadRecord[] = []
  for (const r of rows) {
    const id = r.legacyId || r.threadId?.replace(/^#/, '') || null
    if (!id || !r.subject.trim()) continue
    const isMe = (s: { name: string; email: string }): boolean =>
      s.name.trim().toLowerCase() === 'me' || (!!selfEmail && s.email.toLowerCase() === selfEmail)
    const last = r.senders[r.senders.length - 1]
    const other = [...r.senders].reverse().find((s) => !isMe(s))
    out.push({
      id,
      linkId: r.legacyId,
      subject: r.subject.trim(),
      snippet: r.snippet.replace(/^\s*-\s*/, '').trim(),
      senderName: other?.name || null,
      senderEmail: other?.email?.toLowerCase() || null,
      lastSenderIsMe: !!last && isMe(last),
      lastMessageAt: parseGmailTime(r.timeTitle),
      unread: r.unread,
      starred: r.starred,
      labels: uniqueLabels(r.labels),
      inInbox: r.labels.some((l) => l.trim().toLowerCase() === 'inbox'),
      iParticipated: r.senders.some(isMe)
    })
  }
  return out
}

// ----------------------------------------------------------------- suggestions

const PREFIX = /^\s*((re|fwd?|fw)\s*:\s*|\[(jira|external|ext)\]\s*)+/i

export function cleanSubject(subject: string): string {
  return subject.replace(PREFIX, '').replace(/\s+/g, ' ').trim()
}

const JIRA_KEY = /\(([A-Z][A-Z0-9]+-\d+)\)|\b([A-Z][A-Z0-9]+-\d+)\b/

/**
 * Deterministic task text for a thread (no LLM). Jira-style subjects keep their issue key:
 * "[JIRA] (PROJ-123) Fix login" -> "Jira PROJ-123: Fix login".
 */
export function suggestTaskText(t: {
  subject: string
  labels?: string[]
  /** I wrote last and they haven't answered. */
  unreplied?: boolean
  /** They wrote last and I haven't answered. */
  needsMyReply?: boolean
}): string {
  const clean = cleanSubject(t.subject)
  const key = JIRA_KEY.exec(clean)
  if (key) {
    const k = key[1] || key[2]
    const rest = clean
      .replace(JIRA_KEY, '')
      .replace(/^\W+|\W+$/g, '')
      .replace(/^\[?jira\]?\s*/i, '')
      .trim()
    return `Jira ${k}${rest ? `: ${rest}` : ''}`.slice(0, 140)
  }
  const verb = t.needsMyReply ? 'Reply' : t.unreplied ? 'Follow up' : 'Review'
  return `${verb}: ${clean}`.slice(0, 140)
}

/** Subject for an email follow-up draft. */
export const followUpSubject = (subject: string): string => `Re: ${cleanSubject(subject)}`

/** A pipe would break the inline task syntax (`desc | @owner | due:...`). */
export const sanitizeTaskText = (s: string): string =>
  s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
