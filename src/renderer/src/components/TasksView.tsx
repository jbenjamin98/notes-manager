import { useMemo, useState } from 'react'
import WaitingView from './WaitingView'
import { useWaiting } from '../hooks'
import SourceChip from './SourceChip'
import CategoryIcon, { type CategoryKind } from './CategoryIcon'
import type { TaskItem } from '@shared/contract'
import { parseQuickAdd } from '@shared/quickadd'
import { shortDate, todayIso } from '../format'
import { nudgeTask } from '../nudge'
import {
  applyFilter,
  daysSince,
  groupByCompleted,
  groupByDue,
  groupByOwner,
  searchTasks,
  SORT_LABEL,
  sortTasks,
  countFilters,
  type Group,
  type TaskFilter,
  type TaskSort
} from '../tasks'
import { useNavState } from '../nav'

const PRIORITY_DOT: Record<string, string> = {
  High: 'bg-danger',
  Medium: 'bg-warn',
  Low: 'bg-muted'
}

function Chip({
  children,
  tone = 'bg-accent-soft text-accent'
}: {
  children: React.ReactNode
  tone?: string
}): React.JSX.Element {
  return <span className={`rounded-full px-2 py-0.5 text-xs ${tone}`}>{children}</span>
}

/** Quick-add: type naturally, see how it will be understood, press Enter. */
function QuickAdd({
  filter,
  onFlash
}: {
  filter: TaskFilter
  onFlash: (m: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const parsed = useMemo(() => (text.trim() ? parseQuickAdd(text) : null), [text])

  const placeholder =
    filter === 'waiting'
      ? 'waiting on Sarah: the firewall update by Friday'
      : 'Add a task…  e.g. Send the deck for @Acme tomorrow !high'

  const submit = async (): Promise<void> => {
    if (!parsed?.description || busy) return
    setBusy(true)
    const r = await window.api.invoke('tasks:quick-add', { text })
    setBusy(false)
    if (!r.ok) return onFlash(r.error.message)
    setText('')
    const who = r.data.kind === 'waiting' ? ` to Waiting On (${r.data.owner})` : ''
    onFlash(`Added${who}${r.data.due ? ` · due ${shortDate(r.data.due)}` : ''}`)
  }

  return (
    <div className="px-6 pb-3">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        placeholder={placeholder}
        aria-label="Add a task"
        className="w-full rounded-xl border border-line bg-field px-4 py-2.5 text-sm shadow-sm placeholder:text-muted"
      />
      <div className="mt-2 flex min-h-6 flex-wrap items-center gap-1.5">
        {parsed?.description ? (
          <>
            {parsed.due && <Chip>Due {shortDate(parsed.due)}</Chip>}
            {parsed.priority && <Chip>{parsed.priority} priority</Chip>}
            {parsed.estMinutes && <Chip>{parsed.estMinutes} min</Chip>}
            <span className="text-xs text-muted">Enter to add</span>
          </>
        ) : (
          <span className="text-xs text-muted">
            Tasks are always yours: <b>@name</b> says who or what one is about, <b>!high</b> sets
            priority, <b>~30m</b> effort. Dates like “tomorrow” just work.
          </span>
        )}
      </div>
    </div>
  )
}

function DueChip({
  task,
  today,
  onSetDue
}: {
  task: TaskItem
  today: string
  onSetDue: (id: string, due: string | null) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const done = task.status === 'completed'
  const overdue = !done && task.due !== null && task.due < today

  if (editing) {
    return (
      <span className="flex items-center gap-1">
        <input
          type="date"
          autoFocus
          defaultValue={task.due ?? ''}
          onChange={(e) => {
            if (e.target.value) {
              onSetDue(task.id, e.target.value)
              setEditing(false)
            }
          }}
          onBlur={() => setEditing(false)}
          aria-label="Due date"
          className="rounded-md border border-line bg-field px-1.5 py-0.5 text-xs"
        />
        {task.due && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onSetDue(task.id, null)
              setEditing(false)
            }}
            className="text-xs text-muted hover:text-fg"
            aria-label="Clear due date"
          >
            Clear
          </button>
        )}
      </span>
    )
  }
  const label = task.due === today ? 'Today' : task.due ? shortDate(task.due) : 'Set date'
  return (
    <button
      onClick={() => setEditing(true)}
      disabled={done}
      title={task.autoDue ? 'Detected from the wording. Click to change it.' : 'Change due date'}
      className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent ${
        overdue ? 'font-medium text-danger' : task.due ? 'text-muted' : 'text-muted/60'
      }`}
    >
      {overdue ? `Overdue · ${label}` : label}
      {task.autoDue && ' ✦'}
    </button>
  )
}

const SPARK_COLORS = ['#6a63f0', '#f472b6', '#38bdf8', '#34d399', '#fbbf24', '#fb923c']
const SPARKS = Array.from({ length: 8 }, (_, i) => {
  const a = (Math.PI * 2 * i) / 8
  return { dx: Math.cos(a) * 16, dy: Math.sin(a) * 16, c: SPARK_COLORS[i % SPARK_COLORS.length] }
})

function Row({
  task,
  today,
  waiting,
  onToggle,
  onOpenNote,
  onSetDue,
  onNudge
}: {
  task: TaskItem
  today: string
  waiting: boolean
  onToggle: (id: string, done: boolean) => void
  onOpenNote: (path: string) => void
  onSetDue: (id: string, due: string | null) => void
  onNudge: (t: TaskItem) => void
}): React.JSX.Element {
  const [burst, setBurst] = useState(0)
  const done = task.status === 'completed'
  const days = daysSince(task.since, today)
  const waitTone =
    days >= 7
      ? 'bg-danger/10 text-danger'
      : days >= 3
        ? 'bg-warn/15 text-warn'
        : 'bg-hover text-muted'

  return (
    <li className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={done}
          onChange={(e) => {
            if (e.target.checked) setBurst((n) => n + 1)
            onToggle(task.id, e.target.checked)
          }}
          aria-label={`Mark "${task.description}" ${done ? 'not done' : 'done'}`}
          className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
        />
        {burst > 0 && done && (
          <span className="burst" key={burst} aria-hidden>
            {SPARKS.map((s, i) => (
              <i
                key={i}
                style={
                  { '--dx': `${s.dx}px`, '--dy': `${s.dy}px`, '--c': s.c } as React.CSSProperties
                }
              />
            ))}
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`task-text truncate text-sm ${done ? 'text-muted line-through' : ''}`}>
          {task.description}
        </div>
        {task.sourceId && task.sourceLabel && (
          <SourceChip
            id={task.sourceId}
            label={task.sourceLabel}
            onOpenNote={onOpenNote}
            className="mr-2 mb-0.5"
          />
        )}
        {(task.entities?.length ?? 0) > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1" aria-label="This task is about">
            {task.entities!.slice(0, 5).map((e) => (
              <span
                key={e.id}
                title={`About ${e.name}`}
                className="flex items-center gap-1 rounded-full bg-hover py-px pr-2 pl-0.5 text-[11px] text-muted"
              >
                <CategoryIcon kind={e.category as CategoryKind} size={14} />
                {e.name}
              </span>
            ))}
          </div>
        )}
        <button
          onClick={() => onOpenNote(task.notePath)}
          className="max-w-full truncate text-left text-xs text-muted hover:text-accent hover:underline"
          title="Open the note this task came from"
        >
          {task.noteTitle}
          {task.account ? ` · ${task.account}` : ''}
        </button>
      </div>
      {waiting && !done && (
        <>
          <Chip tone={waitTone}>
            {days === 0 ? 'New' : `Waiting ${days} day${days === 1 ? '' : 's'}`}
          </Chip>
          <button
            onClick={() => onNudge(task)}
            className="rounded-md border border-line bg-field px-2 py-0.5 text-xs font-medium opacity-70 hover:bg-hover hover:opacity-100 focus-visible:opacity-100"
            title="Draft a follow-up in Gmail"
          >
            Nudge
          </button>
        </>
      )}
      {!waiting && !task.isMine && (
        <span
          title={
            task.autoOwner
              ? 'Detected from the wording. Add "| @Me" in the note to keep it yours.'
              : undefined
          }
        >
          <Chip>
            @{task.owner}
            {task.autoOwner && ' ✦'}
          </Chip>
        </span>
      )}
      <DueChip task={task} today={today} onSetDue={onSetDue} />
      {task.priority && (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[task.priority]}`}
          title={`${task.priority} priority`}
        />
      )}
    </li>
  )
}

