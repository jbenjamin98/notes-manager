import { useEffect, useMemo, useRef, useState } from 'react'
import type { VocabEntry } from '@shared/contract'
import type { EditorCommand, FormatInfo } from '../editor/commands'
import { addDays, todayIso } from '../format'

const base =
  'inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm transition-colors disabled:opacity-35'
const off = 'text-fg hover:bg-hover'
const on = 'bg-accent-soft text-fg'

function Btn({
  label,
  hint,
  active,
  disabled,
  onClick,
  children
}: {
  label: string
  hint?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={hint ? `${label} (${hint})` : label}
      disabled={disabled}
      // Keep the editor's selection: clicking a button must not steal focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`${base} ${active ? on : off}`}
    >
      {children}
    </button>
  )
}

const Sep = (): React.JSX.Element => <span className="mx-1 h-5 w-px bg-line" aria-hidden />

function Pop({
  open,
  onClose,
  children
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      ref={ref}
      className="glass spring-in absolute top-10 left-0 z-30 w-64 rounded-xl p-2 text-sm"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

const nextMonday = (): string => {
  const d = new Date(`${todayIso()}T12:00:00`)
  return addDays(todayIso(), (8 - d.getDay()) % 7 || 7)
}

/**
 * Every formatting and task action as a button, so nothing needs to be memorised. Each one writes
 * the same plain Markdown you could type by hand (hover for the shortcut).
 */
export default function EditorToolbar({
  info,
  vocab,
  run
}: {
  info: FormatInfo
  vocab: VocabEntry[]
  run: (c: EditorCommand) => void
}): React.JSX.Element {
  const [pop, setPop] = useState<null | 'who' | 'due' | 'pri'>(null)
  const [q, setQ] = useState('')
  const people = useMemo(
    () =>
      vocab
        .filter((v) => v.category === 'person')
        .filter((v) => !q || v.name.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 7),
    [vocab, q]
  )
  const close = (): void => {
    setPop(null)
    setQ('')
  }
  const act = (c: EditorCommand): void => {
    run(c)
    close()
  }

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="relative mx-6 mb-2 flex flex-wrap items-center gap-0.5 rounded-xl border border-line bg-surface px-1.5 py-1"
    >
      <Btn label="Undo" hint="Ctrl+Z" onClick={() => run({ type: 'undo' })}>
        ↶
      </Btn>
      <Btn label="Redo" hint="Ctrl+Y" onClick={() => run({ type: 'redo' })}>
        ↷
      </Btn>
      <Sep />
      <Btn
        label="Heading 1"
        hint="Ctrl+Alt+1"
        active={info.heading === 1}
        onClick={() => run({ type: 'heading', level: 1 })}
      >
        <b>H1</b>
      </Btn>
      <Btn
        label="Heading 2"
        hint="Ctrl+Alt+2"
        active={info.heading === 2}
        onClick={() => run({ type: 'heading', level: 2 })}
      >
        <b>H2</b>
      </Btn>
      <Btn
        label="Heading 3"
        hint="Ctrl+Alt+3"
        active={info.heading === 3}
        onClick={() => run({ type: 'heading', level: 3 })}
      >
        <b>H3</b>
      </Btn>
      <Sep />
      <Btn
        label="Bold"
        hint="Ctrl+B"
        active={info.bold}
        onClick={() => run({ type: 'wrap', marker: '**' })}
      >
        <b>B</b>
      </Btn>
      <Btn
        label="Italic"
        hint="Ctrl+I"
        active={info.italic}
        onClick={() => run({ type: 'wrap', marker: '_' })}
      >
        <i>I</i>
      </Btn>
      <Btn
        label="Strikethrough"
        hint="Ctrl+Shift+X"
        active={info.strike}
        onClick={() => run({ type: 'wrap', marker: '~~' })}
      >
        <s>S</s>
      </Btn>
      <Btn
        label="Code"
        hint="Ctrl+E"
        active={info.code}
        onClick={() => run({ type: 'wrap', marker: '`' })}
      >
        <span className="font-mono text-xs">{'</>'}</span>
      </Btn>
      <Btn
        label="Link"
        hint="Ctrl+K in a note is search; use this button"
        onClick={() => run({ type: 'link' })}
      >
        🔗
      </Btn>
      <Sep />
      <Btn
        label="Bulleted list"
        hint="Ctrl+Shift+8"
        active={info.list === 'bullet'}
        onClick={() => run({ type: 'list', kind: 'bullet' })}
      >
        •≡
      </Btn>
      <Btn
        label="Numbered list"
        hint="Ctrl+Shift+7"
        active={info.list === 'number'}
        onClick={() => run({ type: 'list', kind: 'number' })}
      >
        1.
      </Btn>
      <Btn
        label="Task (checkbox)"
        hint="Ctrl+Shift+9"
        active={info.list === 'task'}
        onClick={() => run({ type: 'list', kind: 'task' })}
      >
        ☑
      </Btn>
      <Btn
        label="Quote"
        active={info.list === 'quote'}
        onClick={() => run({ type: 'list', kind: 'quote' })}
      >
        ❝
      </Btn>
      <Sep />
      <span className="relative">
        <Btn
          label={info.onTask ? 'Assign to someone' : 'Mention someone (@)'}
          hint="@"
          active={pop === 'who' || !!info.fields.owner}
          onClick={() => setPop(pop === 'who' ? null : 'who')}
        >
          @
        </Btn>
        <Pop open={pop === 'who'} onClose={close}>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && q.trim())
                act({ type: 'mention', name: people[0]?.name ?? q.trim() })
              if (e.key === 'Escape') close()
            }}
            placeholder={info.onTask ? 'Who owns this?' : 'Who are you mentioning?'}
            aria-label="Person"
            className="mb-1 w-full rounded-lg border border-line bg-field px-2 py-1 text-sm outline-none"
          />
          {info.onTask && (
            <button
              className="w-full rounded-lg px-2 py-1 text-left hover:bg-hover"
              onClick={() => act({ type: 'field', field: 'owner', value: 'Me' })}
            >
              Me
            </button>
          )}
          {people.map((p) => (
            <button
              key={p.id}
              className="w-full rounded-lg px-2 py-1 text-left hover:bg-hover"
              onClick={() => act({ type: 'mention', name: p.name })}
            >
              {p.name}
            </button>
          ))}
          {q.trim() && !people.some((p) => p.name.toLowerCase() === q.trim().toLowerCase()) && (
            <button
              className="w-full rounded-lg px-2 py-1 text-left text-muted hover:bg-hover"
              onClick={() => act({ type: 'mention', name: q.trim() })}
            >
              Use “{q.trim()}”
            </button>
          )}
          {info.onTask && info.fields.owner && (
            <button
              className="mt-1 w-full rounded-lg px-2 py-1 text-left text-muted hover:bg-hover"
              onClick={() => act({ type: 'field', field: 'owner', value: null })}
            >
              Clear owner
            </button>
          )}
        </Pop>
      </span>
      <span className="relative">
        <Btn
          label="Due date"
          hint={info.onTask ? undefined : 'put the cursor on a task'}
          disabled={!info.onTask}
          active={!!info.fields.due}
          onClick={() => setPop(pop === 'due' ? null : 'due')}
        >
          📅
        </Btn>
        <Pop open={pop === 'due'} onClose={close}>
          <div className="grid grid-cols-2 gap-1">
            {[
              ['Today', todayIso()],
              ['Tomorrow', addDays(todayIso(), 1)],
              ['Next Monday', nextMonday()],
              ['In a week', addDays(todayIso(), 7)]
            ].map(([l, d]) => (
              <button
                key={l}
                className="rounded-lg border border-line px-2 py-1 hover:bg-hover"
                onClick={() => act({ type: 'field', field: 'due', value: d })}
              >
                {l}
              </button>
            ))}
          </div>
          <input
            type="date"
            aria-label="Pick a date"
            defaultValue={info.fields.due ?? ''}
            onChange={(e) =>
              e.target.value && act({ type: 'field', field: 'due', value: e.target.value })
            }
            className="mt-2 w-full rounded-lg border border-line bg-field px-2 py-1"
          />
          {info.fields.due && (
            <button
              className="mt-1 w-full rounded-lg px-2 py-1 text-left text-muted hover:bg-hover"
              onClick={() => act({ type: 'field', field: 'due', value: null })}
            >
              Clear date
            </button>
          )}
        </Pop>
      </span>
      <span className="relative">
        <Btn
          label="Priority"
          hint={info.onTask ? undefined : 'put the cursor on a task'}
          disabled={!info.onTask}
          active={!!info.fields.priority}
          onClick={() => setPop(pop === 'pri' ? null : 'pri')}
        >
          !
        </Btn>
        <Pop open={pop === 'pri'} onClose={close}>
          {['High', 'Medium', 'Low'].map((p) => (
            <button
              key={p}
              className="w-full rounded-lg px-2 py-1 text-left hover:bg-hover"
              onClick={() => act({ type: 'field', field: 'priority', value: p })}
            >
              {p}
            </button>
          ))}
          {info.fields.priority && (
            <button
              className="w-full rounded-lg px-2 py-1 text-left text-muted hover:bg-hover"
              onClick={() => act({ type: 'field', field: 'priority', value: null })}
            >
              Clear priority
            </button>
          )}
        </Pop>
      </span>
      <Btn
        label="Estimate (30 minutes)"
        disabled={!info.onTask}
        active={!!info.fields.est}
        onClick={() => run({ type: 'field', field: 'est', value: info.fields.est ? null : '30m' })}
      >
        ⏱
      </Btn>
    </div>
  )
}
