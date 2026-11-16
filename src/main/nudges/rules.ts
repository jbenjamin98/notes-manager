import type { Db } from '../db'
import { listWaiting } from '../waiting/waiting'
import type { TaskItem } from '../vault/vault'
import type { GmailOverview } from '../gmail/sync'
import { buildRollup, weekStartOf } from '../rollup/rollup'
import { seriesKey } from '../../shared/series'
import { triage, topicMatcher } from '../chat/triage'

/**
 * Deterministic proactive rules. Each rule is a pure function of "now" and local data: it decides
 * WHEN to nudge with zero LLM calls. Idempotence comes from `key`: the engine stores nudges under a
 * unique dedupe key, so re-evaluating (every minute, after sleep, after a restart) never repeats.
 */

export type RuleId =
  'brief' | 'prep' | 'empty-note' | 'overload' | 'followup' | 'blocker' | 'eod' | 'rollup' | 'chat'

export const RULES: { id: RuleId; label: string; description: string }[] = [
  { id: 'brief', label: 'Morning brief', description: 'Your day at a glance when work starts.' },
  {
    id: 'prep',
    label: 'Before a meeting',
    description: 'Open tasks and questions from the last one in the series, 15 minutes ahead.'
  },
  {
    id: 'empty-note',
    label: 'After a meeting',
    description: 'A nudge when a meeting you usually take notes for ends with no notes.'
  },
  {
    id: 'overload',
    label: 'Too much on one day',
    description: 'Warns when meetings plus your due tasks do not fit the day.'
  },
  {
    id: 'followup',
    label: 'Follow-up radar',
    description: 'People and emails you have been waiting on for days.'
  },
  {
    id: 'blocker',
    label: 'Chronic blockers',
    description: 'An open question that keeps coming back in the same recurring meeting.'
  },
  {
    id: 'rollup',
    label: 'Weekly review',
    description: 'On Friday afternoon: meetings, finished work and what is still open.'
  },
  {
    id: 'chat',
    label: 'Chat needs you',
    description: 'Someone asked you something in Chat and it has been waiting for hours.'
  },
  {
    id: 'eod',
    label: 'End of day',
    description: 'What is still open today, and what collides tomorrow.'
  }
]

export type NudgeAction =
  | { type: 'open-event'; id: string; label: string }
  | { type: 'open-prep'; id: string; label: string }
  | { type: 'open-note'; path: string; label: string }
  | { type: 'open-tasks'; filter: string; label: string }
  | { type: 'open-email'; label: string }
  | { type: 'open-chat'; label: string }
  | { type: 'open-rollup'; label: string }

export interface Candidate {
  key: string
  rule: RuleId
  title: string
  body: string
  actions: NudgeAction[]
}

export interface Env {
  now: Date
  db: Db
  tasks: TaskItem[]
  mail: GmailOverview | null
  workStartMin: number
  workEndMin: number
  eodMin: number
  defaultTaskMinutes: number
  enabled: (r: RuleId) => boolean
}

// ------------------------------------------------------------------ helpers

