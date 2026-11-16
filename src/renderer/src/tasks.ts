import type { TaskItem } from '@shared/contract'
import { addDays, dayLabel, shortDate } from './format'

export type TaskFilter = 'mine' | 'today' | 'overdue' | 'waiting' | 'done' | `account:${string}`

export const FILTER_TITLE: Record<Exclude<TaskFilter, `account:${string}`>, string> = {
  mine: 'My Tasks',
  today: 'Due Today',
  overdue: 'Overdue',
  waiting: 'Waiting On',
  done: 'Completed'
}

export const filterTitle = (f: TaskFilter): string =>
  f.startsWith('account:')
    ? f.slice('account:'.length)
    : FILTER_TITLE[f as keyof typeof FILTER_TITLE]

const open = (t: TaskItem): boolean => t.status === 'open'

export function applyFilter(tasks: TaskItem[], f: TaskFilter, today: string): TaskItem[] {
  switch (f) {
    case 'mine':
      return tasks.filter((t) => open(t) && t.isMine)
    case 'today':
      return tasks.filter((t) => open(t) && t.isMine && t.due === today)
    case 'overdue':
      return tasks.filter((t) => open(t) && t.isMine && t.due !== null && t.due < today)
    case 'waiting':
      return tasks.filter((t) => open(t) && !t.isMine)
    case 'done':
      return tasks
        .filter((t) => !open(t))
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    default: {
      const account = f.slice('account:'.length)
      return tasks.filter((t) => open(t) && t.isMine && t.account === account)
    }
  }
}

export interface FilterCounts {
  mine: number
  today: number
  overdue: number
  waiting: number
  accounts: [string, number][]
}

export function countFilters(tasks: TaskItem[], today: string): FilterCounts {
  const acc = new Map<string, number>()
  for (const t of tasks) {
    if (open(t) && t.isMine && t.account) acc.set(t.account, (acc.get(t.account) ?? 0) + 1)
  }
  return {
    mine: applyFilter(tasks, 'mine', today).length,
    today: applyFilter(tasks, 'today', today).length,
    overdue: applyFilter(tasks, 'overdue', today).length,
    waiting: applyFilter(tasks, 'waiting', today).length,
    accounts: [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }
}

export const BUCKETS = ['Overdue', 'Today', 'Next 7 days', 'Later', 'No date'] as const
export type Bucket = (typeof BUCKETS)[number]

export function dueBucket(due: string | null, today: string): Bucket {
  if (!due) return 'No date'
  if (due < today) return 'Overdue'
  if (due === today) return 'Today'
  if (due <= addDays(today, 7)) return 'Next 7 days'
  return 'Later'
}

export type Group = [label: string, tasks: TaskItem[]]

export function groupByDue(tasks: TaskItem[], today: string): Group[] {
  const m = new Map<Bucket, TaskItem[]>()
  for (const t of tasks) {
    const b = dueBucket(t.due, today)
    m.set(b, [...(m.get(b) ?? []), t])
  }
  return BUCKETS.filter((b) => m.has(b)).map((b) => [b, m.get(b)!])
}

/** Waiting-on view: one group per person, longest-waiting first inside and across groups. */
export function groupByOwner(tasks: TaskItem[]): Group[] {
  const m = new Map<string, TaskItem[]>()
  for (const t of tasks) m.set(t.owner, [...(m.get(t.owner) ?? []), t])
  for (const list of m.values()) list.sort((a, b) => a.since.localeCompare(b.since))
  return [...m.entries()]
    .map(([owner, list]): Group => [`@${owner}`, list])
    .sort((a, b) => a[1][0].since.localeCompare(b[1][0].since))
}

export function groupByCompleted(tasks: TaskItem[]): Group[] {
  const m = new Map<string, TaskItem[]>()
  for (const t of tasks) {
    const day = (t.completedAt ?? '').slice(0, 10)
    const label = day ? dayLabel(new Date(t.completedAt!).toLocaleDateString('en-CA')) : 'Earlier'
    m.set(label, [...(m.get(label) ?? []), t])
  }
  return [...m.entries()]
}

export function daysSince(since: string, today: string): number {
  const a = new Date(`${since}T12:00:00`).getTime()
  const b = new Date(`${today}T12:00:00`).getTime()
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

/** Plain-text nudge for chat or email. (A Gmail draft arrives with the Gmail integration.) */
export function followUpText(t: TaskItem, today: string): string {
  const days = daysSince(t.since, today)
  const age = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
  const due = t.due
    ? t.due < today
      ? ` It was due ${shortDate(t.due)}.`
      : ` It's due ${shortDate(t.due)}.`
    : ''
  return `Hi ${t.owner}, quick follow-up on "${t.description}" (from ${t.noteTitle}, raised ${age}).${due} Do you have an update?`
}
