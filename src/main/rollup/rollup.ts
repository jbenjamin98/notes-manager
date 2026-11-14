import type { Db } from '../db'
import type { TaskItem } from '../vault/vault'

/** Everything here is deterministic: counts and lists from the user's own notes and tasks. */

export interface RollupTask {
  id: string
  description: string
  owner: string
  due: string | null
  priority: 'High' | 'Medium' | 'Low' | null
  notePath: string
  noteTitle: string
  completedAt: string | null
}

export interface Rollup {
  weekStart: string
  weekEnd: string
  /** Meeting / ad-hoc notes dated inside the week, oldest first. */
  notes: {
    path: string
    title: string
    date: string
    account: string | null
    type: 'meeting' | 'adhoc'
  }[]
  completed: RollupTask[]
  /** Tasks first written down this week. */
  createdCount: number
  /** My open tasks already past due. */
  overdue: RollupTask[]
  /** My open tasks due in the next 7 days after the week. */
  comingUp: RollupTask[]
  /** Others' open tasks, grouped by who owes them. */
  waitingOn: { owner: string; count: number }[]
  accounts: { account: string; notes: number }[]
  people: { name: string; notes: number }[]
}

const p2 = (n: number): string => String(n).padStart(2, '0')
export const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`

/** Monday of the week containing `d` (local time). */
export function weekStartOf(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return isoDay(x)
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return isoDay(new Date(y, m - 1, d + n))
}

const CONFLICT = /\(.*\)\.md$|conflict/i

const row = (t: TaskItem): RollupTask => ({
  id: t.id,
  description: t.description,
  owner: t.owner,
  due: t.due,
  priority: t.priority,
  notePath: t.notePath,
  noteTitle: t.noteTitle,
  completedAt: t.completedAt
})

export function buildRollup(db: Db, tasks: TaskItem[], weekStart: string, today: string): Rollup {
  const weekEnd = addDays(weekStart, 6)
  const notes = (
    db
      .prepare(
        `SELECT file_path AS path, title, date, account, type FROM notes
          WHERE type IN ('meeting','adhoc') AND date >= ? AND date <= ?
          ORDER BY date, title`
      )
      .all(weekStart, weekEnd) as Rollup['notes']
  ).filter((n) => !CONFLICT.test(n.path))

  const completed = tasks
    .filter((t) => t.status === 'completed' && t.completedAt)
    .filter((t) => {
      const day = isoDay(new Date(t.completedAt!))
      return day >= weekStart && day <= weekEnd
    })
    .map(row)
  const created = tasks.filter((t) => t.since >= weekStart && t.since <= weekEnd).length

  const open = tasks.filter((t) => t.status === 'open')
  const mine = open.filter((t) => t.isMine)
  const overdue = mine.filter((t) => t.due && t.due < today).map(row)
  const horizonEnd = addDays(weekEnd, 7)
  const comingUp = mine
    .filter((t) => t.due && t.due >= today && t.due > weekEnd && t.due <= horizonEnd)
    .map(row)
  const waiting = new Map<string, number>()
  for (const t of open.filter((x) => !x.isMine))
    waiting.set(t.owner, (waiting.get(t.owner) ?? 0) + 1)

  const byAccount = new Map<string, number>()
  for (const n of notes)
    if (n.account) byAccount.set(n.account, (byAccount.get(n.account) ?? 0) + 1)

  const people = db
    .prepare(
      `SELECT e.name AS name, count(DISTINCT n.id) AS notes
         FROM note_entities ne JOIN entities e ON e.id = ne.entity_id JOIN notes n ON n.id = ne.note_id
        WHERE e.category = 'person' AND n.type IN ('meeting','adhoc') AND n.date >= ? AND n.date <= ?
        GROUP BY e.id ORDER BY notes DESC, e.name LIMIT 5`
    )
    .all(weekStart, weekEnd) as Rollup['people']

  const byDue = (a: RollupTask, b: RollupTask): number => (a.due ?? '').localeCompare(b.due ?? '')
  return {
    weekStart,
    weekEnd,
    notes,
    completed,
    createdCount: created,
    overdue: overdue.sort(byDue),
    comingUp: comingUp.sort(byDue),
    waitingOn: [...waiting]
      .map(([owner, count]) => ({ owner, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    accounts: [...byAccount]
      .map(([account, n]) => ({ account, notes: n }))
      .sort((a, b) => b.notes - a.notes),
    people
  }
}

const fmt = (day: string): string =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Markdown for pasting into a status email, or saving as a note. */
export function rollupMarkdown(r: Rollup): string {
  const L: string[] = []
  const task = (t: RollupTask): string =>
    `- ${t.description}${t.owner !== 'Me' ? ` (${t.owner})` : ''}${t.due ? ` — due ${fmt(t.due)}` : ''}`
  L.push(`## Week of ${fmt(r.weekStart)} – ${fmt(r.weekEnd)}`, '')
  L.push(
    `${r.notes.length} meeting/notes · ${r.completed.length} tasks completed · ${r.createdCount} new tasks · ${r.overdue.length} overdue`,
    ''
  )
  if (r.completed.length) L.push('### Done', ...r.completed.map(task), '')
  if (r.notes.length)
    L.push(
      '### Meetings & notes',
      ...r.notes.map((n) => `- ${fmt(n.date)}: ${n.title}${n.account ? ` (${n.account})` : ''}`),
      ''
    )
  if (r.overdue.length) L.push('### Overdue', ...r.overdue.map(task), '')
  if (r.comingUp.length) L.push('### Coming up next week', ...r.comingUp.map(task), '')
  if (r.waitingOn.length)
    L.push('### Waiting on others', ...r.waitingOn.map((w) => `- ${w.owner}: ${w.count} open`), '')
  return L.join('\n').trimEnd() + '\n'
}
