import type { Db } from '../db'
import { cleanMeetUrl, normalizeGuests, saveDetail } from './detail'
import type { CalEvent } from './parse'
import type { Guest } from './detail'

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
  const seen = new Set<string>()
  return (
    db
      .prepare(
        `SELECT e.id, e.title, e.date,
              CASE WHEN e.all_day = 1 THEN NULL ELSE substr(e.start_at, 12, 5) END AS startTime,
              CASE WHEN e.all_day = 1 THEN NULL ELSE substr(e.end_at, 12, 5) END AS endTime,
              e.status,
              (SELECT n.file_path FROM notes n WHERE n.calendar_event_id = e.id LIMIT 1) AS notePath
         FROM calendar_events e
        WHERE e.kind = 'meeting' AND e.all_day = 0 AND e.date >= ? AND COALESCE(e.status, '') <> 'declined'
        ORDER BY e.date, e.start_at, e.title`
      )
      .all(fromDate) as unknown as UpcomingEvent[]
  ).filter((e) => {
    // Same rule as eventsForDay: one entry per title and start (an invite on two calendars).
    const k = `${e.title.trim().toLowerCase()}|${e.date}|${e.startTime ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * The one rule for "your meetings on a day", used by the brief, the assistant, nudges and Home so
 * they never disagree: real meetings only (no all-day, working-location or task entries), not
 * declined, and one entry per title and start time (the same invite on two calendars counts once).
 */
export interface DayEvent {
  id: string
  title: string
  date: string
  start: string
  end: string
  startAt: string
  endAt: string
  status: string | null
}
export function eventsForDay(db: Db, date: string): DayEvent[] {
  const rows = db
    .prepare(
      `SELECT id, title, date, substr(start_at, 12, 5) AS start, substr(end_at, 12, 5) AS end,
              start_at AS startAt, end_at AS endAt, status
         FROM calendar_events
        WHERE date = ? AND kind = 'meeting' AND all_day = 0 AND COALESCE(status, '') <> 'declined'
        ORDER BY start_at, title`
    )
    .all(date) as unknown as DayEvent[]
  const seen = new Set<string>()
  return rows.filter((e) => {
    const k = e.title.trim().toLowerCase() + '|' + e.startAt
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export const localDate = (d = new Date()): string => d.toLocaleDateString('en-CA')

/** What a source hands over for the calendar: events, plus the guests and Meet links it already knows. */
export interface CalendarScrape {
  /** False when the source needs the user to sign in / reconnect (data is kept as is). */
  signedIn: boolean
  events: CalEvent[]
  details: { id: string; guests: Guest[]; meetUrl: string | null }[]
  owner: string | null
  selfEmail: string | null
  /** Documents attached to events (Gemini meeting notes), by event id. */
  attachments?: { eventId: string; fileId: string; title: string }[]
}

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
        if (res.owner) this.onOwner(res.owner)
        applyEvents(this.db, res.events)
        // The API already knows the guests: store them so the prep sheet never has to fetch a page.
        if (res.selfEmail) kvSet(this.db, 'gmail.selfEmail', res.selfEmail)
        for (const d of res.details)
          saveDetail(this.db, d.id, {
            guests: normalizeGuests(d.guests, res.selfEmail ?? null),
            meetUrl: cleanMeetUrl(d.meetUrl)
          })
        for (const a of res.attachments ?? [])
          this.db
            .prepare(
              'INSERT OR REPLACE INTO event_attachments (event_id, file_id, title) VALUES (?,?,?)'
            )
            .run(a.eventId, a.fileId, a.title)
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
  start(everyMs = 5 * 60 * 1000): void {
    this.stop()
    setTimeout(() => void this.sync(), 2000)
    this.timer = setInterval(() => void this.sync(), everyMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
