import type { Db } from '../db'
import { eventsForDay } from '../calendar/sync'
import { isAutomatedSender } from '../gmail/relevance'
import type { TaskItem } from '../vault/vault'
import { fill, personaFor } from '../../shared/personas'

/**
 * Things the assistant tells you before you ask. Rules decide WHEN and gather the facts; the model
 * (in the persona's voice) writes the message from those facts, and the persona's fixed phrase is
 * the fallback when AI is off or over budget. Each candidate has a key; a key is announced once.
 */
export type Trigger = 'brief' | 'pre_meeting' | 'overdue' | 'nudge'

export interface Candidate {
  key: string
  trigger: Trigger
  title: string
  body: string
  /** What is true right now, in plain lines, for the model to write the message from. */
  facts: string
  /** What this message is for, in one line, for the model. */
  purpose: string
  /** Buttons under the message. `label::action:arg` runs an action, plain text is a question. */
  chips: string[]
  /** Time-critical: notifies at any hour. */
  urgent: boolean
}

export interface MailAwait {
  id: string
  subject: string
  sender: string
  lastMessageAt: string | null
}

export interface ProEnv {
  /** Wall-clock time in the settings zone (local fields). */
  now: Date
  zone?: string
  db: Db
  persona: string
  tasks: TaskItem[]
  awaitingMe: MailAwait[]
  workStartMin: number
  workEndMin: number
  eodMin: number
}

const min = (d: Date): number => d.getHours() * 60 + d.getMinutes()
const isWeekday = (d: Date): boolean => d.getDay() >= 1 && d.getDay() <= 5
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
const p2 = (n: number): string => String(n).padStart(2, '0')
const iso = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const hm = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))

interface Ev {
  id: string
  title: string
  date: string
  start: string
}

const eventsOn = (db: Db, date: string): Ev[] => eventsForDay(db, date)

