import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteEntity, NoteSummary } from '@shared/contract'
import { groupNotes, LIBRARY_VIEWS, type LibNote, type LibraryView } from '@shared/library'
import { shortDate } from '../format'

const VIEW_KEY = 'nm-library-view'
const readView = (): LibraryView => {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return LIBRARY_VIEWS.some((x) => x.id === v) ? (v as LibraryView) : 'newest'
  } catch {
    return 'newest'
  }
}

const CATS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'person', label: 'People' },
  { id: 'customer', label: 'Accounts' },
  { id: 'system', label: 'Systems' },
  { id: 'topic', label: 'Topics' }
]
const TYPES: { id: string; label: string }[] = [
  { id: 'all', label: 'All notes' },
  { id: 'meeting', label: 'Meetings' },
  { id: 'adhoc', label: 'Other notes' }
]

const chip = (on: boolean): string =>
  `rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
    on
      ? 'border-transparent bg-accent-soft text-fg'
      : 'border-line text-muted hover:bg-hover hover:text-fg'
  }`

function NoteRow({
  n,
  i,
  onOpen
}: {
  n: LibNote
  i: number
  onOpen: (p: string) => void
}): React.JSX.Element {
  return (
    <li className="lib-item" style={{ animationDelay: `${Math.min(i, 14) * 22}ms` }}>
      <button
        onClick={() => onOpen(n.path)}
        className="flex w-full items-baseline gap-3 rounded-lg px-3 py-1.5 text-left text-sm hover:bg-hover"
      >
        <span className="w-14 shrink-0 text-xs text-muted tabular-nums">{shortDate(n.date)}</span>
        <span className="min-w-0 flex-1 truncate">
          {n.title}
          {n.isConflict && <span className="text-warn"> · conflict copy</span>}
        </span>
        {n.account && (
          <span className="hidden shrink-0 text-xs text-muted sm:inline">{n.account}</span>
        )}
        {n.type === 'meeting' && (
          <span className="shrink-0 rounded-full border border-line px-1.5 text-[10px] text-muted">
            meeting
          </span>
        )}
        {n.openTasks > 0 && (
          <span className="shrink-0 rounded-full bg-hover px-1.5 text-xs text-muted tabular-nums">
            {n.openTasks} open
          </span>
        )}
      </button>
    </li>
  )
}

