import { useEffect, useMemo, useState } from 'react'
import { SparkleIcon } from './Icons'
import EmptyState from './EmptyState'
import type { TaskItem, UpcomingEvent } from '@shared/contract'
import { greetingFor } from '../ambient'
import { streakOf } from '@shared/streak'
import { fmtTime, todayIso, wall } from '../format'
import { useNow } from '../hooks'
import { useAiMode } from '../aiMode'
import { useCountUp } from '../countUp'

function Ring({
  r,
  stroke,
  fraction,
  className
}: {
  r: number
  stroke: string
  fraction: number
  className?: string
}): React.JSX.Element {
  const c = 2 * Math.PI * r
  const [shown, setShown] = useState(0) // starts empty, then draws itself in
  useEffect(() => {
    const t = setTimeout(() => setShown(Math.max(0, Math.min(1, fraction))), 60)
    return () => clearTimeout(t)
  }, [fraction])
  return (
    <>
      <circle cx="100" cy="100" r={r} fill="none" stroke="var(--line)" strokeWidth="9" />
      <circle
        className={`ring ${className ?? ''}`}
        cx="100"
        cy="100"
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - shown)}
        transform="rotate(-90 100 100)"
      />
    </>
  )
}

const mins = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + (m || 0)
}

export default function HomeView({
  tasks,
  upcoming,
  onNewNote,
  onOpenEvent,
  onOpenTasks,
  onOpenFilter,
  onCopilot,
  onPlan,
  onSettings,
  onInbox,
  onEmail,
  mailAttention
}: {
  tasks: TaskItem[]
  upcoming: UpcomingEvent[]
  onNewNote: () => void
  onOpenEvent: (id: string) => void
  onOpenTasks: () => void
  /** Open the task list already narrowed to one filter. */
  onOpenFilter: (f: 'overdue' | 'today') => void
  onCopilot: () => void
  onPlan: () => void
  onSettings: () => void
  onInbox: () => void
  onEmail: () => void
  /** Email threads that need a look (from the mail sync). */
  mailAttention: number
}): React.JSX.Element {
  const now = useNow(30_000)
  const [name, setName] = useState('')
  const [hours, setHours] = useState({ start: '08:00', end: '18:00' })
  const [aiMode] = useAiMode()
  const [brief, setBrief] = useState<string | null>(null)
  // Nothing connected yet: say so, and offer the next step right here.
  const [unconnected, setUnconnected] = useState(false)
  // What is waiting in the Inbox: new insights and chats that need a reply.
  const [inbox, setInbox] = useState({ insights: 0, replies: 0 })
  useEffect(() => {
    void Promise.all([window.api.invoke('inbox:list'), window.api.invoke('chat:overview')]).then(
      ([i, c]) =>
        setInbox({
          insights: i.ok ? i.data.length : 0,
          replies: c.ok ? c.data.conversations.filter((x) => x.bucket === 'needs-you').length : 0
        })
    )
  }, [])
  useEffect(() => {
    void window.api
      .invoke('google:health')
      .then((r) => r.ok && setUnconnected(r.data.rows.every((x) => x.source === 'none')))
  }, [])

  // Heavy mode does the thinking for you: a short brief of the day appears without asking.
  useEffect(() => {
    if (aiMode !== 'heavy') return
    let alive = true
    void window.api.invoke('assistant:action', { kind: 'day-brief', ephemeral: true }).then((r) => {
      const m = r.ok ? r.data.find((x) => x.role === 'assistant') : null
      if (alive && m && m.via === 'llm') setBrief(m.content)
    })
    return () => {
      alive = false
    }
  }, [aiMode])

  useEffect(() => {
    void window.api.invoke('settings:get').then((r) => {
      if (!r.ok) return
      const own = r.data.meAliases.find((a) => a.toLowerCase() !== 'me')
      setName(own ? own.split(/\s+/)[0] : '')
      setHours(r.data.workHours)
    })
  }, [])

  const today = todayIso(new Date(now))
  const w = wall(new Date(now))
  const nowMin = w.getHours() * 60 + w.getMinutes()

  const stats = useMemo(() => {
    const mine = tasks.filter((t) => t.isMine)
    const doneToday = mine.filter(
      (t) =>
        t.status === 'completed' &&
        t.completedAt &&
        new Date(t.completedAt).toLocaleDateString('en-CA') === today
    ).length
    const open = mine.filter((t) => t.status === 'open' && t.due !== null && t.due <= today).length
    return { doneToday, open, streak: streakOf(tasks, today) }
  }, [tasks, today])

  const openShown = useCountUp(stats.open)
  const total = stats.doneToday + stats.open
  const taskFraction = total === 0 ? 1 : stats.doneToday / total
  const start = mins(hours.start)
  const end = mins(hours.end)
  const dayFraction = Math.max(0, Math.min(1, (nowMin - start) / Math.max(1, end - start)))

  const next = upcoming
    .filter((e) => e.date === today && e.startTime && mins(e.startTime) >= nowMin - 5)
    .sort((a, b) => a.startTime!.localeCompare(b.startTime!))[0]
  const untilNext = next ? mins(next.startTime!) - nowMin : null

  const centre =
    total === 0
      ? { big: '✓', small: 'Nothing due today' }
      : stats.open === 0
        ? { big: '🎉', small: 'Clear day' }
        : {
            big: String(stats.open),
            small: stats.open === 1 ? 'task due or overdue' : 'tasks due or overdue'
          }

  return (
    <div className="view-in flex h-full flex-col items-center justify-center-safe gap-5 overflow-y-auto px-6 py-8 text-center">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          {greetingFor(w.getHours())}
          {name ? `, ${name}` : ''}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {w.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </div>

      <button
        onClick={onOpenTasks}
        aria-label={`${stats.open} tasks due or overdue. Open tasks.`}
        className="group relative h-52 w-52 rounded-full transition-transform hover:scale-[1.03]"
      >
        <svg viewBox="0 0 200 200" className="h-full w-full">
          <Ring r={88} stroke="var(--s1)" fraction={dayFraction} />
          <Ring
            r={70}
            stroke="var(--accent)"
            fraction={taskFraction}
            className={total > 0 && stats.open === 0 ? 'breathe' : ''}
          />
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-4xl font-semibold tabular-nums">
            {stats.open > 0 ? openShown : centre.big}
          </span>
          <span className="text-xs text-muted">{centre.small}</span>
        </span>
      </button>
      <p className="-mt-3 text-xs text-muted">
        Outer ring: your work day so far. Inner ring: today’s tasks finished.
      </p>

      {unconnected && (
        <EmptyState
          icon="📅"
          title="Bring in your meetings and what matters from them"
          body="Connect your Google account (about 5 minutes) and meetings, follow-ups and key decisions show up here."
          action={{ label: 'Connect Google', onClick: onSettings }}
        />
      )}

      <div className="flex flex-wrap items-stretch justify-center gap-3">
        {stats.streak > 0 && (
          <div className="rounded-2xl border border-line bg-surface px-4 py-2.5 text-sm">
            <span className="text-lg">🔥</span> <strong>{stats.streak}</strong> day
            {stats.streak === 1 ? '' : 's'} in a row
          </div>
        )}
        {next ? (
          <button
            onClick={() => onOpenEvent(next.id)}
            className="rounded-2xl border border-line bg-surface px-4 py-2.5 text-left text-sm hover:bg-hover"
          >
            <div className="text-xs text-muted">
              {untilNext! <= 0
                ? 'Happening now'
                : untilNext! < 60
                  ? `In ${untilNext} min`
                  : `At ${fmtTime(next.startTime)}`}
            </div>
            <div className="max-w-56 truncate font-medium">{next.title}</div>
          </button>
        ) : (
          <div className="rounded-2xl border border-line bg-surface px-4 py-2.5 text-sm text-muted">
            No more meetings today
          </div>
        )}
      </div>

      {(() => {
        const mine = tasks.filter((t) => t.isMine && t.status === 'open')
        const overdue = mine.filter((t) => t.due !== null && t.due < today).length
        const dueToday = mine.filter((t) => t.due === today).length
        const rows: { label: string; n: number; tone?: string; run: () => void }[] = [
          {
            label: 'Overdue tasks',
            n: overdue,
            tone: 'text-danger',
            run: () => onOpenFilter('overdue')
          },
          { label: 'Due today', n: dueToday, run: () => onOpenFilter('today') },
          { label: 'Chats waiting for your reply', n: inbox.replies, run: onInbox },
          {
            label: 'New actions, decisions and risks found',
            n: inbox.insights,
            run: onInbox
          },
          { label: 'Emails to follow up', n: mailAttention, run: onEmail }
        ].filter((r) => r.n > 0)
        if (rows.length === 0) return null
        return (
          <section className="w-full max-w-md text-left" aria-label="Today">
            <h2 className="mb-1.5 px-1 text-xs font-semibold tracking-wide text-muted uppercase">
              Needs You Today
            </h2>
            <ul className="space-y-1.5">
              {rows.map((r) => (
                <li key={r.label}>
                  <button
                    onClick={r.run}
                    className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm transition hover:border-[var(--accent)] hover:bg-hover"
                  >
                    <span className={`w-7 text-lg font-semibold tabular-nums ${r.tone ?? ''}`}>
                      {r.n}
                    </span>
                    <span className="flex-1 text-left">{r.label}</span>
                    <span aria-hidden className="text-muted">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })()}

      {aiMode === 'heavy' && brief && (
        <div className="msg-in max-w-md rounded-2xl border border-line bg-surface px-4 py-3 text-left text-sm whitespace-pre-wrap">
          <div className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
            <SparkleIcon width={12} height={12} className="mr-1 inline" /> Today’s brief
          </div>
          {brief}
        </div>
      )}

      <div className="flex flex-wrap justify-center gap-2">
        <button
          className="btn-primary rounded-xl px-4 py-2 text-sm font-semibold"
          onClick={onNewNote}
        >
          New Note
        </button>
        <button
          className="rounded-xl border border-line bg-field px-4 py-2 text-sm font-medium hover:bg-hover"
          onClick={onPlan}
        >
          <SparkleIcon width={14} height={14} className="mr-1.5 inline" /> Plan my day
        </button>
        <button
          className="rounded-xl border border-line bg-field px-4 py-2 text-sm font-medium hover:bg-hover"
          onClick={onCopilot}
        >
          Ask the Co-Pilot
        </button>
      </div>
      <p className="text-xs text-muted">
        Press <kbd className="rounded border border-line bg-field px-1.5">Ctrl</kbd> +{' '}
        <kbd className="rounded border border-line bg-field px-1.5">K</kbd> to find or do anything
      </p>
    </div>
  )
}