export const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const minutesOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes()
export const isWeekday = (d: Date): boolean => d.getDay() >= 1 && d.getDay() <= 5
const addDays = (d: Date, n: number): Date => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12)
  return x
}
export const parseHm = (s: string, fallback: number): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback
}
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
const fmtTime = (hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number)
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, '0')} ${ap}`
}
const fmtHours = (mins: number): string => {
  const h = mins / 60
  return `${Math.round(h * 10) / 10}h`
}
const daysBetween = (fromIso: string, to: Date): number =>
  Math.max(
    0,
    Math.round(
      (new Date(iso(to) + 'T12:00:00').getTime() - new Date(fromIso + 'T12:00:00').getTime()) /
        86_400_000
    )
  )

interface EventRow {
  id: string
  title: string
  date: string
  start_at: string
  end_at: string
  status: string | null
}

function meetingsOn(db: Db, from: string, to: string): EventRow[] {
  return db
    .prepare(
      `SELECT id, title, date, start_at, end_at, status FROM calendar_events
        WHERE kind = 'meeting' AND all_day = 0 AND COALESCE(status,'') <> 'declined' AND date BETWEEN ? AND ?
        ORDER BY start_at`
    )
    .all(from, to) as unknown as EventRow[]
}

const startOf = (e: EventRow): Date => new Date(e.start_at)
const endOf = (e: EventRow): Date => new Date(e.end_at)
const lengthMin = (e: EventRow): number =>
  Math.max(0, (endOf(e).getTime() - startOf(e).getTime()) / 60000)

/** "Sriya / Jacob - Monthly 1:1 (Nov 9)" and "... (Dec 7)" are one series. */
export { seriesKey }

export interface PastNote {
  id: string
  path: string
  title: string
  date: string
}

export function pastMeetingNotes(db: Db, before: string): PastNote[] {
  return db
    .prepare(
      `SELECT id, file_path AS path, title, date FROM notes
        WHERE type = 'meeting' AND date < ? AND file_path NOT LIKE '% (%).md' ORDER BY date DESC LIMIT 500`
    )
    .all(before) as unknown as PastNote[]
}

/** Real content, ignoring template headings and empty bullets/checkboxes. */
export function substantive(body: string | null): number {
  if (!body) return 0
  return body
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*(-|\*)\s*(\[[ xX]\])?\s*$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim().length
}

export function openQuestions(db: Db, noteId: string): string[] {
  const rows = db
    .prepare("SELECT text FROM note_chunks WHERE note_id = ? AND heading LIKE '%Open Questions%'")
    .all(noteId) as unknown as { text: string }[]
  return rows
    .flatMap((r) => r.text.split('\n'))
    .map((l) => l.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '').trim())
    .filter((l) => l.length > 3)
}

const STOP = new Set(
  'the and for with that this are was were will have has had but not you your our can could should would from into about over what when where which who whom how why also still need needs'.split(
    ' '
  )
)
const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .match(/[a-z][a-z0-9'-]{2,}/g)
      ?.filter((w) => !STOP.has(w)) ?? []
  )
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

const mineOpen = (tasks: TaskItem[]): TaskItem[] =>
  tasks.filter((t) => t.status === 'open' && t.isMine)

// -------------------------------------------------------------------- rules

/** 1. Morning brief: once per weekday, in the first hours of work (also catches up after sleep). */
export function morningBrief(env: Env): Candidate[] {
  const { now } = env
  const m = minutesOfDay(now)
  if (!isWeekday(now) || m < env.workStartMin || m > env.workStartMin + 240) return []
  const today = iso(now)
  const meetings = meetingsOn(env.db, today, today)
  const mine = mineOpen(env.tasks)
  const dueToday = mine.filter((t) => t.due === today)
  const overdue = mine.filter((t) => t.due !== null && t.due < today)
  const stale = env.tasks.filter(
    (t) => t.status === 'open' && !t.isMine && daysBetween(t.since, now) >= 3
  )
  const awaiting = env.mail?.awaitingMe.filter((t) => t.unread).length ?? 0

  const lines: string[] = []
  if (meetings.length) {
    const hrs = meetings.reduce((s, e) => s + lengthMin(e), 0)
    lines.push(
      `${plural(meetings.length, 'meeting')} (${fmtHours(hrs)}), first at ${fmtTime(meetings[0].start_at.slice(11, 16))}`
    )
  } else lines.push('No meetings today')
  if (overdue.length) lines.push(`${overdue.length} overdue`)
  lines.push(dueToday.length ? `${plural(dueToday.length, 'task')} due today` : 'Nothing due today')
  if (stale.length)
    lines.push(
      `${plural(stale.length, 'person')} owe${stale.length === 1 ? 's' : ''} you an update`.replace(
        'person',
        'item'
      )
    )
  if (awaiting) lines.push(`${plural(awaiting, 'unread email')} waiting for your reply`)

  const actions: NudgeAction[] = [
    { type: 'open-tasks', filter: overdue.length ? 'overdue' : 'today', label: 'Open tasks' }
  ]
  if (awaiting) actions.push({ type: 'open-email', label: 'Open email' })
  return [
    {
      key: `brief:${today}`,
      rule: 'brief',
      title: 'Good morning. Your day',
      body: lines.join('\n'),
      actions
    }
  ]
}

/** 2. Pre-meeting prep: 15 minutes before a meeting that has context from earlier in its series. */
export function preMeeting(env: Env): Candidate[] {
  const { now } = env
  if (!isWeekday(now)) return []
  const today = iso(now)
  const out: Candidate[] = []
  const past = pastMeetingNotes(env.db, today)
  for (const e of meetingsOn(env.db, today, today)) {
    const minsToStart = (startOf(e).getTime() - now.getTime()) / 60000
    if (minsToStart < 0 || minsToStart > 15) continue
    const key = seriesKey(e.title)
    const last = key ? past.find((n) => seriesKey(n.title) === key) : undefined
    if (!last) continue // nothing to prepare from: stay quiet
    const openTasks = env.tasks.filter((t) => t.status === 'open' && t.notePath === last.path)
    const questions = openQuestions(env.db, last.id)
    const parts: string[] = []
    if (openTasks.length) parts.push(plural(openTasks.length, 'open task'))
    if (questions.length) parts.push(plural(questions.length, 'unresolved question'))
    out.push({
      key: `prep:${e.id}`,
      rule: 'prep',
      title: `In ${Math.max(1, Math.round(minsToStart))} min: ${e.title}`,
      body:
        (parts.length
          ? `From your last one (${last.date}): ${parts.join(', ')}.`
          : `Your last notes are from ${last.date}.`) +
        (questions[0] ? `\nStill open: ${questions[0]}` : ''),
      actions: [
        { type: 'open-prep', id: e.id, label: 'Prep sheet' },
        { type: 'open-event', id: e.id, label: 'Open meeting notes' },
        { type: 'open-note', path: last.path, label: 'Last notes' }
      ]
    })
  }
  return out
}

/** 3. Post-meeting catcher: meetings you normally take notes for that ended with an empty note. */
export function emptyNoteCatcher(env: Env): Candidate[] {
  const { now } = env
  if (!isWeekday(now)) return []
  const today = iso(now)
  const out: Candidate[] = []
  const past = pastMeetingNotes(env.db, today)
  for (const e of meetingsOn(env.db, today, today)) {
    const sinceEnd = (now.getTime() - endOf(e).getTime()) / 60000
    if (sinceEnd < 5 || sinceEnd > 45) continue
    if (/\b(lunch|focus|break|commute|ooo|out of office|busy|hold|travel)\b/i.test(e.title))
      continue
    const key = seriesKey(e.title)
    const habitual = key !== '' && past.some((n) => seriesKey(n.title) === key)
    if (!habitual && lengthMin(e) < 45) continue // not a series you take notes for, and short: stay quiet
    const note = env.db
      .prepare(
        'SELECT file_path AS path, body_text AS body FROM notes WHERE calendar_event_id = ? LIMIT 1'
      )
      .get(e.id) as { path: string; body: string | null } | undefined
    if (note && substantive(note.body) >= 40) continue
    out.push({
      key: `empty:${e.id}`,
      rule: 'empty-note',
      title: `Capture ${e.title} while it is fresh`,
      body: note ? 'The note is still empty.' : 'No notes yet from this meeting.',
      actions: [{ type: 'open-event', id: e.id, label: 'Start notes' }]
    })
  }
  return out.slice(0, 2)
}

function dayLoad(
  env: Env,
  dateIso: string
): { meetingMin: number; taskMin: number; taskCount: number; highCount: number; capacity: number } {
  const meetings = meetingsOn(env.db, dateIso, dateIso)
  const meetingMin = meetings.reduce((s, e) => s + lengthMin(e), 0)
  const today = iso(env.now)
  const tasks = mineOpen(env.tasks).filter(
    (t) => t.due !== null && (t.due === dateIso || (dateIso === today && t.due < today))
  )
  const taskMin = tasks.reduce((s, t) => s + (t.estMinutes ?? env.defaultTaskMinutes), 0)
  return {
    meetingMin,
    taskMin,
    taskCount: tasks.length,
    highCount: tasks.filter((t) => t.priority === 'High').length,
    capacity: Math.max(60, env.workEndMin - env.workStartMin)
  }
}

/** 4. Capacity: meetings plus due `@Me` tasks (estimate or default) versus the work day. */
export function overload(env: Env): Candidate[] {
  const { now } = env
  const m = minutesOfDay(now)
  const out: Candidate[] = []
  const check = (d: Date, label: string): void => {
    if (!isWeekday(d)) return
    const day = iso(d)
    const l = dayLoad(env, day)
    const free = l.capacity - l.meetingMin
    if (l.taskCount === 0 || l.taskMin <= Math.max(0, free) * 0.9) return
    out.push({
      key: `overload:${day}`,
      rule: 'overload',
      title: `${label} will not fit`,
      body: `${fmtHours(l.meetingMin)} of meetings leaves about ${fmtHours(Math.max(0, free))} for ${plural(l.taskCount, 'task')} that need roughly ${fmtHours(l.taskMin)}. Consider moving something.`,
      actions: [
        { type: 'open-tasks', filter: label === 'Today' ? 'today' : 'mine', label: 'Review tasks' }
      ]
    })
  }
  if (m >= env.workStartMin && m <= env.workStartMin + 240) check(now, 'Today')
  if (m >= env.eodMin && m <= env.workEndMin + 90) check(nextBusinessDay(now), 'Tomorrow')
  return out
}

export function nextBusinessDay(d: Date): Date {
  let x = addDays(d, 1)
  while (!isWeekday(x)) x = addDays(x, 1)
  return x
}

/** 5. Follow-up radar: one daily digest of what people owe you (tasks and unanswered emails). */
export function followUpRadar(env: Env): Candidate[] {
  const { now } = env
  const m = minutesOfDay(now)
  if (!isWeekday(now) || m < env.workStartMin + 120 || m > env.workStartMin + 300) return []
  const today = iso(now)
  const lines: { text: string; age: number }[] = []
  for (const t of env.tasks) {
    if (t.status !== 'open' || t.isMine) continue
    const age = daysBetween(t.since, now)
    const late = t.due !== null && t.due < today
    if (!late && age < 5) continue
    lines.push({
      text: `@${t.owner}: ${t.description}${late ? ` (due ${daysBetween(t.due!, now)}d ago)` : ` (${age}d)`}`,
      age: late ? 100 + age : age
    })
  }
  // Waiting On note lines: what people owe you, kept as notes rather than tasks.
  let waiting: ReturnType<typeof listWaiting>
  try {
    waiting = listWaiting(env.db)
  } catch {
    waiting = []
  }
  for (const w of waiting) {
    const age = daysBetween(w.since, now)
    const late = w.due !== null && w.due < today
    if (!late && age < 5) continue
    lines.push({
      text: `${w.who}: ${w.text}${late ? ` (due ${daysBetween(w.due!, now)}d ago)` : ` (${age}d)`}`,
      age: late ? 100 + age : age
    })
  }
  for (const t of env.mail?.needsReply ?? []) {
    if (!t.lastMessageAt) continue
    const age = daysBetween(t.lastMessageAt.slice(0, 10), now)
    if (age < 3) continue
    lines.push({ text: `No reply from ${t.senderName ?? 'them'}: ${t.subject} (${age}d)`, age })
  }
  if (lines.length === 0) return []
  lines.sort((a, b) => b.age - a.age)
  const top = lines.slice(0, 4).map((l) => l.text)
  const more = lines.length - top.length
  return [
    {
      key: `radar:${today}`,
      rule: 'followup',
      title: `${plural(lines.length, 'follow-up')} to chase`,
      body: top.join('\n') + (more > 0 ? `\n…and ${more} more` : ''),
      actions: [
        { type: 'open-tasks', filter: 'waiting', label: 'Waiting On' },
        { type: 'open-email', label: 'Email follow-ups' }
      ]
    }
  ]
}

/** Chat: one nudge per conversation that has waited on you 4+ hours during work hours. */
export function chatNeedsYou(env: Env): Candidate[] {
  const { now } = env
  const m = minutesOfDay(now)
  if (!isWeekday(now) || m < env.workStartMin || m > env.workEndMin) return []
  let list
  try {
    list = triage(env.db, { topicHit: topicMatcher(env.db) }).conversations
  } catch {
    return []
  }
  return list
    .filter((c) => c.bucket === 'needs-you' && c.awaitingMeHours >= 4 && c.ageHours < 72)
    .slice(0, 3)
    .map((c) => ({
      key: `chat:${c.key}`,
      rule: 'chat' as const,
      title: `${c.title} is waiting on you`,
      body: `${c.lastSender}: ${c.lastText.slice(0, 140)}`,
      actions: [{ type: 'open-chat' as const, label: 'Open Chat' }]
    }))
}

/** 6. Chronic blocker: the same open question in the last 3 meetings of a recurring series. */
export function chronicBlockers(env: Env): Candidate[] {
  const { now } = env
  const m = minutesOfDay(now)
  if (!isWeekday(now) || m < env.workStartMin || m > env.workStartMin + 240) return []
  const past = pastMeetingNotes(env.db, iso(addDays(now, 1)))
  const bySeries = new Map<string, PastNote[]>()
  for (const n of past) {
    const k = seriesKey(n.title)
    if (k) bySeries.set(k, [...(bySeries.get(k) ?? []), n])
  }
  const out: Candidate[] = []
  const cutoff = iso(addDays(now, -75))
  for (const [series, notes] of bySeries) {
    const last3 = notes.slice(0, 3) // newest first
    if (last3.length < 3 || last3[0].date < cutoff) continue
    const qs = last3.map((n) => openQuestions(env.db, n.id).map((q) => ({ q, t: tokens(q) })))
    for (const cand of qs[0]) {
      if (cand.t.size < 2) continue
      const everywhere = qs.slice(1).every((list) => list.some((x) => jaccard(cand.t, x.t) >= 0.6))
      if (!everywhere) continue
      const id = [...cand.t].sort().join('-').slice(0, 60)
      out.push({
        key: `blocker:${series}:${id}`,
        rule: 'blocker',
        title: 'A blocker keeps coming back',
        body: `"${cand.q}" has been an open question in the last 3 ${series} meetings. Time to resolve it or escalate.`,
        actions: [{ type: 'open-note', path: last3[0].path, label: 'Latest notes' }]
      })
    }
  }
  return out.slice(0, 2)
}

/** 7. End of day: what is still open today, plus a heads-up on collisions in the next business days. */
export function endOfDay(env: Env): Candidate[] {
  const { now } = env
  const m = minutesOfDay(now)
  if (!isWeekday(now) || m < env.eodMin || m > env.workEndMin + 90) return []
  const today = iso(now)
  const mine = mineOpen(env.tasks)
  const dueToday = mine.filter((t) => t.due === today)
  const overdue = mine.filter((t) => t.due !== null && t.due < today)
  const lines: string[] = []
  lines.push(
    dueToday.length
      ? `${plural(dueToday.length, 'task')} due today are still open`
      : 'Everything due today is done'
  )
  if (overdue.length) lines.push(`${overdue.length} overdue`)

  // Collisions: a heavy day coming up (3+ due, or 2+ High) alongside a meeting-heavy calendar.
  let next = nextBusinessDay(now)
  for (let i = 0; i < 3; i++) {
    const l = dayLoad(env, iso(next))
    const crowded = l.taskCount >= 3 || l.highCount >= 2
    if (crowded && l.meetingMin >= 180) {
      lines.push(
        `${dayName(next)}: ${plural(l.taskCount, 'task')} due (${l.highCount} High) and ${fmtHours(l.meetingMin)} of meetings`
      )
      break
    }
    next = nextBusinessDay(next)
  }
  return [
    {
      key: `eod:${today}`,
      rule: 'eod',
      title: 'Close the loop for today',
      body: lines.join('\n'),
      actions: [
        { type: 'open-tasks', filter: dueToday.length ? 'today' : 'mine', label: 'Review tasks' }
      ]
    }
  ]
}

/** 8. Friday afternoon: your week in review (once per week). */
export function weeklyRollup(env: Env): Candidate[] {
  const { now } = env
  const m = minutesOfDay(now)
  if (now.getDay() !== 5 || m < env.eodMin - 30 || m > env.workEndMin + 90) return []
  const ws = weekStartOf(now)
  const r = buildRollup(env.db, env.tasks, ws, iso(now))
  const lines = [
    `${plural(r.notes.length, 'meeting')} and notes, ${plural(r.completed.length, 'task')} done`
  ]
  if (r.overdue.length) lines.push(`${r.overdue.length} still overdue`)
  if (r.comingUp.length) lines.push(`${plural(r.comingUp.length, 'task')} due next week`)
  return [
    {
      key: `rollup:${ws}`,
      rule: 'rollup',
      title: 'Your week in review',
      body: lines.join('\n'),
      actions: [{ type: 'open-rollup', label: 'Open weekly review' }]
    }
  ]
}

const dayName = (d: Date): string => d.toLocaleDateString('en-US', { weekday: 'long' })

export const ALL_RULES: Record<RuleId, (env: Env) => Candidate[]> = {
  brief: morningBrief,
  prep: preMeeting,
  'empty-note': emptyNoteCatcher,
  overload,
  followup: followUpRadar,
  blocker: chronicBlockers,
  eod: endOfDay,
  rollup: weeklyRollup,
  chat: chatNeedsYou
}