export function candidates(env: ProEnv): Candidate[] {
  const out: Candidate[] = []
  const P = personaFor(env.persona)
  const now = env.now
  const m = min(now)
  const today = iso(now)
  const weekday = isWeekday(now)
  const inHours = weekday && m >= env.workStartMin && m <= env.workEndMin + 60
  const mine = env.tasks.filter((t) => t.isMine && t.status === 'open')
  const dueToday = mine.filter((t) => t.due === today)
  const overdue = mine.filter((t) => t.due !== null && t.due < today)
  const events = eventsOn(env.db, today)
  const remaining = events.filter((e) => hm(e.start) > m)

  // 1. Morning brief: once a weekday, once work has started.
  if (weekday && m >= env.workStartMin && m < env.workStartMin + 180) {
    const open = dueToday.length + overdue.length
    const meeting = events.length
      ? `, and ${plural(events.length, 'meeting')} (first at ${events[0].start})`
      : ''
    out.push({
      key: `brief:${today}`,
      trigger: 'brief',
      title: `${P.name}: today`,
      body: fill(open ? P.say.brief : P.say.briefClear, {
        tasks: plural(open, 'task') + (overdue.length ? ` (${overdue.length} overdue)` : ''),
        meeting
      }),
      purpose: 'A morning heads-up: how the day looks and the one thing to start with.',
      facts: [
        `Due today: ${dueToday.map((t) => t.description + (t.priority ? ` [${t.priority}]` : '')).join('; ') || 'nothing'}`,
        `Overdue: ${overdue.map((t) => `${t.description} (due ${t.due})`).join('; ') || 'nothing'}`,
        `Meetings today: ${events.map((e) => `${e.start} ${e.title}`).join('; ') || 'none'}`
      ].join('\n'),
      chips: ["What's due today?", 'Plan my day::day-brief:'],
      urgent: false
    })
  }

  // 2. A meeting starting in 8 to 15 minutes, with what is still open from last time.
  for (const e of remaining) {
    const until = hm(e.start) - m
    if (until < 8 || until > 15) continue
    const open = env.tasks.filter(
      (t) =>
        t.status === 'open' &&
        t.notePath &&
        /./.test(t.noteTitle) &&
        sameSeries(t.noteTitle, e.title)
    )
    out.push({
      key: `pm:${e.id}:${today}`,
      trigger: 'pre_meeting',
      title: `${P.name}: ${e.title}`,
      body: fill(P.say.pre, {
        title: e.title,
        mins: until,
        prep: open.length
          ? `${plural(open.length, 'item')} still open from last time.`
          : 'Nothing open from last time.'
      }),
      purpose: 'A meeting is about to start: say when, and what to have in mind from last time.',
      facts: [
        `Meeting: ${e.title} at ${e.start}, in ${until} minutes`,
        `Still open from earlier meetings in this series: ${open.map((t) => `${t.description} (${t.owner}${t.due ? `, due ${t.due}` : ''})`).join('; ') || 'nothing'}`
      ].join('\n'),
      chips: [`Brief me::prep-brief:${e.id}`],
      urgent: true
    })
  }

  // 3. Overdue work, nudged once in the early afternoon.
  if (inHours && overdue.length > 0 && m >= 13 * 60) {
    const sorted = [...overdue].sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))
    out.push({
      key: `od:${today}`,
      trigger: 'overdue',
      title: `${P.name}: overdue`,
      body: fill(P.say.overdue, {
        n: overdue.length,
        first: sorted[0].description,
        more: overdue.length > 1 ? ` and ${overdue.length - 1} more` : ''
      }),
      purpose: 'Overdue work: a push to decide on each item (do it, move it or drop it).',
      facts: sorted
        .slice(0, 6)
        .map(
          (t) => `Overdue: ${t.description} (due ${t.due}, ${daysBetween(t.due!, today)} days ago)`
        )
        .join('\n'),
      chips: ["What's due today?"],
      urgent: false
    })
  }

  // 4. A reply you owe, one at a time, only for mail that has waited two days.
  if (inHours) {
    const waiting = env.awaitingMe
      .filter((r) => !isAutomatedSender(null, r.sender))
      .filter((r) => r.lastMessageAt && daysBetween(r.lastMessageAt.slice(0, 10), today) >= 2)
      .sort((a, b) => (a.lastMessageAt ?? '').localeCompare(b.lastMessageAt ?? ''))[0]
    if (waiting)
      out.push({
        key: `reply:${waiting.id}`,
        trigger: 'nudge',
        title: `${P.name}: reply owed`,
        body: fill(P.say.reply, {
          who: waiting.sender || 'someone',
          subject: waiting.subject,
          days: plural(daysBetween(waiting.lastMessageAt!.slice(0, 10), today), 'day')
        }),
        purpose: 'A reply you may owe someone: remind the user, without nagging.',
        facts: `${waiting.sender || 'Someone'} wrote about "${waiting.subject}" ${daysBetween(waiting.lastMessageAt!.slice(0, 10), today)} days ago and has had no reply.`,
        chips: [],
        urgent: false
      })
  }

  // 5. End of day wrap-up.
  if (weekday && m >= env.eodMin && m < env.eodMin + 90) {
    const doneToday = env.tasks.filter(
      (t) =>
        t.isMine &&
        t.status === 'completed' &&
        t.completedAt &&
        iso(new Date(t.completedAt)) === today
    ).length
    const left = dueToday.length + overdue.length
    const tomorrow = nextBusiness(now)
    const nx = eventsOn(env.db, iso(tomorrow))[0]
    out.push({
      key: `eod:${today}`,
      trigger: 'nudge',
      title: `${P.name}: wrap-up`,
      body: fill(left ? P.say.eod : P.say.eodClear, {
        done: plural(doneToday, 'task'),
        left: plural(left, 'task'),
        next: nx ? `${nx.title} at ${nx.start}` : 'no meetings yet'
      }),
      purpose: 'End of the working day: a short wrap-up and what tomorrow looks like.',
      facts: [
        `Done today: ${doneToday} tasks`,
        `Still open (due today or overdue): ${[...dueToday, ...overdue].map((t) => t.description).join('; ') || 'nothing'}`,
        `Tomorrow: ${
          eventsOn(env.db, iso(tomorrow))
            .map((e) => `${e.start} ${e.title}`)
            .join('; ') || 'no meetings yet'
        }`
      ].join('\n'),
      chips: [],
      urgent: false
    })
  }
  return out
}

/** "NextMRO Weekly 11/13" and "NextMRO Weekly 11/6" are the same series. */
function sameSeries(a: string, b: string): boolean {
  const k = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  return k(a) === k(b) || k(a).startsWith(k(b)) || k(b).startsWith(k(a))
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000
  )
}

function nextBusiness(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  while (!isWeekday(x)) x.setDate(x.getDate() + 1)
  return x
}

/** Which candidates have not been announced yet. Keys are remembered in `kv` for two weeks. */
export function fresh(db: Db, cands: Candidate[]): Candidate[] {
  const has = db.prepare('SELECT 1 FROM kv WHERE key = ?')
  return cands.filter((c) => !has.get('pro:' + c.key))
}

export function markAnnounced(db: Db, c: Candidate, now: Date): void {
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    'pro:' + c.key,
    now.toISOString()
  )
}

export function pruneAnnounced(db: Db): void {
  db.exec("DELETE FROM kv WHERE key LIKE 'pro:%' AND value < datetime('now', '-14 days')")
}
