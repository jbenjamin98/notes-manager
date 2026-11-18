import type { Db } from '../db'
import {
  normalizeRows,
  suggestTaskText,
  uniqueLabels,
  type RawRow,
  type ThreadRecord
} from './parse'
import {
  classify,
  isPersonThread,
  normalizeMute,
  type DropReason,
  type KeepReason,
  type LabelHandler,
  type RelevanceCtx,
  type RelevanceFacts
} from './relevance'
import {
  loadRepliedTo,
  loadWeights,
  scoreThread,
  type Importance,
  type ImportanceCtx
} from './importance'

export type { LabelHandler } from './relevance'

/** What a crawl returns. `rows` is All Mail (minus bulk categories), newest first, de-duplicated. */
export interface GmailScrape {
  signedIn: boolean
  selfEmail: string | null
  rows: RawRow[]
  /** Starred conversations (they may be older than the crawl window). */
  starred: RawRow[]
  pages: number
  /** True if the crawl reached the cutoff date; false if it stopped at the page cap. */
  reachedCutoff: boolean
  /** Gmail's history position after this read (sources that support incremental reads). */
  historyId?: string | null
  /** The source could not continue from our history position: do a full read instead. */
  resync?: boolean
  /** Google slowed us down part way: these rows are what was read so far (keep them, finish later). */
  rateLimited?: boolean
  /** Only what changed since `sinceHistoryId` was returned (an empty list is normal). */
  incremental?: boolean
}

export interface CrawlOptions {
  days: number
  maxPages: number
  /** Read only what changed since this history position (when the source supports it). */
  sinceHistoryId?: string | null
}

export type GmailState = 'idle' | 'syncing' | 'needs-auth' | 'error'

export interface GmailStatus {
  state: GmailState
  lastSyncAt: string | null
  error: string | null
  /** Conversations stored locally (before relevance filtering). */
  threads: number
  health: 'ok' | 'degraded'
  healthDetail: string | null
  /** Last crawl: conversations read, pages visited, and whether it covered the whole window. */
  lastRead: number
  lastPages: number
  partial: boolean
  lastFull: boolean
}

export interface ThreadItem {
  id: string
  linkId: string | null
  subject: string
  snippet: string
  senderName: string | null
  senderEmail: string | null
  lastMessageAt: string | null
  unread: boolean
  starred: boolean
  labels: string[]
  taskAdded: boolean
  taskText: string
  score?: number
  level?: 'important' | 'maybe' | 'noise'
  reasons?: string[]
}

export interface LabelGroup {
  label: string
  unread: number
  total: number
  threads: ThreadItem[]
}

export interface MailStats {
  stored: number
  kept: number
  dropped: Partial<Record<DropReason, number>>
  keptBy: Partial<Record<KeepReason, number>>
}

export interface GmailOverview {
  /** Mail from people where they wrote last and it's still in your inbox (top 15). */
  awaitingMe: ThreadItem[]
  awaitingMeTotal: number
  /** Looks unimportant (bulk, copied, old): kept out of the way. */
  hidden: ThreadItem[]
  hiddenTotal: number
  /** Threads where YOU wrote last and 2+ days have passed. */
  needsReply: ThreadItem[]
  starred: ThreadItem[]
  groups: LabelGroup[]
  info: { label: string; unread: number; total: number }[]
  /** Items that want attention: used for the sidebar badge. */
  attention: number
  stats: MailStats
}

export interface LabelInfo {
  name: string
  seen: number
  handler: LabelHandler
}

