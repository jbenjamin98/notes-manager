import { useState } from 'react'
import SourceChip from './SourceChip'
import type { TaskRow } from '@shared/contract'
import { shortDate, todayIso } from '../format'
import { ChevronIcon } from './Icons'

const PRIORITY_DOT: Record<string, string> = {
  High: 'bg-danger',
  Medium: 'bg-warn',
  Low: 'bg-muted'
}

export default function TaskList({
  tasks,
  onToggle,
  onOpenNote
}: {
  tasks: TaskRow[]
  onToggle: (id: string, done: boolean) => void
  onOpenNote?: (path: string) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  if (tasks.length === 0) return null
  const today = todayIso()
  const openCount = tasks.filter((t) => t.status === 'open').length

  return (
    <section
      className="mx-6 mb-3 rounded-xl border border-line bg-surface"
      aria-label="Tasks in this note"
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 rounded-xl px-4 py-2 text-left text-xs font-medium text-muted hover:text-fg"
        aria-expanded={open}
      >
        <ChevronIcon width={14} height={14} className={open ? '' : '-rotate-90'} />
        Tasks · {openCount} open
      </button>
      {open && (
        <ul className="px-4 pb-2.5">
          {tasks.map((t) => {
            const done = t.status === 'completed'
            const overdue = !done && t.due !== null && t.due < today
            const dueLabel = t.due === today ? 'Today' : t.due ? shortDate(t.due) : ''
            return (
              <li key={t.id} className="group flex items-center gap-3 rounded-md py-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={done}
                  onChange={(e) => onToggle(t.id, e.target.checked)}
                  aria-label={`Mark "${t.description}" ${done ? 'not done' : 'done'}`}
                  className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)]"
                />
                <span
                  className={`min-w-0 flex-1 truncate ${done ? 'text-muted line-through' : ''}`}
                >
                  {t.description}
                </span>
                {t.sourceId && t.sourceLabel && (
                  <SourceChip id={t.sourceId} label={t.sourceLabel} onOpenNote={onOpenNote} />
                )}
                {!t.isMine && (
                  <span
                    className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent"
                    title={
                      t.autoOwner
                        ? 'Detected from the wording. Add "| @Me" to keep it yours.'
                        : undefined
                    }
                  >
                    @{t.owner}
                    {t.autoOwner && ' ✦'}
                  </span>
                )}
                {dueLabel && (
                  <span
                    className={`text-xs tabular-nums ${overdue ? 'font-medium text-danger' : 'text-muted'}`}
                  >
                    {overdue ? `Overdue · ${dueLabel}` : dueLabel}
                    {t.autoDue && ' ✦'}
                  </span>
                )}
                {t.priority && (
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[t.priority]}`}
                    title={`${t.priority} priority`}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
