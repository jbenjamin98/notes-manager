import type { Db } from '../db'
import type { TaskItem } from '../vault/vault'
import { eventsForDay } from '../calendar/sync'
import { listWaiting } from '../waiting/waiting'
import { retrieve, type Hit } from './retrieve'

/**
 * Everything the assistant knows that bears on a question, as numbered sources: note passages,
 * your open tasks, meetings, what people owe you, insights from mail/chat/meetings, and the people
 * and projects named in the question. Answers used to come from note keywords alone, which is why
 * they often said "nothing found" or came back thin.
 */
export type SourceKind = 'note' | 'task' | 'meeting' | 'waiting' | 'insight' | 'entity'

export interface Source {
  n: number
  kind: SourceKind
  /** One line naming the source ("Task", "Meeting · Nov 17 09:00", the note title...). */
  label: string
  text: string
  /** A note to open when the source is cited (when there is one). */
  path: string | null
  title: string
  date: string
  heading: string | null
  chunkId: number | null
}

export interface ContextBudget {
  notes: number
  noteChars: number
  /** Total characters for everything that is not a note passage. */
  extraChars: number
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu
const STOP = new Set(
  'the and for with that this are was were what when where which who how why did does have has had about from into over our your you can could should would will any all not but also still need tell show find list give me my status update going latest'.split(
    ' '
  )
)
const words = (q: string): string[] =>
  [...new Set(q.toLowerCase().match(WORD) ?? [])].filter((w) => !STOP.has(w))

const addDaysIso = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + n)
  return d.toLocaleDateString('en-CA')
}

/** Which days the question is about ("today", "tomorrow", "this week"...), if any. */
export function daysAsked(q: string, today: string): string[] {
  const s = q.toLowerCase()
  if (/\b(this|the) week\b|\bweek ahead\b|\bnext few days\b/.test(s))
    return Array.from({ length: 7 }, (_, i) => addDaysIso(today, i))
  const out: string[] = []
  if (/\btoday\b|\bon my plate\b|\bmy day\b|\bthis morning\b|\bthis afternoon\b/.test(s))
    out.push(today)
  if (/\btomorrow\b/.test(s)) out.push(addDaysIso(today, 1))
  return out
}

/** People, companies and projects from your notes whose names appear in the question. */
export function entitiesIn(
  db: Db,
  q: string
): { id: string; name: string; category: string; notes: number; last: string | null }[] {
  const s = ` ${q.toLowerCase().replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')} `
  let all: { id: string; name: string; category: string }[] = []
  try {
    all = db
      .prepare(`SELECT id, name, category FROM entities WHERE length(name) >= 3`)
      .all() as typeof all
  } catch {
    return []
  }
  const hit = all.filter((e) => {
    const n = e.name.toLowerCase()
    if (s.includes(` ${n} `) || s.includes(` ${n}'`) || s.includes(` ${n}?`)) return true
    // First names: "Sarah" finds "Sarah Lee" (people only)
    const first = n.split(/\s+/)[0]
    return e.category === 'person' && first.length >= 3 && s.includes(` ${first} `)
  })
  return hit.slice(0, 4).map((e) => {
    const r = db
      .prepare(
        `SELECT count(*) AS notes, max(n.date) AS last FROM note_entities ne JOIN notes n ON n.id = ne.note_id WHERE ne.entity_id = ?`
      )
      .get(e.id) as { notes: number; last: string | null }
    return { ...e, ...r }
  })
}

