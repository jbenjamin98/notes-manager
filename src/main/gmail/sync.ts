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
  normalizeMute,
  type DropReason,
  type KeepReason,
  type LabelHandler,
  type RelevanceCtx
} from './relevance'

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
}

export interface CrawlOptions {
  days: number
  maxPages: number
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
                                  last_message_at,unread,starred,labels_json,in_inbox,i_participated,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET link_id=COALESCE(excluded.link_id, link_id), subject=excluded.subject,
         snippet=excluded.snippet, sender_name=COALESCE(excluded.sender_name, sender_name),
         sender_email=COALESCE(excluded.sender_email, sender_email),
         last_sender_is_me=excluded.last_sender_is_me,
         last_message_at=COALESCE(excluded.last_message_at, last_message_at),
         unread=excluded.unread, starred=excluded.starred, labels_json=excluded.labels_json,
         in_inbox=excluded.in_inbox, i_participated=excluded.i_participated, fetched_at=CURRENT_TIMESTAMP`
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
        t.iParticipated ? 1 : 0
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
}

export function overview(
  db: Db,
  handlers: Record<string, LabelHandler>,
  now: Date = new Date(),
  replyAfterHours = 48
): GmailOverview {
  const rows = db
    .prepare(
      `SELECT id, link_id AS linkId, subject, snippet, sender_name AS senderName, sender_email AS senderEmail,
              last_sender_is_me AS lastIsMe, last_message_at AS lastMessageAt, unread, starred,
              labels_json AS labels, in_inbox AS inInbox, i_participated AS iParticipated
         FROM email_threads ORDER BY last_message_at DESC`
    )
    .all() as unknown as StoredRow[]
  const actions = db
    .prepare('SELECT thread_id AS id, action FROM email_actions')
    .all() as unknown as {
    id: string
    action: string
  }[]
  const dismissed = new Set(actions.filter((a) => a.action === 'dismissed').map((a) => a.id))
  const taskAdded = new Set(actions.filter((a) => a.action === 'task_added').map((a) => a.id))
  const ctx = relevanceCtx(db, handlers)

  const stats: MailStats = { stored: rows.length, kept: 0, dropped: {}, keptBy: {} }
  const labelsOf = (r: StoredRow): string[] =>
    uniqueLabels(JSON.parse(r.labels || '[]') as string[])
  const live: StoredRow[] = []
  const reasonOf = new Map<string, KeepReason>()
  for (const r of rows) {
    const v = classify(
      {
        starred: !!r.starred,
        labels: labelsOf(r),
        iParticipated: !!r.iParticipated,
        inInbox: !!r.inInbox,
        subject: r.subject,
        senderEmail: r.senderEmail,
        senderName: r.senderName
      },
      ctx
    )
    if (!v.keep) {
      stats.dropped[v.reason] = (stats.dropped[v.reason] ?? 0) + 1
      continue
    }
    stats.kept++
    stats.keptBy[v.reason] = (stats.keptBy[v.reason] ?? 0) + 1
    reasonOf.set(r.id, v.reason)
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
  const awaiting = live
    .filter(
      (r) =>
        r.inInbox &&
        !r.lastIsMe &&
        labelsOf(r).length === 0 &&
        ['inbox', 'mine'].includes(reasonOf.get(r.id) ?? '') &&
        r.lastMessageAt &&
        hoursBetween(r.lastMessageAt, now) <= 24 * 14
    )
    .sort(
      (a, b) => b.unread - a.unread || (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')
    )
  const awaitingMe = awaiting.slice(0, 15).map((r) => toItem(r, 'reply'))
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
  db.prepare('INSERT OR IGNORE INTO email_actions (thread_id, action) VALUES (?,?)').run(
    threadId,
    action
  )
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
  if (s.rows.length === 0 && s.starred.length === 0) {
    return {
      health: 'degraded',
      detail:
        'No mail rows were found. Gmail may have changed its layout, or the page did not load.'
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
    const full = force || Date.now() - lastFullAt > FULL_EVERY_MS || this.status.threads === 0
    const days = full ? this.windowDays() : INCREMENTAL_DAYS
    return { full, opts: { days, maxPages: full ? Math.min(80, days * 2 + 10) : 8 } }
  }

  sync(force = false): Promise<GmailStatus> {
    if (this.inflight) return this.inflight
    if (!this.enabled()) return Promise.resolve(this.status)
    this.set({ state: 'syncing', error: null })
    this.inflight = (async () => {
      try {
        const { full, opts } = this.plan(force)
        const res = await this.scrape(opts)
        if (!res.signedIn) {
          this.set({ state: 'needs-auth' })
          return this.status
        }
        const h = assessHealth(res)
        const self = res.selfEmail
        applyThreads(this.db, normalizeRows(res.rows, self), normalizeRows(res.starred, self))
        const now = new Date().toISOString()
        kvSet(this.db, 'gmail.lastSyncAt', now)
        if (full && res.reachedCutoff) kvSet(this.db, 'gmail.lastFullAt', String(Date.now()))
        if (self) kvSet(this.db, 'gmail.selfEmail', self)
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
          healthDetail: h.detail,
          lastRead: res.rows.length,
          lastPages: res.pages,
          partial: !res.reachedCutoff,
          lastFull: full
        })
      } catch (err) {
        this.set({ state: 'error', error: (err as Error).message })
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
