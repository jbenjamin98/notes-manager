import { useMemo, useState } from 'react'
import WaitingView from './WaitingView'
import { useWaiting } from '../hooks'
import SourceChip from './SourceChip'
import type { TaskItem } from '@shared/contract'
import { parseQuickAdd } from '@shared/quickadd'
import { shortDate, todayIso } from '../format'
import { nudgeTask } from '../nudge'
import {
  applyFilter,
  daysSince,
  filterTitle,
  groupByCompleted,
  groupByDue,
  groupByOwner,
  type Group,
  type TaskFilter
} from '../tasks'

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
      ? 'Ask Sarah for the firewall update by Friday @Sarah'
      : 'Add a task…  e.g. Send deck to Joe tomorrow @Joe !high'

  const submit = async (): Promise<void> => {
    if (!parsed?.description || busy) return
    setBusy(true)
    const r = await window.api.invoke('tasks:quick-add', { text })
    setBusy(false)
    if (!r.ok) return onFlash(r.error.message)
    setText('')
    const who = r.data.owner !== 'Me' ? ` for @${r.data.owner}` : ''
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
            {parsed.owner !== 'Me' && <Chip>@{parsed.owner}</Chip>}
            {parsed.due && <Chip>Due {shortDate(parsed.due)}</Chip>}
            {parsed.priority && <Chip>{parsed.priority} priority</Chip>}
            {parsed.estMinutes && <Chip>{parsed.estMinutes} min</Chip>}
            <span className="text-xs text-muted">Enter to add</span>
          </>
        ) : (
          <span className="text-xs text-muted">
            Use <b>@name</b> to assign, <b>!high</b> for priority, <b>~30m</b> for effort. Dates
            like “tomorrow” or “next Thursday” just work.
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

const EMPTY: Record<string, string> = {
  mine: 'Nothing on your plate. Add a task above, or write one in a note.',
  today: 'Nothing due today.',
  overdue: 'Nothing overdue. Nice.',
  waiting:
    'You are not waiting on anyone. When someone else owns an action (@Sarah …), it is saved here as a note.',
  done: 'Completed tasks from the last 30 days appear here.'
}

export default function TasksView({
  tasks,
  filter,
  onToggle,
  onOpenNote,
  onSetDue,
  onFlash
}: {
  tasks: TaskItem[]
  filter: TaskFilter
  onToggle: (id: string, done: boolean) => void
  onOpenNote: (path: string) => void
  onSetDue: (id: string, due: string | null) => void
  onFlash: (m: string) => void
}): React.JSX.Element {
  const today = todayIso()
  const shown = useMemo(() => applyFilter(tasks, filter, today), [tasks, filter, today])
  const groups: Group[] = useMemo(() => {
    if (filter === 'waiting') return groupByOwner(shown)
    if (filter === 'done') return groupByCompleted(shown)
    if (filter === 'overdue' || filter === 'today') return shown.length ? [['', shown]] : []
    return groupByDue(shown, today)
  }, [shown, filter, today])

  const nudge = (t: TaskItem): Promise<void> => nudgeTask(t, today, onFlash)
  const waitingCount = useWaiting().items.length

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-5 pb-3">
        <h1 className="text-2xl font-semibold tracking-tight">{filterTitle(filter)}</h1>
        <p className="mt-1 text-xs text-muted">
          {shown.length} {filter === 'done' ? 'completed' : 'open'}
        </p>
      </header>
      {filter !== 'done' && <QuickAdd filter={filter} onFlash={onFlash} />}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10">
        {filter === 'waiting' && <WaitingView onOpenNote={onOpenNote} onFlash={onFlash} />}
        {filter === 'waiting' && groups.length > 0 && (
          <p className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
            Older Assigned Lines in Your Notes
          </p>
        )}
        {groups.length === 0 && filter === 'waiting' && waitingCount > 0 ? null : groups.length ===
          0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">
            {EMPTY[filter] ?? 'No open tasks for this account.'}
          </p>
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
                    waiting={filter === 'waiting'}
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