const kvGet = (db: Db, key: string): string | null =>
  (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value ?? null
const kvSet = (db: Db, key: string, value: string): void => {
  db.prepare(
    'INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value)
}

/** Local mail older than this (by message date) is dropped, unless starred. */
const RETENTION_DAYS = 100

// ------------------------------------------------------------------ mutes

export const listMutes = (db: Db): string[] =>
  (
    db.prepare('SELECT pattern FROM email_mutes ORDER BY pattern').all() as unknown as {
      pattern: string
    }[]
  ).map((r) => r.pattern)

export function addMute(db: Db, input: string): string | null {
  const p = normalizeMute(input)
  if (!p) return null
  db.prepare('INSERT OR IGNORE INTO email_mutes (pattern) VALUES (?)').run(p)
  return p
}

export const removeMute = (db: Db, pattern: string): void => {
  db.prepare('DELETE FROM email_mutes WHERE pattern = ?').run(pattern)
}

function relevanceCtx(db: Db, handlers: Record<string, LabelHandler>): RelevanceCtx {
  const mutes = listMutes(db)
  return {
    handlerOf: (label) => handlerFor(handlers, label),
    mutedEmails: new Set(mutes.filter((m) => !m.startsWith('@'))),
    mutedDomains: new Set(mutes.filter((m) => m.startsWith('@')).map((m) => m.slice(1)))
  }
}

// ------------------------------------------------------------------ storage

/**
 * Merge a crawl into `email_threads`. Everything is stored (it's metadata); what to SHOW is decided
 * at read time. Starred state is rebuilt from the starred search, which is complete (< 1 page).
 */
export function applyThreads(db: Db, rows: ThreadRecord[], starred: ThreadRecord[]): void {
  db.exec('BEGIN')
  try {
    const up = db.prepare(
      `INSERT INTO email_threads (id,link_id,subject,snippet,sender_name,sender_email,last_sender_is_me,
                                  last_message_at,unread,starred,labels_json,in_inbox,i_participated,
                                  to_me,cc_me,bulk,important_label,msg_count,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET link_id=COALESCE(excluded.link_id, link_id), subject=excluded.subject,
         snippet=excluded.snippet, sender_name=COALESCE(excluded.sender_name, sender_name),
         sender_email=COALESCE(excluded.sender_email, sender_email),
         last_sender_is_me=excluded.last_sender_is_me,
         last_message_at=COALESCE(excluded.last_message_at, last_message_at),
         unread=excluded.unread, starred=excluded.starred, labels_json=excluded.labels_json,
         in_inbox=excluded.in_inbox, i_participated=excluded.i_participated,
         to_me=COALESCE(excluded.to_me, to_me), cc_me=COALESCE(excluded.cc_me, cc_me),
         bulk=COALESCE(excluded.bulk, bulk), important_label=COALESCE(excluded.important_label, important_label),
         msg_count=COALESCE(excluded.msg_count, msg_count), fetched_at=CURRENT_TIMESTAMP`
    )
    const all = new Map<string, ThreadRecord>()
    for (const t of [...rows, ...starred])
      all.set(t.id, { ...t, starred: t.starred || starred.some((s) => s.id === t.id) })
    for (const t of all.values()) {
      up.run(
        t.id,
        t.linkId,
        t.subject,
        t.snippet,
        t.senderName,
        t.senderEmail,
        t.lastSenderIsMe ? 1 : 0,
        t.lastMessageAt,
        t.unread ? 1 : 0,
        t.starred ? 1 : 0,
        JSON.stringify(t.labels),
        t.inInbox ? 1 : 0,
        t.iParticipated ? 1 : 0,
        t.toMe === null ? null : t.toMe ? 1 : 0,
        t.ccMe === null ? null : t.ccMe ? 1 : 0,
        t.bulk === null ? null : t.bulk ? 1 : 0,
        t.importantLabel === null ? null : t.importantLabel ? 1 : 0,
        t.msgCount
      )
    }
    if (starred.length > 0) {
      const ids = new Set(starred.map((s) => s.id))
      const stale = db
        .prepare('SELECT id FROM email_threads WHERE starred = 1')
        .all() as unknown as { id: string }[]
      const clear = db.prepare('UPDATE email_threads SET starred = 0 WHERE id = ?')
      for (const r of stale) if (!ids.has(r.id)) clear.run(r.id)
    }

    // Labels: counted once per thread, over everything seen in this crawl.
    const seen = new Map<string, number>()
    for (const t of all.values()) for (const l of t.labels) seen.set(l, (seen.get(l) ?? 0) + 1)
    const lab = db.prepare(
      `INSERT INTO gmail_labels (name, seen_count, last_seen) VALUES (?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(name) DO UPDATE SET seen_count=MAX(seen_count, excluded.seen_count), last_seen=CURRENT_TIMESTAMP`
    )
    for (const [name, n] of seen) lab.run(name, n)

    db.exec(
      `DELETE FROM email_threads WHERE starred = 0 AND (
         (last_message_at IS NOT NULL AND last_message_at < datetime('now','localtime','-${RETENTION_DAYS} days'))
         OR (last_message_at IS NULL AND fetched_at < datetime('now','-30 days')))`
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Case-insensitive handler lookup (Gmail label names are case-insensitive). */
export const handlerFor = (handlers: Record<string, LabelHandler>, label: string): LabelHandler => {
  const k = Object.keys(handlers).find((x) => x.toLowerCase() === label.toLowerCase())
  return k ? handlers[k] : 'info'
}

const hoursBetween = (aIso: string, now: Date): number =>
  (now.getTime() - new Date(aIso).getTime()) / 3_600_000

interface StoredRow {
  id: string
  linkId: string | null
  subject: string
  snippet: string | null
  senderName: string | null
  senderEmail: string | null
  lastIsMe: number
  lastMessageAt: string | null
  unread: number
  starred: number
  labels: string
  inInbox: number
  iParticipated: number
  toMe: number | null
  ccMe: number | null
  bulk: number | null
  importantLabel: number | null
  msgCount: number | null
}

/** What the importance score may also use: who you know, what you work on, your names, and how strict to be. */
export interface OverviewExtra {
  knownPerson?: (name: string | null, email: string | null) => boolean
  topic?: (text: string) => boolean
  meAliases?: string[]
  /** 'balanced' shows important and likely-useful mail; 'strict' only the important. */
  mode?: 'balanced' | 'strict'
}

/** A dismissed thread stays hidden until someone else writes after the dismissal. */
const revived = (
  r: { lastMessageAt: string | null; lastIsMe: number },
  at: string | null
): boolean =>
  !!at && !r.lastIsMe && !!r.lastMessageAt && r.lastMessageAt.replace('T', ' ') > at.slice(0, 19)

const importanceOf = (r: StoredRow, now: Date, ctx: ImportanceCtx): Importance =>
  scoreThread(
    {
      starred: !!r.starred,
      unread: !!r.unread,
      iParticipated: !!r.iParticipated,
      lastSenderIsMe: !!r.lastIsMe,
      senderEmail: r.senderEmail,
      senderName: r.senderName,
      subject: r.subject,
      snippet: r.snippet ?? '',
      ageHours: r.lastMessageAt ? hoursBetween(r.lastMessageAt, now) : 0,
      toMe: r.toMe === null ? null : !!r.toMe,
      ccMe: r.ccMe === null ? null : !!r.ccMe,
      bulk: r.bulk === null ? null : !!r.bulk,
      importantLabel: r.importantLabel === null ? null : !!r.importantLabel,
      msgCount: r.msgCount
    },
    ctx
  )

const importanceCtx = (db: Db, extra: OverviewExtra): ImportanceCtx => ({
  weights: loadWeights(db),
  repliedTo: loadRepliedTo(db),
  knownPerson: extra.knownPerson,
  topic: extra.topic,
  meAliases: extra.meAliases
})

const labelsFromJson = (json: string): string[] =>
  uniqueLabels(JSON.parse(json || '[]') as string[])

const factsOf = (r: StoredRow): RelevanceFacts => ({
  starred: !!r.starred,
  labels: labelsFromJson(r.labels),
  iParticipated: !!r.iParticipated,
  inInbox: !!r.inInbox,
  subject: r.subject,
  senderEmail: r.senderEmail,
  senderName: r.senderName
})

const STORED_SQL = `SELECT id, link_id AS linkId, subject, snippet, sender_name AS senderName, sender_email AS senderEmail,
              last_sender_is_me AS lastIsMe, last_message_at AS lastMessageAt, unread, starred,
              labels_json AS labels, in_inbox AS inInbox, i_participated AS iParticipated,
              to_me AS toMe, cc_me AS ccMe, bulk, important_label AS importantLabel, msg_count AS msgCount
         FROM email_threads ORDER BY last_message_at DESC`

/**
 * The thread ids that are worth anything to you: kept by the relevance rules, not dismissed (unless
 * someone wrote again), and not noise by the importance score. Used wherever mail is read or listed
 * (assistant answers, insights), so a muted, dismissed or bulk sender is never read or shown.
 */
export function worthwhileThreadIds(
  db: Db,
  handlers: Record<string, LabelHandler>,
  extra: OverviewExtra = {},
  now: Date = new Date()
): Set<string> {
  const rows = db.prepare(STORED_SQL).all() as unknown as StoredRow[]
  const dismissedAt = new Map(
    (
      db
        .prepare("SELECT thread_id AS id, at FROM email_actions WHERE action = 'dismissed'")
        .all() as unknown as { id: string; at: string | null }[]
    ).map((a) => [a.id, a.at])
  )
  const rctx = relevanceCtx(db, handlers)
  const ictx = importanceCtx(db, extra)
  const out = new Set<string>()
  for (const r of rows) {
    if (dismissedAt.has(r.id) && !revived(r, dismissedAt.get(r.id) ?? null)) continue
    if (!classify(factsOf(r), rctx).keep) continue
    if (importanceOf(r, now, ictx).level === 'noise' && !r.starred) continue
    out.add(r.id)
  }
  return out
}

export function overview(
  db: Db,
  handlers: Record<string, LabelHandler>,
  now: Date = new Date(),
  replyAfterHours = 48,
  extra: OverviewExtra = {}
): GmailOverview {
  const rows = db.prepare(STORED_SQL).all() as unknown as StoredRow[]
  const actions = db
    .prepare('SELECT thread_id AS id, action, at FROM email_actions')
    .all() as unknown as {
    id: string
    action: string
    at: string | null
  }[]
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const dismissed = new Set(
    actions
      .filter((a) => a.action === 'dismissed')
      .filter((a) => {
        const r = rowById.get(a.id)
        return !(r && revived(r, a.at))
      })
      .map((a) => a.id)
  )
  const ictx = importanceCtx(db, extra)
  const imp = new Map<string, Importance>()
  const taskAdded = new Set(actions.filter((a) => a.action === 'task_added').map((a) => a.id))
  const ctx = relevanceCtx(db, handlers)

  const stats: MailStats = { stored: rows.length, kept: 0, dropped: {}, keptBy: {} }
  const labelsOf = (r: StoredRow): string[] =>
    uniqueLabels(JSON.parse(r.labels || '[]') as string[])
  const live: StoredRow[] = []
  const reasonOf = new Map<string, KeepReason>()
  for (const r of rows) {
    const v = classify(factsOf(r), ctx)
    if (!v.keep) {
      stats.dropped[v.reason] = (stats.dropped[v.reason] ?? 0) + 1
      continue
    }
    stats.kept++
    stats.keptBy[v.reason] = (stats.keptBy[v.reason] ?? 0) + 1
    reasonOf.set(r.id, v.reason)
    imp.set(r.id, importanceOf(r, now, ictx))
    if (!dismissed.has(r.id)) live.push(r)
  }

  const toItem = (r: StoredRow, mode: 'review' | 'followup' | 'reply' = 'review'): ThreadItem => {
    const labels = labelsOf(r)
    return {
      id: r.id,
      linkId: r.linkId,
      subject: r.subject,
      snippet: r.snippet ?? '',
      senderName: r.senderName,
      senderEmail: r.senderEmail,
      lastMessageAt: r.lastMessageAt,
      unread: !!r.unread,
      starred: !!r.starred,
      labels,
      taskAdded: taskAdded.has(r.id),
      score: imp.get(r.id)?.score,
      level: imp.get(r.id)?.level,
      reasons: imp.get(r.id)?.reasons,
      taskText: suggestTaskText({
        subject: r.subject,
        labels,
        unreplied: mode === 'followup',
        needsMyReply: mode === 'reply'
      })
    }
  }

  // Newest first (the freshest silence is the most actionable), capped so the list stays usable.
  const needsReply = live
    .filter(
      (r) =>
        r.iParticipated &&
        r.lastIsMe &&
        r.lastMessageAt &&
        hoursBetween(r.lastMessageAt, now) >= replyAfterHours &&
        hoursBetween(r.lastMessageAt, now) <= 24 * 21
    )
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
    .slice(0, 25)
    .map((r) => toItem(r, 'followup'))

  // The mirror image: person-to-person mail still sitting in the inbox where THEY wrote last.
  // Unread first, then newest; labeled mail has its own group so it isn't repeated here.
  const candidates = live.filter(
    (r) =>
      r.inInbox &&
      !r.lastIsMe &&
      isPersonThread(r) &&
      labelsOf(r).length === 0 &&
      ['inbox', 'mine'].includes(reasonOf.get(r.id) ?? '') &&
      r.lastMessageAt &&
      hoursBetween(r.lastMessageAt, now) <= 24 * 14
  )
  // Most important first, then unread, then newest.
  const byImportance = (a: StoredRow, b: StoredRow): number =>
    (imp.get(b.id)?.score ?? 0) - (imp.get(a.id)?.score ?? 0) ||
    b.unread - a.unread ||
    (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')
  const shown = (r: StoredRow): boolean => {
    const level = imp.get(r.id)?.level ?? 'noise'
    return extra.mode === 'strict' ? level === 'important' : level !== 'noise'
  }
  // Mail that has been read and nothing marks as important is not asking for you.
  const awaiting = candidates
    .filter((r) => shown(r) && (r.unread || imp.get(r.id)?.level === 'important'))
    .sort(byImportance)
  const hiddenRows = candidates.filter((r) => !awaiting.includes(r)).sort(byImportance)
  const awaitingMe = awaiting.slice(0, 15).map((r) => toItem(r, 'reply'))
  const hidden = hiddenRows.slice(0, 30).map((r) => toItem(r, 'reply'))
  const starred = live
    .filter((r) => r.starred)
    .slice(0, 50)
    .map((r) => toItem(r))

  const byLabel = new Map<string, StoredRow[]>()
  for (const r of live) for (const l of labelsOf(r)) byLabel.set(l, [...(byLabel.get(l) ?? []), r])
  const groups: LabelGroup[] = []
  const info: GmailOverview['info'] = []
  for (const [label, list] of [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const h = handlerFor(handlers, label)
    const unread = list.filter((r) => r.unread).length
    if (h === 'tasks') {
      const sorted = [...list].sort((a, b) => b.unread - a.unread)
      groups.push({
        label,
        unread,
        total: list.length,
        threads: sorted.slice(0, 30).map((r) => toItem(r))
      })
    } else if (h === 'info') info.push({ label, unread, total: list.length })
  }
  const attention =
    awaiting.filter((r) => r.unread).length +
    needsReply.length +
    groups.reduce((s, g) => s + g.threads.filter((t) => t.unread && !t.taskAdded).length, 0)
  return {
    awaitingMe,
    awaitingMeTotal: awaiting.length,
    hidden,
    hiddenTotal: hiddenRows.length,
    needsReply,
    starred,
    groups,
    info,
    attention,
    stats
  }
}

export function listLabels(db: Db, handlers: Record<string, LabelHandler>): LabelInfo[] {
  const rows = db
    .prepare(
      'SELECT name, seen_count AS seen FROM gmail_labels ORDER BY seen_count DESC, name COLLATE NOCASE'
    )
    .all() as unknown as { name: string; seen: number }[]
  return rows.map((r) => ({ ...r, handler: handlerFor(handlers, r.name) }))
}

export function recordAction(db: Db, threadId: string, action: 'dismissed' | 'task_added'): void {
  db.prepare(
    `INSERT INTO email_actions (thread_id, action, at) VALUES (?,?,datetime('now','localtime'))
     ON CONFLICT(thread_id, action) DO UPDATE SET at = excluded.at`
  ).run(threadId, action)
}

export function getThread(
  db: Db,
  id: string
):
  | {
      id: string
      subject: string
      linkId: string | null
      senderName: string | null
      senderEmail: string | null
    }
  | undefined {
  return db
    .prepare(
      'SELECT id, subject, link_id AS linkId, sender_name AS senderName, sender_email AS senderEmail FROM email_threads WHERE id = ?'
    )
    .get(id) as never
}

/** Best guess of someone's email from mail we've already seen (exact name, or first name). */
export function guessEmail(db: Db, name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const r = db
    .prepare(
      `SELECT sender_email AS e FROM email_threads
        WHERE sender_email IS NOT NULL AND (lower(sender_name) = ? OR lower(sender_name) LIKE ? || ' %')
        ORDER BY last_message_at DESC LIMIT 1`
    )
    .get(n, n) as { e: string } | undefined
  return r?.e ?? null
}

/** Names of people who emailed (humans only), for auto-tagging plain-text mentions in notes. */
export function senderNames(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT sender_name AS n, sender_email AS e FROM email_threads
        WHERE sender_name IS NOT NULL AND sender_name <> '' LIMIT 3000`
    )
    .all() as unknown as { n: string; e: string | null }[]
  return rows
    .filter((r) => /^\p{Lu}[\p{L}'.-]+(\s+\p{Lu}[\p{L}'.-]+){1,2}$/u.test(r.n) && !/@/.test(r.n))
    .map((r) => r.n)
}

// ------------------------------------------------------------------- health

function coverage(rows: RawRow[], f: (r: RawRow) => boolean): number {
  return rows.length === 0 ? 1 : rows.filter(f).length / rows.length
}

/** Did the crawl return rows with the fields we rely on? Catches Gmail layout changes early. */
export function assessHealth(s: GmailScrape): { health: 'ok' | 'degraded'; detail: string | null } {
  if (s.incremental && s.rows.length === 0) return { health: 'ok', detail: null } // nothing changed
  if (s.rows.length === 0 && s.starred.length === 0) {
    return {
      health: 'degraded',
      detail: 'No mail was returned. Check the Google connection in Settings.'
    }
  }
  const named: [string, RawRow[]][] = [
    ['mail', s.rows],
    ['starred', s.starred]
  ]
  for (const [name, list] of named) {
    if (list.length < 5) continue
    const id = coverage(list, (r) => !!(r.legacyId || r.threadId))
    const subj = coverage(list, (r) => !!r.subject.trim())
    if (id < 0.9 || subj < 0.9) {
      return {
        health: 'degraded',
        detail: `In the ${name} list, Gmail rows are missing ${id < 0.9 ? 'thread ids' : 'subjects'} (${Math.round(Math.min(id, subj) * 100)}% readable).`
      }
    }
  }
  const all = [...s.rows, ...s.starred]
  const time = coverage(all, (r) => !!r.timeTitle)
  if (all.length >= 5 && time < 0.8) {
    return {
      health: 'degraded',
      detail: `Only ${Math.round(time * 100)}% of rows had a readable time.`
    }
  }
  return { health: 'ok', detail: null }
}

// --------------------------------------------------------------------- sync

const FULL_EVERY_MS = 6 * 3_600_000
const INCREMENTAL_DAYS = 3

export class GmailSync {
  private status: GmailStatus
  private inflight: Promise<GmailStatus> | null = null
  private timer: NodeJS.Timeout | null = null
  private retry: NodeJS.Timeout | null = null

  constructor(
    private db: Db,
    private scrape: (o: CrawlOptions) => Promise<GmailScrape>,
    private onStatus: (s: GmailStatus) => void = () => undefined,
    private enabled: () => boolean = () => true,
    private windowDays: () => number = () => 30
  ) {
    this.status = {
      state: 'idle',
      lastSyncAt: kvGet(db, 'gmail.lastSyncAt'),
      error: null,
      threads: (db.prepare('SELECT count(*) AS c FROM email_threads').get() as { c: number }).c,
      health: 'ok',
      healthDetail: null,
      lastRead: Number(kvGet(db, 'gmail.lastRead') ?? 0),
      lastPages: Number(kvGet(db, 'gmail.lastPages') ?? 0),
      partial: kvGet(db, 'gmail.partial') === '1',
      lastFull: kvGet(db, 'gmail.lastFull') === '1'
    }
  }

  getStatus(): GmailStatus {
    return this.status
  }

  private set(patch: Partial<GmailStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatus(this.status)
  }

  /** Re-emit the current status (e.g. after a dismissal) so views refresh. */
  touch(): void {
    this.onStatus(this.status)
  }

  /** Full crawl of the window every few hours (refreshes read/unread); quick recent-days crawl otherwise. */
  private plan(force: boolean): { full: boolean; opts: CrawlOptions } {
    const lastFullAt = Number(kvGet(this.db, 'gmail.lastFullAt') ?? 0)
    // After Google slowed us down, only small "what changed" reads until the pause is over:
    // starting the whole crawl again is what kept the limit from ever clearing.
    const pausedUntil = Number(kvGet(this.db, 'gmail.fullPausedUntil') ?? 0)
    const paused = Date.now() < pausedUntil && this.status.threads > 0
    const full =
      !paused && (force || Date.now() - lastFullAt > FULL_EVERY_MS || this.status.threads === 0)
    const days = full ? this.windowDays() : INCREMENTAL_DAYS
    return {
      full,
      opts: {
        days,
        maxPages: full ? Math.min(80, days * 3 + 10) : 8,
        sinceHistoryId: full ? null : kvGet(this.db, 'gmail.historyId')
      }
    }
  }

  /** Stop big reads for a while (longer each time in a row); returns how long to wait. */
  private pauseFull(): number {
    const n = Number(kvGet(this.db, 'gmail.backoffN') ?? 0)
    const wait = [2, 5, 10, 20, 40][Math.min(n, 4)] * 60_000
    kvSet(this.db, 'gmail.backoffN', String(n + 1))
    kvSet(this.db, 'gmail.fullPausedUntil', String(Date.now() + wait))
    return wait
  }

  sync(force = false): Promise<GmailStatus> {
    if (this.inflight) return this.inflight
    if (!this.enabled()) return Promise.resolve(this.status)
    this.set({ state: 'syncing', error: null })
    this.inflight = (async () => {
      try {
        let { full, opts } = this.plan(force)
        let res = await this.scrape(opts)
        if (res.resync) {
          // The source lost our place in the mailbox history: read the whole window again.
          this.db.prepare("DELETE FROM kv WHERE key = 'gmail.historyId'").run()
          ;({ full, opts } = this.plan(true))
          res = await this.scrape(opts)
        }
        if (!res.signedIn) {
          this.set({ state: 'needs-auth' })
          return this.status
        }
        const h = assessHealth(res)
        const self = res.selfEmail
        // A part-way read still updates what it saw, but must not clear stars it never got to.
        applyThreads(
          this.db,
          normalizeRows(res.rows, self),
          res.rateLimited ? [] : normalizeRows(res.starred, self)
        )
        const now = new Date().toISOString()
        if (res.rateLimited) this.pauseFull()
        else kvSet(this.db, 'gmail.backoffN', '0')
        kvSet(this.db, 'gmail.lastSyncAt', now)
        if (full && res.reachedCutoff) kvSet(this.db, 'gmail.lastFullAt', String(Date.now()))
        if (self) kvSet(this.db, 'gmail.selfEmail', self)
        if (res.historyId) kvSet(this.db, 'gmail.historyId', res.historyId)
        kvSet(this.db, 'gmail.lastRead', String(res.rows.length))
        kvSet(this.db, 'gmail.lastPages', String(res.pages))
        kvSet(this.db, 'gmail.partial', res.reachedCutoff ? '0' : '1')
        kvSet(this.db, 'gmail.lastFull', full ? '1' : '0')
        this.set({
          state: 'idle',
          lastSyncAt: now,
          threads: (
            this.db.prepare('SELECT count(*) AS c FROM email_threads').get() as { c: number }
          ).c,
          health: h.health,
          healthDetail: res.rateLimited
            ? 'Google is limiting mail reads, so part of your mail was read. The rest follows automatically.'
            : h.detail,
          lastRead: res.rows.length,
          lastPages: res.pages,
          partial: !res.reachedCutoff,
          lastFull: full
        })
      } catch (err) {
        const msg = (err as Error).message
        this.set({ state: 'error', error: msg })
        // Google asked us to slow down: pause the big read, and try a small one a little later,
        // waiting longer each time (2, 5, 10, 20 minutes) so the limit can clear.
        if (/try again in a minute|limiting how fast/i.test(msg) && !this.retry) {
          const wait = this.pauseFull()
          this.retry = setTimeout(
            () => {
              this.retry = null
              void this.sync()
            },
            Math.min(wait, 20 * 60_000)
          )
        }
      } finally {
        this.inflight = null
      }
      return this.status
    })()
    return this.inflight
  }

  start(everyMs = 20 * 60 * 1000): void {
    this.stop()
    setTimeout(() => void this.sync(), 6000) // after the calendar's first run
    this.timer = setInterval(() => void this.sync(), everyMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

const FREE_MAIL = new Set(
  (
    'gmail googlemail outlook hotmail live msn yahoo icloud me mac aol proton protonmail pm gmx zoho ' +
    'mail email fastmail hey comcast verizon att sbcglobal cox qq 163 126 yandex'
  ).split(' ')
)
/** Words that make a poor company name on their own. */
const GENERIC_DOMAIN = new Set(
  (
    'noreply notification notifications mailer mailchimp sendgrid amazonses calendar docs drive ' +
    'accounts support info news mail email bounce reply no-reply post office team group online web'
  ).split(' ')
)

/**
 * Companies you hear from, read off sender email domains ("jo@navy-nextmro.com" -> "Navy Nextmro").
 * Free mail providers and your own company (the domain nearly everyone shares) are left out.
 */
export function senderCompanies(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT lower(substr(sender_email, instr(sender_email, '@') + 1)) AS d, count(*) AS n
         FROM email_threads WHERE sender_email LIKE '%@%.%' GROUP BY d ORDER BY n DESC LIMIT 400`
    )
    .all() as unknown as { d: string; n: number }[]
  const total = rows.reduce((a, r) => a + r.n, 0) || 1
  const out: string[] = []
  for (const r of rows) {
    const parts = r.d.split('.')
    const label =
      parts.length > 2 && parts[parts.length - 2].length <= 3
        ? parts[parts.length - 3]
        : parts[parts.length - 2]
    if (!label || label.length < 4 || FREE_MAIL.has(label) || GENERIC_DOMAIN.has(label)) continue
    if (r.n / total >= 0.35) continue // most mail comes from your own company
    out.push(
      label
        .split('-')
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ')
    )
  }
  return [...new Set(out)]
}
