import { useEffect, useMemo, useRef, useState } from 'react'
import type { EntitySummary, NoteSummary, TaskItem } from '@shared/contract'

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface Item {
  key: string
  group: 'Actions' | 'Notes' | 'Tasks' | 'People & accounts'
  label: string
  hint: string
  run: () => void
}

/** Every typed word must appear; earlier and whole-word matches rank higher. */
function score(label: string, words: string[]): number {
  const l = label.toLowerCase()
  let s = 0
  for (const w of words) {
    const i = l.indexOf(w)
    if (i < 0) return -1
    s += i === 0 ? 3 : l[i - 1] === ' ' ? 2 : 1
  }
  return s
}

const GROUPS: Item['group'][] = ['Actions', 'Notes', 'Tasks', 'People & accounts']

export default function CommandPalette({
  actions,
  notes,
  tasks,
  entities,
  onOpenNote,
  onOpenEntity,
  onClose
}: {
  actions: PaletteAction[]
  notes: NoteSummary[]
  tasks: TaskItem[]
  entities: EntitySummary[]
  onOpenNote: (path: string) => void
  onOpenEntity: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const items = useMemo((): Item[] => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const done = (fn: () => void) => () => {
      onClose()
      fn()
    }
    const all: (Item & { s: number })[] = []
    const add = (it: Omit<Item, 'run'> & { run: () => void }): void => {
      const s = words.length ? score(it.label, words) : 0
      if (s >= 0) all.push({ ...it, run: done(it.run), s })
    }
    for (const a of actions)
      add({ key: 'a:' + a.id, group: 'Actions', label: a.label, hint: a.hint ?? '', run: a.run })
    if (words.length) {
      for (const n of notes.filter((x) => !x.isConflict))
        add({
          key: 'n:' + n.path,
          group: 'Notes',
          label: n.title,
          hint: n.date + (n.account ? ' · ' + n.account : ''),
          run: () => onOpenNote(n.path)
        })
      for (const t of tasks.filter((x) => x.status === 'open'))
        add({
          key: 't:' + t.id,
          group: 'Tasks',
          label: t.description,
          hint: t.owner === 'Me' ? t.noteTitle : `${t.owner} · ${t.noteTitle}`,
          run: () => onOpenNote(t.notePath)
        })
      for (const e of entities)
        add({
          key: 'e:' + e.id,
          group: 'People & accounts',
          label: e.name,
          hint: e.category,
          run: () => onOpenEntity(e.id)
        })
    }
    const cap: Record<Item['group'], number> = {
      Actions: 8,
      Notes: 6,
      Tasks: 6,
      'People & accounts': 5
    }
    const out: Item[] = []
    for (const g of GROUPS)
      out.push(
        ...all
          .filter((x) => x.group === g)
          .sort((a, b) => b.s - a.s)
          .slice(0, cap[g])
      )
    return out
  }, [q, actions, notes, tasks, entities, onOpenNote, onOpenEntity, onClose])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(items.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[sel]?.run()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  let lastGroup = ''
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[14vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="glass w-[34rem] max-w-[92vw] overflow-hidden rounded-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={onKey}
          placeholder="Search notes, tasks and people, or run an action…"
          aria-label="Search"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none"
        />
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
          {items.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted">No matches.</li>
          )}
          {items.map((it, i) => {
            const header = it.group !== lastGroup
            lastGroup = it.group
            return (
              <li key={it.key} role="presentation">
                {header && (
                  <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                    {it.group}
                  </div>
                )}
                <button
                  role="option"
                  aria-selected={i === sel}
                  onMouseEnter={() => setSel(i)}
                  onClick={it.run}
                  className={`flex w-full items-baseline gap-2 rounded-lg px-3 py-1.5 text-left text-sm ${i === sel ? 'bg-accent-soft' : ''}`}
                >
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  <span className="max-w-[40%] truncate text-xs text-muted">{it.hint}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="border-t border-line px-4 py-1.5 text-[11px] text-muted">
          ↑↓ to move · Enter to open · Esc to close
        </div>
      </div>
    </div>
  )
}