export function gatherContext(
  db: Db,
  question: string,
  opts: { tasks: TaskItem[]; today: string; budget: ContextBudget }
): Source[] {
  const { budget, today } = opts
  const q = question.toLowerCase()
  const ws = words(question)
  const out: Omit<Source, 'n'>[] = []
  const blank = { path: null, title: '', date: '', heading: null, chunkId: null }
  const matches = (text: string): number => {
    const t = text.toLowerCase()
    return ws.filter((w) => t.includes(w)).length
  }

  // People and projects named in the question: also search their names and pull their notes.
  const ents = entitiesIn(db, question)
  const people: Omit<Source, 'n'>[] = []
  for (const e of ents)
    people.push({
      ...blank,
      kind: 'entity',
      label: `${e.category === 'person' ? 'Person' : 'Topic'} · ${e.name}`,
      text: `${e.name}: mentioned in ${e.notes} note${e.notes === 1 ? '' : 's'}${e.last ? `, most recently ${e.last}` : ''}.`
    })

  // Note passages (the main body of knowledge), widened by the entity names.
  const noteQ = [question, ...ents.map((e) => e.name)].join(' ')
  const hits: Hit[] = retrieve(db, noteQ, budget.notes, budget.noteChars)
  for (const h of hits)
    out.push({
      kind: 'note',
      label: `${h.title} (${h.date})${h.heading ? ' - ' + h.heading : ''}`,
      text: h.text,
      path: h.path,
      title: h.title,
      date: h.date,
      heading: h.heading,
      chunkId: h.chunkId
    })

  const extras: Omit<Source, 'n'>[] = []
  const entNames = ents.map((e) => e.name.toLowerCase().split(/\s+/)[0])
  const aboutWork = /\b(task|todo|to-do|due|overdue|plate|working on|priorit|focus|owe)\w*/i.test(q)

  const days = daysAsked(question, today)
  const lastDay = days[days.length - 1]
  // Your open tasks: the ones that match, or all the pressing ones for "what should I do" questions.
  const open = opts.tasks.filter((t) => t.status === 'open' && t.isMine)
  const scored = open
    .map((t) => ({
      t,
      s:
        matches(`${t.description} ${t.noteTitle} ${t.account ?? ''}`) +
        (entNames.some((n) => t.description.toLowerCase().includes(n)) ? 2 : 0) +
        (aboutWork && t.due && t.due <= addDaysIso(today, 2) ? 1 : 0) +
        (lastDay && t.due && t.due <= lastDay ? 2 : 0)
    }))
    .filter((x) => x.s > 0 || (aboutWork && open.length <= 12))
    .sort((a, b) => b.s - a.s || (a.t.due ?? '9').localeCompare(b.t.due ?? '9'))
    .slice(0, 10)
  for (const { t } of scored)
    extras.push({
      ...blank,
      kind: 'task',
      label: `Your task${t.due ? ` · due ${t.due}${t.due < today ? ' (overdue)' : ''}` : ''}`,
      text: `${t.description}${t.priority ? ` [${t.priority}]` : ''} (from ${t.noteTitle})`,
      path: t.notePath,
      title: t.noteTitle,
      date: t.since
    })

  // Meetings: the days asked about, or upcoming ones that match.
  const meetingDays = days.length
    ? days
    : Array.from({ length: 14 }, (_, i) => addDaysIso(today, i))
  for (const d of meetingDays)
    for (const e of eventsForDay(db, d)) {
      if (
        !days.length &&
        matches(e.title) === 0 &&
        !entNames.some((n) => e.title.toLowerCase().includes(n))
      )
        continue
      extras.push({
        ...blank,
        kind: 'meeting',
        label: `Meeting · ${d} ${e.start}`,
        text: `${e.start}-${e.end} ${e.title}${e.status === 'tentative' ? ' (tentative)' : ''}`,
        date: d,
        title: e.title
      })
    }

  // What other people owe you.
  for (const w of listWaiting(db)) {
    const rel =
      matches(`${w.who} ${w.text}`) +
      (entNames.some((n) => w.who.toLowerCase().includes(n)) ? 2 : 0) +
      (/\bwaiting|owe|chase|follow.?up\b/.test(q) ? 1 : 0)
    if (rel === 0) continue
    extras.push({
      ...blank,
      kind: 'waiting',
      label: `Waiting on ${w.who}`,
      text: `${w.text}${w.due ? ` (due ${w.due})` : ''}, since ${w.since}`,
      path: w.notePath,
      title: w.noteTitle,
      date: w.since
    })
  }

  // Insights from meetings, mail and chat (actions, decisions, risks...).
  try {
    const rows = db
      .prepare(
        `SELECT kind, text, owner, due, source_label AS label, source_at AS at FROM insights
          WHERE status <> 'dismissed' ORDER BY coalesce(source_at, created_at) DESC LIMIT 400`
      )
      .all() as {
      kind: string
      text: string
      owner: string | null
      due: string | null
      label: string
      at: string | null
    }[]
    const picked = rows
      .map((r) => ({
        r,
        s:
          matches(`${r.text} ${r.owner ?? ''} ${r.label}`) +
          (entNames.some((n) => `${r.text} ${r.owner ?? ''}`.toLowerCase().includes(n)) ? 2 : 0) +
          (/\bdecid|decision/.test(q) && r.kind === 'decision' ? 1 : 0) +
          (/\brisk|block|concern|issue/.test(q) && r.kind === 'risk' ? 1 : 0)
      }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
    for (const { r } of picked)
      extras.push({
        ...blank,
        kind: 'insight',
        label: `${r.kind[0].toUpperCase()}${r.kind.slice(1)} · ${r.label}`,
        text: `${r.text}${r.owner ? ` (owner: ${r.owner})` : ''}${r.due ? ` (due ${r.due})` : ''}`,
        date: (r.at ?? '').slice(0, 10)
      })
  } catch {
    /* older databases without insights */
  }

  // Note passages first (they carry the citations), then who/what was named, then the rest,
  // kept inside their budget (short lines, so this is generous).
  let used = 0
  for (const x of [...people, ...extras]) {
    used += x.text.length + x.label.length
    if (used > budget.extraChars) break
    out.push(x)
  }
  return out.map((s, i) => ({ ...s, n: i + 1 }))
}

/** The numbered sources as the model reads them. */
export function formatSources(sources: Source[]): string {
  return sources.map((s) => `[${s.n}] ${s.label}\n${s.text}`).join('\n\n')
}

/** When nothing at all matched: the nearest notes by title, so the reply is never a dead end. */
export function nearestNotes(
  db: Db,
  question: string,
  k = 3
): { title: string; path: string; date: string }[] {
  const ws = words(question).filter((w) => w.length >= 4)
  if (ws.length === 0) return []
  const like = ws.map(() => 'lower(title) LIKE ?').join(' OR ')
  try {
    return db
      .prepare(
        `SELECT title, file_path AS path, date FROM notes WHERE type <> 'inbox' AND (${like}) ORDER BY date DESC LIMIT ?`
      )
      .all(...ws.map((w) => `%${w.slice(0, Math.max(4, w.length - 2))}%`), k) as {
      title: string
      path: string
      date: string
    }[]
  } catch {
    return []
  }
}