export default function LibraryView({
  notes,
  onOpen
}: {
  notes: NoteSummary[]
  onOpen: (path: string) => void
}): React.JSX.Element {
  const [view, setViewState] = useState<LibraryView>(readView)
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')
  const [q, setQ] = useState('')
  const [type, setType] = useState('all')
  const [cat, setCat] = useState('all')
  // null = untouched: the first few groups start open
  const [open, setOpen] = useState<Set<string> | null>(null)
  const [entityMap, setEntityMap] = useState<Map<string, NoteEntity[]>>(new Map())
  const idx = LIBRARY_VIEWS.findIndex((v) => v.id === view)
  const prevIdx = useRef(idx)

  const setView = (v: LibraryView): void => {
    const next = LIBRARY_VIEWS.findIndex((x) => x.id === v)
    setDir(next >= prevIdx.current ? 'fwd' : 'back')
    prevIdx.current = next
    setOpen(null)
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    let alive = true
    void window.api.invoke('notes:entity-map').then((r) => {
      if (!alive || !r.ok) return
      setEntityMap(new Map(r.data.map((x) => [x.path, x.entities as unknown as NoteEntity[]])))
    })
    return () => {
      alive = false
    }
  }, [notes])

  const libNotes = useMemo<LibNote[]>(
    () =>
      notes.map((n) => ({
        path: n.path,
        title: n.title,
        date: n.date,
        type: n.type,
        account: n.account,
        openTasks: n.openTasks,
        isConflict: n.isConflict,
        entities: (entityMap.get(n.path) ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          category: e.category
        }))
      })),
    [notes, entityMap]
  )

  const groups = useMemo(
    () =>
      groupNotes(view, libNotes, {
        query: q,
        type: view === 'meetings' ? 'meeting' : type,
        category: cat
      }),
    [view, libNotes, q, type, cat]
  )
  const total = useMemo(() => libNotes.filter((n) => n.type !== 'inbox').length, [libNotes])

  // Grouped views fold away (a long list of people would be a wall); the flat ones stay open.
  const collapsible = view === 'people' || view === 'subjects' || view === 'meetings'
  const openSet = open ?? new Set(groups.slice(0, 3).map((g) => g.key))
  const isOpen = (key: string): boolean => !collapsible || q.trim() !== '' || openSet.has(key)
  const toggle = (key: string): void => {
    const next = new Set(openSet)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpen(next)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <header className="mb-4">
          <h1 className="text-2xl font-semibold tracking-tight">All notes</h1>
          <p className="mt-1 text-xs text-muted">
            {total} note{total === 1 ? '' : 's'}, all kept in your notes folder. Nothing here is
            ever removed or hidden because it is old.
          </p>
        </header>

        {/* View switcher with a sliding pill */}
        <div
          className="relative mb-2 grid grid-cols-6 rounded-xl border border-line bg-surface p-1"
          role="tablist"
          aria-label="Ways to look at your notes"
        >
          <span
            aria-hidden
            className="lib-pill absolute top-1 bottom-1 left-1 rounded-lg bg-field shadow-sm"
            style={{ width: 'calc((100% - 0.5rem) / 6)', transform: `translateX(${idx * 100}%)` }}
          />
          {LIBRARY_VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={v.id === view}
              title={v.hint}
              onClick={() => setView(v.id)}
              className={`relative z-[1] truncate rounded-lg px-1 py-1.5 text-xs font-medium transition-colors sm:text-sm ${v.id === view ? 'text-fg' : 'text-muted hover:text-fg'}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <p className="mb-3 px-1 text-xs text-muted">{LIBRARY_VIEWS[idx].hint}</p>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by title, account or name"
            aria-label="Filter notes"
            className="min-w-48 flex-1 rounded-lg border border-line bg-field px-3 py-1.5 text-sm placeholder:text-muted"
          />
          {view !== 'meetings' && view !== 'people' && (
            <span className="flex gap-1">
              {TYPES.map((t) => (
                <button key={t.id} className={chip(type === t.id)} onClick={() => setType(t.id)}>
                  {t.label}
                </button>
              ))}
            </span>
          )}
          {view === 'people' && (
            <span className="flex gap-1">
              {CATS.map((c) => (
                <button key={c.id} className={chip(cat === c.id)} onClick={() => setCat(c.id)}>
                  {c.label}
                </button>
              ))}
            </span>
          )}
        </div>

        {/* Re-keyed on every switch so the whole panel slides in from the direction of travel */}
        <div key={view} className={dir === 'fwd' ? 'lib-in-fwd' : 'lib-in-back'}>
          {groups.length === 0 && (
            <p className="py-12 text-center text-sm text-muted">
              {q
                ? 'No notes match that filter.'
                : view === 'tasks'
                  ? 'No note has open tasks. Nice.'
                  : 'Nothing to show here yet.'}
            </p>
          )}
          {groups.map((g) => {
            const shown = isOpen(g.key)
            return (
              <section key={g.key} className="mb-4">
                <button
                  className={`mb-1 flex w-full items-baseline gap-2 px-1 text-left ${collapsible ? 'cursor-pointer' : 'cursor-default'}`}
                  onClick={() => collapsible && toggle(g.key)}
                  aria-expanded={collapsible ? shown : undefined}
                >
                  {collapsible && (
                    <span
                      className={`inline-block text-xs text-muted transition-transform ${shown ? 'rotate-90' : ''}`}
                    >
                      ▸
                    </span>
                  )}
                  <h2 className="text-sm font-semibold">{g.label}</h2>
                  <span className="text-xs text-muted">{g.sub}</span>
                </button>
                {shown && (
                  <ul className="rounded-2xl border border-line bg-surface p-1">
                    {g.notes.map((n, i) => (
                      <NoteRow key={n.path + g.key} n={n} i={i} onOpen={onOpen} />
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
