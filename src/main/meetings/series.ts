import type { Db } from '../db'
import type { Vault } from '../vault/vault'
import { openEventNote } from '../calendar/openEvent'

/**
 * Meeting Series: the same meeting held again and again ("NextMRO Sync" every week) is one series.
 * Each session stays its own independent note; the series page is derived from their metadata
 * (title, date, calendar event), so nothing new is stored and nothing can drift.
 */

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec'

/** "Weekly NextMRO Sync (Nov 12)" and "NextMRO sync 2026-11-19" are the same series. */
export function seriesKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(?:re|fwd|fw):/g, ' ')
    .replace(/\b(?:weekly|bi-?weekly|monthly|daily|quarterly|recurring)\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(new RegExp(`\\b(?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?\\b`, 'g'), ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** The bullets under a heading (until the next heading), without empty "-" lines or task lines. */
export function sectionBullets(content: string, heading: RegExp): string[] {
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inside = heading.test(line)
      continue
    }
    if (!inside) continue
    const m = /^\s*[-*]\s+(?!\[.\])(.+)$/.exec(line)
    const text = m?.[1].trim()
    if (text) out.push(text)
  }
  return out
}

export interface SeriesSession {
  date: string
  title: string
  /** The note for this session, when there is one. */
  path: string | null
  eventId: string | null
  status: 'notes' | 'scheduled' | 'no-notes'
}

export interface SeriesSummary {
  key: string
  title: string
  sessions: number
  lastDate: string
  nextDate: string | null
  openActions: number
}

export interface SeriesDetail {
  key: string
  title: string
  account: string | null
  attendees: string[]
  sessions: SeriesSession[]
  /** Unticked tasks from the series' notes, oldest first. */
  carried: { id: string; description: string; due: string | null; date: string; path: string }[]
  decisions: { text: string; date: string; path: string }[]
  questions: { text: string; date: string; path: string }[]
  /** People, projects, systems and topics that come up in more than one session. */
  threads: {
    name: string
    category: string
    sessions: number
    lines: { text: string; date: string; path: string }[]
  }[]
}

/** The list lines (bullets and tasks) of a note that mention a name, as whole words. */
export function linesMentioning(content: string, name: string): string[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])[@#]?${esc}(?![\\p{L}\\p{N}_])`, 'iu')
  const out: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(?:\[.\]\s+)?(.+)$/.exec(line)
    const text = m?.[1].replace(/\s\^[A-Za-z0-9]{4,12}\s*$/, '').trim()
    if (text && re.test(text)) out.push(text)
  }
  return out
}

interface NoteRow {
  path: string
  title: string
  date: string
  account: string | null
  eventId: string | null
  /** Linked by hand: a series title, or "-" for "not in any series". */
  series: string | null
}
interface EventRow {
  id: string
  title: string
  date: string
  attendees: string
  /** Google's repeat id, when the calendar gave one. */
  seriesId: string | null
}

function load(db: Db): { notes: NoteRow[]; events: EventRow[] } {
  const notes = db
    .prepare(
      `SELECT file_path AS path, title, date, account, calendar_event_id AS eventId, series
         FROM notes WHERE type = 'meeting' ORDER BY date`
    )
    .all() as unknown as NoteRow[]
  const events = db
    .prepare(
      `SELECT id, title, date, attendees_json AS attendees, series_id AS seriesId FROM calendar_events
        WHERE kind = 'meeting' AND all_day = 0 AND date IS NOT NULL ORDER BY date`
    )
    .all() as unknown as EventRow[]
  return { notes, events }
}

/**
 * Every series (a meeting held at least twice). Sessions are joined by, in order of trust:
 * a note linked by hand, an event's Google repeat id (so a renamed occurrence still belongs),
 * a note's calendar event, and last the normalised title.
 */
function group(db: Db): Map<string, { notes: NoteRow[]; events: EventRow[] }> {
  const { notes, events } = load(db)
  // Union-find over title keys: two titles are one series when Google says their events repeat together.
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    parent.set(k, r)
    return r
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    if (ra < rb) parent.set(rb, ra)
    else parent.set(ra, rb)
  }
  const evKey = new Map<string, string>()
  const byRepeat = new Map<string, string>()
  for (const e of events) {
    const k = seriesKey(e.title)
    if (k.length < 3) continue
    evKey.set(e.id, k)
    find(k)
    if (e.seriesId) {
      const first = byRepeat.get(e.seriesId)
      if (first) union(first, k)
      else byRepeat.set(e.seriesId, k)
    }
  }
  const by = new Map<string, { notes: NoteRow[]; events: EventRow[] }>()
  const slot = (k: string): { notes: NoteRow[]; events: EventRow[] } => {
    const r = find(k)
    const cur = by.get(r) ?? { notes: [], events: [] }
    by.set(r, cur)
    return cur
  }
  for (const n of notes) {
    if (n.series === '-') continue
    const k = n.series
      ? seriesKey(n.series)
      : (n.eventId && evKey.get(n.eventId)) || seriesKey(n.title)
    if (k.length >= 3) slot(k).notes.push(n)
  }
  for (const e of events) {
    const k = evKey.get(e.id)
    if (k) slot(k).events.push(e)
  }
  return by
}

