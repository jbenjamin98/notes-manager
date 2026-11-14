import type { Db } from '../db'
import type { TaskItem } from '../vault/vault'
import { loadDetail, nameFromEmail, type Guest } from '../calendar/detail'
import { openQuestions, pastMeetingNotes, seriesKey } from '../nudges/rules'

/**
 * The one-screen prep sheet for a meeting, built from local data only:
 *   - who is coming, and what you owe/are owed with each of them
 *   - what happened last time in this series (unresolved questions, open tasks)
 *   - open work for the account, and recent email with the attendees
 */

export interface PrepAttendee {
  email: string
  name: string
  personId: string | null
  /** Open tasks assigned to them (things they owe you). */
  theyOwe: number
  lastNoteDate: string | null
  recentEmails: number
}

export interface PrepNoteRef {
  path: string
  title: string
  date: string
  openTasks: number
}

export interface PrepEmail {
  id: string
  subject: string
  from: string
  when: string | null
  starred: boolean
}

export interface PrepDossier {
  event: {
    id: string
    title: string
    date: string
    startTime: string | null
    endTime: string | null
    meetUrl: string | null
    notePath: string | null
    /** Guests/Meet link have been fetched from Google (otherwise attendees are unknown, not absent). */
    detailFetched: boolean
  }
  attendees: PrepAttendee[]
  series: {
    previous: PrepNoteRef[]
    questions: string[]
    openTasks: TaskItem[]
  }
  attendeeTasks: TaskItem[]
  account: string | null
  accountTasks: TaskItem[]
  emails: PrepEmail[]
}

interface Deps {
  tasks: TaskItem[]
  selfEmail: string | null
  guessAccount: (title: string) => string | null
}

const first = (s: string): string => s.trim().split(/\s+/)[0].toLowerCase()

/** Best display name for a guest: what the page showed, else a sender name we've seen, else the address. */
function guestName(db: Db, g: Guest): string {
  if (g.name) return g.name
  const r = db
    .prepare(
      `SELECT sender_name AS n FROM email_threads
        WHERE lower(sender_email) = ? AND sender_name IS NOT NULL AND sender_name <> '' ORDER BY last_message_at DESC LIMIT 1`
    )
    .get(g.email.toLowerCase()) as { n: string } | undefined
  return r?.n ?? nameFromEmail(g.email)
}

function personFor(db: Db, name: string): { id: string; name: string } | null {
  const exact = db
    .prepare("SELECT id, name FROM entities WHERE category = 'person' AND lower(name) = lower(?)")
    .get(name) as { id: string; name: string } | undefined
  if (exact) return exact
  // Unique first-name match ("Sarah" for "Sarah Chen") only when it is unambiguous.
  const rows = db
    .prepare(
      "SELECT id, name FROM entities WHERE category = 'person' AND lower(name) LIKE ? || ' %'"
    )
    .all(first(name)) as unknown as { id: string; name: string }[]
  return rows.length === 1 ? rows[0] : null
}