const ABOUT_LABEL: Record<string, string> = {
  person: 'People',
  customer: 'Companies',
  project: 'Projects',
  system: 'Systems',
  place: 'Places',
  topic: 'Topics'
}

const EMPTY: Record<string, string> = {
  mine: 'Nothing on your plate. Add a task above, or write one in a note.',
  today: 'Nothing due today.',
  overdue: 'Nothing overdue. Nice.',
  waiting:
    'You are not waiting on anyone. Type “waiting on Sarah: …” in Quick Add to save one here as a note.',
  done: 'Completed tasks from the last 30 days appear here.'
}

type Priority = 'all' | 'High' | 'Medium' | 'Low'

const STATUS: { f: TaskFilter; label: string }[] = [
  { f: 'mine', label: 'Open' },
  { f: 'today', label: 'Today' },
  { f: 'overdue', label: 'Overdue' },
  { f: 'waiting', label: 'Waiting' },
  { f: 'done', label: 'Done' }
]

const selectCls =
  'rounded-lg border border-line bg-field px-2.5 py-1.5 text-xs text-fg hover:bg-hover focus-visible:outline-none'

function SearchIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden className="text-muted">
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M13.5 13.5 17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The task list. On the Tasks page it has the whole toolbar (status, search, sort, priority,
 * about, account). On the dashboard (`dashboard`) it is a quiet list of open tasks with quick add.
 */
