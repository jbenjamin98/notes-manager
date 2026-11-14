import type { Db } from '../db'
import { ownerNameFromChips, parseChips, type CalEvent } from './parse'
import type { CalendarScrape } from '../services/google'

export type CalendarState = 'idle' | 'syncing' | 'needs-auth' | 'error'

export interface CalendarStatus {
  state: CalendarState
  lastSyncAt: string | null
  error: string | null
}

export interface UpcomingEvent {
  id: string
  title: string
  date: string
  startTime: string | null
  endTime: string | null
  status: string | null
  notePath: string | null
}

const kvGet = (db: Db, key: string): string | null =>
  (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value ?? null
const kvSet = (db: Db, key: string, value: string): void => {
  db.prepare(
    'INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value)
}

/**
 * Store scraped events. Events inside the scraped date window that are no longer
 * present (cancelled/moved) are removed, but only when the scrape returned
 * something: an empty result is far more likely a load problem than an empty calendar.
 */
export function applyEvents(db: Db, events: CalEvent[]): { upserted: number; removed: number } {
  if (events.length === 0) return { upserted: 0, removed: 0 }
  const dates = events.map((e) => e.date).sort()
  const [min, max] = [dates[0], dates[dates.length - 1]]
  const ids = new Set(events.map((e) => e.id))
  let removed = 0
  db.exec('BEGIN')
  try {
    const stale = db
      .prepare('SELECT id FROM calendar_events WHERE date BETWEEN ? AND ?')
      .all(min, max) as { id: string }[]
    for (const { id } of stale) {
      if (!ids.has(id)) {
        db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
        removed++
      }
    }
    const up = db.prepare(
      `INSERT INTO calendar_events (id,title,start_at,end_at,date,all_day,kind,status,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,
         date=excluded.date,all_day=excluded.all_day,kind=excluded.kind,status=excluded.status,
         fetched_at=CURRENT_TIMESTAMP`
    )
    for (const e of events) {
      up.run(
        e.id,
        e.title,
        `${e.date}T${e.startTime ?? '00:00'}:00`,
        `${e.date}T${e.endTime ?? '23:59'}:00`,
        e.date,
        e.allDay ? 1 : 0,
        e.kind,
        e.status
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { upserted: events.length, removed }
}

/** Meetings you might take notes for: not declined, not tasks/all-day, from `fromDate` on. */
export function listUpcoming(db: Db, fromDate: string): UpcomingEvent[] {
  return db
    .prepare(
      `SELECT e.id, e.title, e.date,
              CASE WHEN e.all_day = 1 THEN NULL ELSE substr(e.start_at, 12, 5) END AS startTime,
              CASE WHEN e.all_day = 1 THEN NULL ELSE substr(e.end_at, 12, 5) END AS endTime,
              e.status,
              (SELECT n.file_path FROM notes n WHERE n.calendar_event_id = e.id LIMIT 1) AS notePath
         FROM calendar_events e
        WHERE e.kind = 'meeting' AND e.date >= ? AND COALESCE(e.status, '') <> 'declined'
        ORDER BY e.date, e.start_at, e.title`
    )
    .all(fromDate) as unknown as UpcomingEvent[]
}

export const localDate = (d = new Date()): string => d.toLocaleDateString('en-CA')

export class CalendarSync {
  private status: CalendarStatus
  private inflight: Promise<CalendarStatus> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private db: Db,
    private scrape: () => Promise<CalendarScrape>,
    private onStatus: (s: CalendarStatus) => void = () => undefined,
    private onData: () => void = () => undefined,
    private onOwner: (name: string) => void = () => undefined
  ) {
    this.status = { state: 'idle', lastSyncAt: kvGet(db, 'calendar.lastSyncAt'), error: null }
  }

  getStatus(): CalendarStatus {
    return this.status
  }

  private set(patch: Partial<CalendarStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatus(this.status)
  }

  /** Manual refresh and the periodic timer both land here. Concurrent calls share one run. */
  sync(): Promise<CalendarStatus> {
    if (this.inflight) return this.inflight
    this.set({ state: 'syncing', error: null })
    this.inflight = (async () => {
      try {
        const res = await this.scrape()
        if (!res.signedIn) {
          this.set({ state: 'needs-auth' })
          return this.status
        }
        const events = parseChips(res.chips)
        const owner = ownerNameFromChips(res.chips)
        if (owner) this.onOwner(owner)
        applyEvents(this.db, events)
        const now = new Date().toISOString()
        kvSet(this.db, 'calendar.lastSyncAt', now)
        this.set({ state: 'idle', lastSyncAt: now })
        this.onData()
      } catch (err) {
        this.set({ state: 'error', error: (err as Error).message })
      } finally {
        this.inflight = null
      }
      return this.status
    })()
    return this.inflight
  }

  /** First sync shortly after launch, then every `everyMs` while the app runs. */
  start(everyMs = 15 * 60 * 1000): void {
    this.stop()
    setTimeout(() => void this.sync(), 2000)
    this.timer = setInterval(() => void this.sync(), everyMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