export function buildDossier(db: Db, eventId: string, deps: Deps): PrepDossier | null {
  const e = db
    .prepare(
      `SELECT id, title, date, start_at, end_at, all_day, meet_url FROM calendar_events WHERE id = ?`
    )
    .get(eventId) as
    | {
        id: string
        title: string
        date: string
        start_at: string
        end_at: string
        all_day: number
        meet_url: string | null
      }
    | undefined
  if (!e) return null
  const d = loadDetail(db, eventId)
  const note = db
    .prepare('SELECT file_path AS p FROM notes WHERE calendar_event_id = ? LIMIT 1')
    .get(eventId) as { p: string } | undefined

  // ---- attendees
  const attendees: PrepAttendee[] = (d?.detail.guests ?? []).map((g) => {
    const name = guestName(db, g)
    const person = personFor(db, name)
    const theyOwe = deps.tasks.filter(
      (t) =>
        t.status === 'open' &&
        !t.isMine &&
        (t.owner.toLowerCase() === name.toLowerCase() ||
          (person !== null && t.owner.toLowerCase() === person.name.toLowerCase()) ||
          t.owner.toLowerCase() === first(name))
    ).length
    const last = person
      ? (db
          .prepare(
            `SELECT max(n.date) AS d FROM note_entities ne JOIN notes n ON n.id = ne.note_id
              WHERE ne.entity_id = ? AND n.file_path NOT LIKE '% (%).md'`
          )
          .get(person.id) as { d: string | null })
      : { d: null }
    const recentEmails = (
      db
        .prepare(
          `SELECT count(*) AS c FROM email_threads
            WHERE lower(sender_email) = ? AND last_message_at >= datetime('now','localtime','-30 days')`
        )
        .get(g.email.toLowerCase()) as { c: number }
    ).c
    return {
      email: g.email,
      name,
      personId: person?.id ?? null,
      theyOwe,
      lastNoteDate: last.d,
      recentEmails
    }
  })

  // ---- the series: what happened last time
  const key = seriesKey(e.title)
  const past = key ? pastMeetingNotes(db, e.date).filter((n) => seriesKey(n.title) === key) : []
  const previous: PrepNoteRef[] = past.slice(0, 3).map((n) => ({
    path: n.path,
    title: n.title,
    date: n.date,
    openTasks: deps.tasks.filter((t) => t.status === 'open' && t.notePath === n.path).length
  }))
  const seriesPaths = new Set(past.slice(0, 3).map((n) => n.path))
  const questions = past[0] ? openQuestions(db, past[0].id) : []
  const seriesTasksAll = deps.tasks.filter(
    (t) => t.status === 'open' && seriesPaths.has(t.notePath)
  )

  // ---- open work tied to these people
  const names = new Set(attendees.flatMap((a) => [a.name.toLowerCase(), first(a.name)]))
  const attendeeTasks = deps.tasks
    .filter((t) => t.status === 'open' && !t.isMine && names.has(t.owner.toLowerCase()))
    .slice(0, 12)

  // ---- the account (from the title) and its open work
  const account = deps.guessAccount(e.title)
  const accountTasks = account
    ? deps.tasks
        .filter(
          (t) =>
            t.status === 'open' && t.isMine && t.account?.toLowerCase() === account.toLowerCase()
        )
        .slice(0, 8)
    : []

  // Each task is listed once, under its most specific heading: people first, then the series, then the account.
  const listed = new Set(attendeeTasks.map((t) => t.id))
  const seriesTasks = seriesTasksAll.filter((t) => !listed.has(t.id))
  for (const t of seriesTasks) listed.add(t.id)
  const accountTasksUnique = accountTasks.filter((t) => !listed.has(t.id))

  // ---- recent email with the attendees, plus starred mail that mentions the meeting's topic
  const emails: PrepEmail[] = []
  const seen = new Set<string>()
  const push = (r: {
    id: string
    subject: string
    from: string | null
    when: string | null
    starred: number
  }): void => {
    if (seen.has(r.id) || emails.length >= 8) return
    seen.add(r.id)
    emails.push({
      id: r.id,
      subject: r.subject,
      from: r.from ?? '',
      when: r.when,
      starred: !!r.starred
    })
  }
  for (const a of attendees) {
    const rows = db
      .prepare(
        `SELECT id, subject, sender_name AS "from", last_message_at AS "when", starred FROM email_threads
          WHERE lower(sender_email) = ? AND last_message_at >= datetime('now','localtime','-30 days')
          ORDER BY last_message_at DESC LIMIT 3`
      )
      .all(a.email.toLowerCase()) as unknown as {
      id: string
      subject: string
      from: string | null
      when: string | null
      starred: number
    }[]
    rows.forEach(push)
  }
  const topic = (key || e.title.toLowerCase()).split(/\s+/).filter((w) => w.length >= 4)
  if (topic.length) {
    const starred = db
      .prepare(
        `SELECT id, subject, sender_name AS "from", last_message_at AS "when", starred FROM email_threads WHERE starred = 1 ORDER BY last_message_at DESC LIMIT 60`
      )
      .all() as unknown as {
      id: string
      subject: string
      from: string | null
      when: string | null
      starred: number
    }[]
    for (const r of starred) if (topic.some((w) => r.subject.toLowerCase().includes(w))) push(r)
  }

  return {
    event: {
      id: e.id,
      title: e.title,
      date: e.date,
      startTime: e.all_day ? null : e.start_at.slice(11, 16),
      endTime: e.all_day ? null : e.end_at.slice(11, 16),
      meetUrl: e.meet_url,
      notePath: note?.p ?? null,
      detailFetched: d?.fetched ?? false
    },
    attendees,
    series: { previous, questions, openTasks: seriesTasks },
    attendeeTasks,
    account,
    accountTasks: accountTasksUnique,
    emails: emails.sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''))
  }
}

export interface DayData {
  date: string
  events: {
    id: string
    title: string
    startTime: string | null
    endTime: string | null
    status: string | null
    notePath: string | null
  }[]
  notes: { path: string; title: string }[]
  due: { count: number; high: number }
}

/** Everything the calendar grid shows for a date range: meetings, notes written, tasks due. */
export function buildRange(db: Db, from: string, to: string, tasks: TaskItem[]): DayData[] {
  const days = new Map<string, DayData>()
  const day = (date: string): DayData => {
    let d = days.get(date)
    if (!d) {
      d = { date, events: [], notes: [], due: { count: 0, high: 0 } }
      days.set(date, d)
    }
    return d
  }
  const events = db
    .prepare(
      `SELECT e.id, e.title, e.date, e.status, substr(e.start_at,12,5) AS startTime, substr(e.end_at,12,5) AS endTime,
              (SELECT n.file_path FROM notes n WHERE n.calendar_event_id = e.id LIMIT 1) AS notePath
         FROM calendar_events e
        WHERE e.kind = 'meeting' AND e.all_day = 0 AND COALESCE(e.status,'') <> 'declined' AND e.date BETWEEN ? AND ?
        ORDER BY e.date, e.start_at`
    )
    .all(from, to) as unknown as (DayData['events'][number] & { date: string })[]
  for (const { date, ...ev } of events) day(date).events.push(ev)

  const notes = db
    .prepare(
      `SELECT file_path AS path, title, date FROM notes
        WHERE date BETWEEN ? AND ? AND type <> 'inbox' AND file_path NOT LIKE '% (%).md' AND calendar_event_id IS NULL
        ORDER BY date, title`
    )
    .all(from, to) as unknown as { path: string; title: string; date: string }[]
  for (const n of notes) day(n.date).notes.push({ path: n.path, title: n.title })

  for (const t of tasks) {
    if (t.status !== 'open' || !t.isMine || !t.due || t.due < from || t.due > to) continue
    const d = day(t.due)
    d.due.count++
    if (t.priority === 'High') d.due.high++
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
}