export default function TasksView({
  tasks,
  filter,
  onToggle,
  onOpenNote,
  onSetDue,
  onFlash,
  onPickFilter,
  dashboard = false,
  onViewAll
}: {
  tasks: TaskItem[]
  filter: TaskFilter
  onPickFilter?: (f: TaskFilter) => void
  /** The compact dashboard list: open tasks only, no toolbar. */
  dashboard?: boolean
  onViewAll?: () => void
  onToggle: (id: string, done: boolean) => void
  onOpenNote: (path: string) => void
  onSetDue: (id: string, due: string | null) => void
  onFlash: (m: string) => void
}): React.JSX.Element {
  const today = todayIso()
  const activeFilter: TaskFilter = dashboard ? 'mine' : filter
  // "About": only tasks that concern a kind of thing (people, companies...) or one name.
  const [about, setAbout] = useState('')
  const [prio, setPrio] = useState<Priority>('all')
  const [query, setQuery] = useNavState('dash.query', '')
  const [sort, setSort] = useNavState<TaskSort>('dash.sort', 'due')
  const waitingCount = useWaiting().items.length
  const counts = useMemo(() => countFilters(tasks, today), [tasks, today])
  const base = useMemo(() => applyFilter(tasks, activeFilter, today), [tasks, activeFilter, today])
  const shown = useMemo(() => {
    if (dashboard) return base
    let list = base
    if (about)
      list = list.filter((t) =>
        (t.entities ?? []).some((e) =>
          about.startsWith('cat:') ? e.category === about.slice(4) : e.id === about.slice(4)
        )
      )
    if (prio !== 'all') list = list.filter((t) => t.priority === prio)
    return sortTasks(searchTasks(list, query), sort)
  }, [base, about, prio, query, sort, dashboard])
  const aboutOptions = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; category: string }>()
    for (const t of base) for (const e of t.entities ?? []) seen.set(e.id, e)
    const byCat = new Map<string, { id: string; name: string; category: string }[]>()
    for (const e of seen.values()) byCat.set(e.category, [...(byCat.get(e.category) ?? []), e])
    return [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [base])
  const groups: Group[] = useMemo(() => {
    if (activeFilter === 'waiting') return groupByOwner(shown)
    if (activeFilter === 'done') return groupByCompleted(shown)
    if (activeFilter === 'overdue' || activeFilter === 'today' || (!dashboard && sort !== 'due'))
      return shown.length ? [['', shown]] : []
    return groupByDue(shown, today)
  }, [shown, activeFilter, today, sort, dashboard])

  const nudge = (t: TaskItem): Promise<void> => nudgeTask(t, today, onFlash)
  const account = activeFilter.startsWith('account:') ? activeFilter.slice('account:'.length) : ''
  const filtering = !!(query || about || prio !== 'all' || account)
  const clearAll = (): void => {
    setQuery('')
    setAbout('')
    setPrio('all')
    if (account) onPickFilter?.('mine')
  }

  return (
    <div className="flex h-full flex-col" data-testid={dashboard ? 'tasks-compact' : 'tasks-page'}>
      <header className="flex flex-wrap items-end gap-x-4 gap-y-1 px-6 pt-5 pb-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {dashboard ? 'Open Tasks' : 'Tasks'}
        </h1>
        {dashboard ? (
          <>
            <p className="pb-1 text-xs text-muted">{shown.length} open</p>
            {onViewAll && (
              <button
                onClick={onViewAll}
                className="ml-auto pb-1 text-xs font-medium text-accent hover:underline"
              >
                View all tasks →
              </button>
            )}
          </>
        ) : (
          <p className="flex flex-wrap gap-1.5 pb-1 text-xs">
            <span className="rounded-full bg-hover px-2 py-0.5 text-muted">{counts.mine} open</span>
            {counts.today > 0 && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">
                {counts.today} due today
              </span>
            )}
            {counts.overdue > 0 && (
              <span className="rounded-full bg-danger/10 px-2 py-0.5 text-danger">
                {counts.overdue} overdue
              </span>
            )}
          </p>
        )}
      </header>
      {activeFilter !== 'done' && <QuickAdd filter={activeFilter} onFlash={onFlash} />}

      {!dashboard && onPickFilter && (
        <div className="card-modern mx-6 mb-3 space-y-2.5 p-3" data-testid="tasks-toolbar">
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Show"
              className="flex rounded-full border border-line bg-field/70 p-0.5 text-xs font-semibold"
            >
              {STATUS.map(({ f, label }) => {
                const on = f === 'mine' ? activeFilter === 'mine' || !!account : activeFilter === f
                const n =
                  f === 'mine'
                    ? counts.mine
                    : f === 'today'
                      ? counts.today
                      : f === 'overdue'
                        ? counts.overdue
                        : f === 'waiting'
                          ? counts.waiting + waitingCount
                          : 0
                return (
                  <button
                    key={f}
                    data-testid={`task-chip-${f}`}
                    aria-pressed={on}
                    onClick={() => onPickFilter(f)}
                    className={`rounded-full px-3 py-1 transition-colors ${
                      on
                        ? 'bg-accent-soft text-accent'
                        : f === 'overdue' && n > 0
                          ? 'text-danger hover:bg-hover'
                          : 'text-muted hover:text-fg'
                    }`}
                  >
                    {label}
                    {n > 0 && <span className="ml-1 tabular-nums opacity-80">{n}</span>}
                  </button>
                )
              })}
            </div>
            <div className="ml-auto flex min-w-48 flex-1 items-center gap-2 rounded-lg border border-line bg-field px-2.5 focus-within:border-accent sm:max-w-xs">
              <SearchIcon />
              <input
                type="search"
                data-testid="tasks-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tasks, notes, people…"
                aria-label="Search tasks"
                className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-fg placeholder:text-muted focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  aria-label="Clear search"
                  className="text-muted hover:text-fg"
                  onClick={() => setQuery('')}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <label htmlFor="tasks-sort">Sort</label>
            <select
              id="tasks-sort"
              data-testid="tasks-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as TaskSort)}
              className={selectCls}
            >
              {(Object.keys(SORT_LABEL) as TaskSort[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
            <span className="mx-1 h-4 w-px bg-line" aria-hidden />
            <span>Priority</span>
            <div role="group" aria-label="Priority" className="flex gap-1">
              {(['all', 'High', 'Medium', 'Low'] as Priority[]).map((p) => (
                <button
                  key={p}
                  aria-pressed={prio === p}
                  data-testid={`prio-${p}`}
                  onClick={() => setPrio(p)}
                  className={`rounded-full border px-2.5 py-0.5 font-medium ${
                    prio === p
                      ? 'border-transparent bg-accent-soft text-accent'
                      : 'border-line bg-field hover:bg-hover'
                  }`}
                >
                  {p === 'all' ? 'Any' : p}
                </button>
              ))}
            </div>
            {aboutOptions.length > 0 && (
              <>
                <span className="mx-1 h-4 w-px bg-line" aria-hidden />
                <label htmlFor="tasks-about">About</label>
                <select
                  id="tasks-about"
                  data-testid="tasks-about"
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  className={selectCls}
                >
                  <option value="">Anything</option>
                  {aboutOptions.map(([cat, list]) => (
                    <optgroup key={cat} label={ABOUT_LABEL[cat] ?? cat}>
                      <option value={`cat:${cat}`}>
                        All {(ABOUT_LABEL[cat] ?? cat).toLowerCase()}
                      </option>
                      {list
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((e) => (
                          <option key={e.id} value={`ent:${e.id}`}>
                            {e.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </>
            )}
            {counts.accounts.length > 0 && (
              <>
                <span className="mx-1 h-4 w-px bg-line" aria-hidden />
                <label htmlFor="tasks-account">Account</label>
                <select
                  id="tasks-account"
                  data-testid="tasks-account"
                  value={account}
                  onChange={(e) =>
                    onPickFilter(e.target.value ? `account:${e.target.value}` : 'mine')
                  }
                  className={selectCls}
                >
                  <option value="">All</option>
                  {counts.accounts.map(([name, n]) => (
                    <option key={name} value={name}>
                      {name} ({n})
                    </option>
                  ))}
                </select>
              </>
            )}
            <span className="flex-1" />
            {filtering && (
              <>
                <span data-testid="tasks-count">
                  {shown.length} of {base.length}
                </span>
                <button className="font-medium text-accent hover:underline" onClick={clearAll}>
                  Clear filters
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10">
        {activeFilter === 'waiting' && <WaitingView onOpenNote={onOpenNote} onFlash={onFlash} />}
        {activeFilter === 'waiting' && groups.length > 0 && (
          <p className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
            Older Assigned Lines in Your Notes
          </p>
        )}
        {groups.length === 0 &&
        activeFilter === 'waiting' &&
        waitingCount > 0 ? null : groups.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted">
            <p>
              {filtering
                ? 'No tasks match these filters.'
                : (EMPTY[activeFilter] ?? 'No open tasks for this account.')}
            </p>
            {filtering && (
              <button className="mt-2 font-medium text-accent hover:underline" onClick={clearAll}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          groups.map(([label, list]) => (
            <section
              key={label || 'all'}
              className={`card-modern mb-4 overflow-hidden p-2 ${label === 'Overdue' ? 'ring-1 ring-danger/25' : ''}`}
            >
              {label && (
                <h2
                  className={`flex items-center gap-2 px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.12em] uppercase ${
                    label === 'Overdue' ? 'text-danger' : 'text-muted'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${label === 'Overdue' ? 'bg-danger' : label === 'Today' ? 'bg-accent' : 'bg-muted'}`}
                  />
                  {label}
                  <span className="ml-auto rounded-full bg-hover px-1.5 font-semibold tabular-nums">
                    {list.length}
                  </span>
                </h2>
              )}
              <ul>
                {list.map((t) => (
                  <Row
                    key={t.id}
                    task={t}
                    today={today}
                    waiting={activeFilter === 'waiting'}
                    onToggle={onToggle}
                    onOpenNote={onOpenNote}
                    onSetDue={onSetDue}
                    onNudge={(x) => void nudge(x)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

export { Row as TaskRowItem }