/** What the series is called: its most common session title (the newest wins a tie). */
function commonTitle(sessions: SeriesSession[]): string {
  const count = new Map<string, number>()
  for (const s of sessions) count.set(s.title, (count.get(s.title) ?? 0) + 1)
  let best = sessions[0].title
  for (const s of sessions) if ((count.get(s.title) ?? 0) > (count.get(best) ?? 0)) best = s.title
  return best
}

/** One row per session: an event and its note are one session; a note with no event stands alone. */
function sessionsOf(g: { notes: NoteRow[]; events: EventRow[] }, today: string): SeriesSession[] {
  const out: SeriesSession[] = []
  const used = new Set<string>()
  for (const e of g.events) {
    const n =
      g.notes.find((x) => x.eventId === e.id) ??
      g.notes.find((x) => x.date === e.date && !used.has(x.path))
    if (n) used.add(n.path)
    out.push({
      date: e.date,
      title: e.title,
      path: n?.path ?? null,
      eventId: e.id,
      status: n ? 'notes' : e.date >= today ? 'scheduled' : 'no-notes'
    })
  }
  for (const n of g.notes)
    if (!used.has(n.path))
      out.push({ date: n.date, title: n.title, path: n.path, eventId: n.eventId, status: 'notes' })
  return out.sort((a, b) => b.date.localeCompare(a.date))
}

export function listSeries(db: Db, vault: Vault, today: string): SeriesSummary[] {
  const open = vault.listTasks().filter((t) => t.status === 'open')
  const out: SeriesSummary[] = []
  for (const [key, g] of group(db)) {
    const sessions = sessionsOf(g, today)
    if (sessions.length < 2) continue
    const paths = new Set(g.notes.map((n) => n.path))
    const past = sessions.filter((s) => s.date <= today)
    const next = sessions.filter((s) => s.date > today).pop()
    out.push({
      key,
      title: commonTitle(sessions),
      sessions: sessions.length,
      lastDate: past[0]?.date ?? sessions[0].date,
      nextDate: next?.date ?? null,
      openActions: open.filter((t) => paths.has(t.notePath)).length
    })
  }
  return out.sort((a, b) => b.lastDate.localeCompare(a.lastDate))
}

