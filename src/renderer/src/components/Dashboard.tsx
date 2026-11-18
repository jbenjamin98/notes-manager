import { useEffect, useMemo, useState } from 'react'
import type {
  GmailOverview,
  NoteEntity,
  NoteSummary,
  TaskItem,
  UpcomingEvent
} from '@shared/contract'
import { groupNotes, type LibGroup, type LibNote } from '@shared/library'
import { addDays, fmtTime, shortDate, todayIso } from '../format'
import { useCountUp } from '../countUp'
import { useNavState } from '../nav'
import { useWaiting } from '../hooks'
import CategoryIcon, { type CategoryKind } from './CategoryIcon'

type ViewId =
  'weeks' | 'meetings' | 'customer' | 'project' | 'person' | 'system' | 'place' | 'topic' | 'tasks'

interface ViewDef {
  id: ViewId
  title: string
  hint: string
  icon: CategoryKind
  /** Entity categories can be managed (merge, rename...). */
  manage?: boolean
}

const VIEWS: ViewDef[] = [
  { id: 'weeks', title: 'By Week', hint: 'What happened, and when', icon: 'weeks' },
  { id: 'meetings', title: 'Meetings', hint: 'Recurring series together', icon: 'meetings' },
  {
    id: 'customer',
    title: 'Companies',
    hint: 'Customers, vendors, partners',
    icon: 'customer',
    manage: true
  },
  {
    id: 'project',
    title: 'Projects',
    hint: 'Efforts and workstreams',
    icon: 'project',
    manage: true
  },
  { id: 'person', title: 'People', hint: 'Who you work with', icon: 'person', manage: true },
  { id: 'system', title: 'Systems', hint: 'Tools and platforms', icon: 'system', manage: true },
  { id: 'place', title: 'Places', hint: 'Sites and locations', icon: 'place', manage: true },
  { id: 'topic', title: 'Topics', hint: 'Your #tags', icon: 'topic' },
  { id: 'tasks', title: 'Needs Action', hint: 'Notes with open tasks', icon: 'tasks' }
]

const card = 'lib-item card-modern card-hover p-5 text-left'

function groupsFor(id: ViewId, notes: LibNote[]): LibGroup[] {
  if (id === 'weeks') return groupNotes('weeks', notes)
  if (id === 'meetings') return groupNotes('meetings', notes)
  if (id === 'tasks') return groupNotes('tasks', notes)
  return groupNotes('people', notes, { category: id })
}

function Stat({
  label,
  value,
  sub,
  onClick,
  tone
}: {
  label: string
  value: number
  sub: string
  onClick: () => void
  tone?: 'warn'
}): React.JSX.Element {
  const shown = useCountUp(value)
  return (
    <button onClick={onClick} className={card}>
      <div className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</div>
      <div
        className={`mt-1 text-4xl font-semibold tabular-nums ${tone === 'warn' && value > 0 ? 'text-warn' : ''}`}
      >
        {shown}
      </div>
      <div className="mt-1 line-clamp-2 text-sm leading-snug text-muted">{sub}</div>
    </button>
  )
}