export async function seriesDetail(
  db: Db,
  vault: Vault,
  key: string,
  today: string
): Promise<SeriesDetail | null> {
  const g = group(db).get(key)
  if (!g) return null
  const sessions = sessionsOf(g, today)
  const paths = new Set(g.notes.map((n) => n.path))
  const names = new Set<string>()
  for (const e of g.events) {
    try {
      for (const a of JSON.parse(e.attendees) as unknown[]) {
        const n =
          typeof a === 'string'
            ? a
            : ((a as { name?: string; email?: string })?.name ?? (a as { email?: string })?.email)
        if (n) names.add(n)
      }
    } catch {
      /* attendee lists are optional */
    }
  }
  const decisions: SeriesDetail['decisions'] = []
  const questions: SeriesDetail['questions'] = []
  const recent = [...g.notes].sort((a, b) => b.date.localeCompare(a.date))
  const thread = new Map<
    string,
    {
      name: string
      category: string
      paths: Set<string>
      lines: SeriesDetail['threads'][number]['lines']
    }
  >()
  for (const [i, n] of recent.entries()) {
    let content: string
    try {
      content = (await vault.readNote(n.path)).content
    } catch {
      continue
    }
    for (const e of vault.noteEntities(n.path)) {
      const lines = linesMentioning(content, e.name)
      if (!lines.length) continue
      const t = thread.get(e.id) ?? {
        name: e.name,
        category: e.category,
        paths: new Set<string>(),
        lines: []
      }
      thread.set(e.id, t)
      t.paths.add(n.path)
      for (const text of lines.slice(0, 4)) t.lines.push({ text, date: n.date, path: n.path })
    }
    for (const text of sectionBullets(content, /decisions/i))
      decisions.push({ text, date: n.date, path: n.path })
    // Open questions matter while they are recent: the last three sessions.
    if (i < 3)
      for (const text of sectionBullets(content, /open questions|parking lot/i))
        questions.push({ text, date: n.date, path: n.path })
  }
  const dateOf = new Map(g.notes.map((n) => [n.path, n.date]))
  const carried = vault
    .listTasks()
    .filter((t) => t.status === 'open' && paths.has(t.notePath))
    .map((t) => ({
      id: t.id,
      description: t.description,
      due: t.due,
      date: dateOf.get(t.notePath) ?? '',
      path: t.notePath
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
  return {
    key,
    title: sessions.length ? commonTitle(sessions) : key,
    account: recent.find((n) => n.account)?.account ?? null,
    attendees: [...names].sort((a, b) => a.localeCompare(b)),
    sessions,
    carried,
    decisions: decisions.slice(0, 30),
    questions: questions.slice(0, 20),
    threads: [...thread.values()]
      .filter((t) => t.paths.size >= 2)
      .map((t) => ({
        name: t.name,
        category: t.category,
        sessions: t.paths.size,
        lines: t.lines.slice(0, 12)
      }))
      .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name))
      .slice(0, 12)
  }
}

/**
 * "Start Next Session": the next scheduled session's note (made from its calendar event), or a
 * new one dated today, with last time's open questions and unfinished actions listed to start from.
 */
export async function startNextSession(
  db: Db,
  vault: Vault,
  key: string,
  today: string
): Promise<string> {
  const d = await seriesDetail(db, vault, key, today)
  if (!d) throw new Error('That meeting series is no longer in your notes.')
  const upcoming = [...d.sessions].reverse().find((s) => s.date >= today && !s.path && s.eventId)
  const path = upcoming?.eventId
    ? await openEventNote(db, vault, upcoming.eventId)
    : await vault.createNote({
        kind: 'meeting',
        title: d.title,
        date: today,
        account: d.account ?? undefined
      })
  const items = [
    ...d.questions.map((q) => `- Open question: ${q.text}`),
    ...d.carried.map((t) => `- Still open: ${t.description}`)
  ]
  if (items.length) {
    const { content, hash } = await vault.readNote(path)
    if (!content.includes('## Carried Forward'))
      await vault.saveNote(
        path,
        `${content.trimEnd()}\n\n## Carried Forward From Last Time\n${items.join('\n')}\n`,
        hash
      )
  }
  return path
}

/** Meeting notes that could join this series: recent ones that are not in it already. */
export function seriesCandidates(
  db: Db,
  key: string,
  limit = 40
): { path: string; title: string; date: string }[] {
  const inSeries = new Set((group(db).get(key)?.notes ?? []).map((n) => n.path))
  return load(db)
    .notes.filter((n) => !inSeries.has(n.path))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
    .map((n) => ({ path: n.path, title: n.title, date: n.date }))
}

/** Put a meeting note into the series (join), or take it out of every series. False if the series is gone. */
export async function linkToSeries(
  db: Db,
  vault: Vault,
  path: string,
  key: string,
  join: boolean
): Promise<boolean> {
  if (!join) {
    await vault.setSeries(path, '-')
    return true
  }
  const g = group(db).get(key)
  const title = g?.events[0]?.title ?? g?.notes[0]?.title
  if (!title) return false
  await vault.setSeries(path, title)
  return true
}

/**
 * A normal, editable note that gathers a series in one place: its sessions, the decisions log,
 * open questions and what is still open. It is a snapshot (a note like any other), made on request.
 */
export async function createMasterNote(
  db: Db,
  vault: Vault,
  key: string,
  today: string
): Promise<string> {
  const d = await seriesDetail(db, vault, key, today)
  if (!d) throw new Error('That meeting series is no longer in your notes.')
  const lines = [
    '## Sessions',
    ...d.sessions.map((s) => `- ${s.date}: ${s.title}${s.path ? '' : ' (no notes)'}`),
    '',
    '## Decisions Log',
    ...(d.decisions.length ? d.decisions.map((x) => `- ${x.date}: ${x.text}`) : ['- ']),
    '',
    '## Open Questions',
    ...(d.questions.length ? d.questions.map((x) => `- ${x.date}: ${x.text}`) : ['- ']),
    '',
    '## Still Open',
    ...(d.carried.length ? d.carried.map((t) => `- ${t.date}: ${t.description}`) : ['- ']),
    ''
  ]
  return vault.createNote({
    kind: 'adhoc',
    title: `${d.title}: Series Overview`,
    date: today,
    body: lines.join('\n')
  })
}