function NoteCard({
  n,
  onOpen,
  delay
}: {
  n: LibNote
  onOpen: (p: string) => void
  delay: number
}): React.JSX.Element {
  return (
    <button
      onClick={() => onOpen(n.path)}
      className={card}
      style={{ animationDelay: `${Math.min(delay, 12) * 28}ms` }}
    >
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-base leading-snug font-semibold">{n.title}</h3>
        {n.openTasks > 0 && (
          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs">
            {n.openTasks} open
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-muted">
        {shortDate(n.date)}
        {n.account ? ` · ${n.account}` : ''}
        {n.type === 'meeting' ? ' · meeting' : ''}
        {n.isConflict ? ' · conflict copy' : ''}
      </div>
      {n.entities.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {n.entities.slice(0, 4).map((e) => (
            <span
              key={e.id}
              className="rounded-full border border-line px-2 py-0.5 text-xs text-muted"
            >
              {e.name}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}

/**
 * One calm page for everything: what needs you today, then your notes as cards. Pick a way of
 * looking (week, company, person...), pick a bucket, and the notes in it appear. Nothing is dense.
 */
export default function Dashboard({
  notes,
  tasks,
  upcoming,
  mail,
  onOpenNote,
  onOpenEntity,
  onTasks,
  onEmail,
  onRollup,
  onManage
}: {
  notes: NoteSummary[]
  tasks: TaskItem[]
  upcoming: UpcomingEvent[]
  mail: GmailOverview | null
  onOpenNote: (path: string) => void
  onOpenEntity: (id: string) => void
  onTasks: (filter: string) => void
  onEmail: () => void
  onRollup: () => void
  onInsights?: () => void
  onManage: (category: string) => void
}): React.JSX.Element {
  const [view, setView] = useNavState<ViewId | null>('library.view', null)
  const [bucket, setBucket] = useNavState<string | null>('library.bucket', null)
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')
  const [q, setQ] = useState('')
  const [bodyHits, setBodyHits] = useState<Set<string>>(new Set())
  const [entityMap, setEntityMap] = useState<Map<string, NoteEntity[]>>(new Map())
  const [limit, setLimit] = useState(48)

  useEffect(() => {
    let alive = true
    void window.api.invoke('notes:entity-map').then((r) => {
      if (alive && r.ok)
        setEntityMap(new Map(r.data.map((x) => [x.path, x.entities as unknown as NoteEntity[]])))
    })
    return () => {
      alive = false
    }
  }, [notes])

  useEffect(() => {
    const text = q.trim()
    let alive = true
    const t = setTimeout(
      () => {
        if (text.length < 3) return setBodyHits(new Set())
        void window.api.invoke('notes:search', { query: text }).then((r) => {
          if (alive && r.ok) setBodyHits(new Set(r.data))
        })
      },
      text.length < 3 ? 0 : 200
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q])

  const lib = useMemo<LibNote[]>(
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

  const today = todayIso()
  const waitingLines = useWaiting().items.length
  const stats = useMemo(() => {
    const mine = tasks.filter((t) => t.isMine && t.status === 'open')
    const dueLeft = mine.filter((t) => t.due !== null && t.due <= today).length
    const waiting = tasks.filter((t) => !t.isMine && t.status === 'open').length
    const next = upcoming
      .filter((e) => e.date === today && e.startTime)
      .sort((a, b) => a.startTime!.localeCompare(b.startTime!))[0]
    const weekAgo = addDays(today, -7)
    const thisWeek = notes.filter((n) => n.type !== 'inbox' && n.date >= weekAgo).length
    return { dueLeft, waiting, next, thisWeek, open: mine.length }
  }, [tasks, upcoming, notes, today])

  const counts = useMemo(
    () =>
      Object.fromEntries(VIEWS.map((v) => [v.id, groupsFor(v.id, lib).length])) as Record<
        ViewId,
        number
      >,
    [lib]
  )
  const groups = useMemo(() => (view ? groupsFor(view, lib) : []), [view, lib])
  const current = groups.find((g) => g.key === bucket) ?? null
  const def = VIEWS.find((v) => v.id === view) ?? null

  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return null
    return groupNotes('newest', lib, { query: s, extraPaths: bodyHits }).flatMap((g) => g.notes)
  }, [q, lib, bodyHits])

  const go = (v: ViewId | null, b: string | null, d: 'fwd' | 'back'): void => {
    setDir(d)
    setView(v)
    setBucket(b)
    setLimit(48)
  }

  const crumbs = (
    <nav className="mb-5 flex flex-wrap items-center gap-1.5 text-sm" aria-label="Where you are">
      <button
        className="rounded-lg px-2 py-1 text-muted hover:bg-hover hover:text-fg"
        onClick={() => go(null, null, 'back')}
      >
        Your Notes
      </button>
      {def && (
        <>
          <span className="text-muted">›</span>
          <button
            className={`rounded-lg px-2 py-1 hover:bg-hover ${current ? 'text-muted hover:text-fg' : 'font-medium'}`}
            onClick={() => go(view, null, 'back')}
          >
            {def.title}
          </button>
        </>
      )}
      {current && (
        <>
          <span className="text-muted">›</span>
          <span className="rounded-lg px-2 py-1 font-medium">{current.label}</span>
        </>
      )}
    </nav>
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <header className="mb-6 flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-semibold tracking-tight">Your Notes</h1>
            <p className="mt-1 text-sm text-muted">
              {notes.filter((n) => n.type !== 'inbox').length} notes, all kept in your folder.
              Nothing is hidden because it is old.
            </p>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search every note…"
            aria-label="Search every note"
            className="w-full max-w-xs rounded-2xl border border-line bg-field px-4 py-2.5 text-sm outline-none focus:border-[var(--accent)]"
          />
        </header>

        {results ? (
          <section aria-label="Search results">
            <p className="mb-4 text-sm text-muted">
              {results.length} note{results.length === 1 ? '' : 's'} match “{q.trim()}”
            </p>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {results.slice(0, limit).map((n, i) => (
                <NoteCard key={n.path} n={n} onOpen={onOpenNote} delay={i} />
              ))}
            </div>
            {results.length > limit && (
              <button
                className="mt-5 rounded-xl border border-line px-4 py-2 text-sm hover:bg-hover"
                onClick={() => setLimit((l) => l + 48)}
              >
                Show More
              </button>
            )}
          </section>
        ) : (
          <div key={`${view}:${bucket}`} className={dir === 'fwd' ? 'lib-in-fwd' : 'lib-in-back'}>
            {view === null && (
              <>
                <section
                  aria-label="At a glance"
                  className="mb-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4"
                >
                  <Stat
                    label="Today"
                    value={stats.dueLeft}
                    sub={
                      stats.next
                        ? `Next: ${stats.next.title} at ${fmtTime(stats.next.startTime)}`
                        : 'tasks due, no more meetings'
                    }
                    onClick={() => onTasks('today')}
                  />
                  <Stat
                    label="Waiting On"
                    value={stats.waiting + waitingLines}
                    sub="things other people owe you"
                    onClick={() => onTasks('waiting')}
                  />
                  <Stat
                    label="Email Follow-Ups"
                    value={mail?.attention ?? 0}
                    sub="threads that may need you"
                    onClick={onEmail}
                    tone="warn"
                  />
                  <Stat
                    label="This week"
                    value={stats.thisWeek}
                    sub="notes written · open the review"
                    onClick={onRollup}
                  />
                </section>

                <section aria-label="Browse your notes">
                  <h2 className="mb-4 text-xs font-semibold tracking-wide text-muted uppercase">
                    Browse Your Notes
                  </h2>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {VIEWS.map((v, i) => (
                      <button
                        key={v.id}
                        className={card}
                        style={{ animationDelay: `${i * 30}ms` }}
                        onClick={() => go(v.id, null, 'fwd')}
                      >
                        <div className="flex items-start gap-3.5">
                          <CategoryIcon kind={v.icon} size={44} />
                          <div className="min-w-0 flex-1">
                            <div className="text-base font-semibold tracking-tight">{v.title}</div>
                            <div className="truncate text-xs text-muted">{v.hint}</div>
                          </div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${counts[v.id] > 0 ? 'bg-accent-soft text-accent' : 'bg-hover text-muted'}`}
                          >
                            {counts[v.id]}
                          </span>
                        </div>
                        <div className="mt-4 flex items-center justify-between text-xs text-muted">
                          <span>
                            {counts[v.id] > 0
                              ? `${counts[v.id]} ${counts[v.id] === 1 ? 'group' : 'groups'}`
                              : 'Nothing here yet'}
                          </span>
                          <span className="card-arrow" aria-hidden>
                            →
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}

            {view !== null && bucket === null && def && (
              <section>
                {crumbs}
                <div className="mb-5 flex flex-wrap items-center gap-3">
                  <h2 className="text-2xl font-semibold tracking-tight">
                    <span className="inline-flex items-center gap-3">
                      <CategoryIcon kind={def.icon} size={36} /> {def.title}
                    </span>
                  </h2>
                  <span className="flex-1" />
                  {def.manage && (
                    <button
                      className="rounded-xl border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover"
                      onClick={() => onManage(def.id)}
                    >
                      Manage {def.title}…
                    </button>
                  )}
                </div>
                {groups.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted">
                    {def.manage
                      ? `No ${def.title.toLowerCase()} found in your notes yet. Mention one, or add it under Manage.`
                      : 'Nothing here yet.'}
                  </p>
                ) : (
                  <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {groups.slice(0, limit).map((g, i) => (
                      <button
                        key={g.key}
                        className={card}
                        style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                        onClick={() => go(view, g.key, 'fwd')}
                      >
                        <div className="flex items-baseline gap-2">
                          <h3 className="min-w-0 flex-1 truncate text-base font-semibold">
                            {g.label}
                          </h3>
                          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs tabular-nums">
                            {g.notes.length}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-muted">
                          Latest {shortDate(g.notes[0].date)}
                        </div>
                        <ul className="mt-3 space-y-1 text-sm text-muted">
                          {g.notes.slice(0, 2).map((n) => (
                            <li key={n.path} className="truncate">
                              {n.title}
                            </li>
                          ))}
                        </ul>
                      </button>
                    ))}
                  </div>
                )}
                {groups.length > limit && (
                  <button
                    className="mt-5 rounded-xl border border-line px-4 py-2 text-sm hover:bg-hover"
                    onClick={() => setLimit((l) => l + 48)}
                  >
                    Show More
                  </button>
                )}
              </section>
            )}

            {view !== null && current && def && (
              <section>
                {crumbs}
                <div className="mb-5 flex flex-wrap items-center gap-3">
                  <h2 className="text-2xl font-semibold tracking-tight">{current.label}</h2>
                  <span className="text-sm text-muted">{current.sub}</span>
                  <span className="flex-1" />
                  {def.manage && (
                    <button
                      className="rounded-xl border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover"
                      onClick={() => onOpenEntity(current.key)}
                    >
                      Open Profile
                    </button>
                  )}
                </div>
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {current.notes.slice(0, limit).map((n, i) => (
                    <NoteCard key={n.path} n={n} onOpen={onOpenNote} delay={i} />
                  ))}
                </div>
                {current.notes.length > limit && (
                  <button
                    className="mt-5 rounded-xl border border-line px-4 py-2 text-sm hover:bg-hover"
                    onClick={() => setLimit((l) => l + 48)}
                  >
                    Show More
                  </button>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
