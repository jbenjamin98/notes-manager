import { useEffect, useMemo, useState } from 'react'
import type { DayData } from '@shared/contract'
import { addDays, fmtTime, todayIso } from '../format'
import { ArrowLeftIcon, NoteIcon } from './Icons'

type Mode = 'month' | 'week'
const MODE_KEY = 'nm-cal-mode'

const parse = (iso: string): Date => new Date(`${iso}T12:00:00`)
const mondayOf = (iso: string): string => {
  const d = parse(iso)
  return addDays(iso, -((d.getDay() + 6) % 7))
}
const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`
const addMonths = (iso: string, n: number): string => {
  const d = parse(monthStart(iso))
  d.setMonth(d.getMonth() + n)
  return d.toLocaleDateString('en-CA')
}

const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE_KEY) === 'week' ? 'week' : 'month'
  } catch {
    return 'month'
  }
}

const btn = 'rounded-md border border-line bg-field px-2.5 py-1 text-sm font-medium hover:bg-hover'

function DueBadge({ due }: { due: DayData['due'] }): React.JSX.Element | null {
  if (due.count === 0) return null
  return (
    <span
      className={`rounded-full px-1.5 text-[10px] font-medium ${
        due.high > 0 ? 'bg-danger/15 text-danger' : 'bg-hover text-muted'
      }`}
      title={`${due.count} task${due.count === 1 ? '' : 's'} due${due.high ? `, ${due.high} High priority` : ''}`}
    >
      {due.count} due
    </span>
  )
}

export default function CalendarView({
  onOpenPrep,
  onOpenNote
}: {
  onOpenPrep: (eventId: string) => void
  onOpenNote: (path: string) => void
}): React.JSX.Element {
  const today = todayIso()
  const [mode, setModeState] = useState<Mode>(readMode)
  const [anchor, setAnchor] = useState(today)
  const [days, setDays] = useState<Map<string, DayData>>(new Map())

  const setMode = (m: Mode): void => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* ignore */
    }
  }

  // The dates shown: whole weeks covering the month, or the Mon-Fri week.
  const cells = useMemo(() => {
    if (mode === 'week') {
      const mon = mondayOf(anchor)
      return Array.from({ length: 5 }, (_, i) => addDays(mon, i))
    }
    const first = mondayOf(monthStart(anchor))
    const last = addDays(monthStart(addMonths(anchor, 1)), -1)
    const out: string[] = []
    for (let d = first; d <= addDays(mondayOf(last), 6); d = addDays(d, 1)) out.push(d)
    return out
  }, [mode, anchor])

  const from = cells[0]
  const to = cells[cells.length - 1]

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api.invoke('calendar:range', { from, to }).then((r) => {
        if (alive && r.ok) setDays(new Map(r.data.map((d) => [d.date, d])))
      })
    }
    load()
    const offV = window.api.on('vault:changed', load)
    const offC = window.api.on('calendar:changed', load)
    return () => {
      alive = false
      offV()
      offC()
    }
  }, [from, to])

  const step = (dir: -1 | 1): void =>
    setAnchor(mode === 'week' ? addDays(anchor, dir * 7) : addMonths(anchor, dir))

  const title =
    mode === 'month'
      ? parse(anchor).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : `${parse(cells[0]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${parse(
          cells[cells.length - 1]
        ).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  const inMonth = (d: string): boolean => d.slice(0, 7) === anchor.slice(0, 7)
  const cols = mode === 'week' ? 5 : 7

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 px-6 pt-5 pb-3">
        <h1 className="mr-2 text-2xl font-semibold tracking-tight">{title}</h1>
        <button className={btn} onClick={() => step(-1)} aria-label="Previous">
          <ArrowLeftIcon width={14} height={14} />
        </button>
        <button className={btn} onClick={() => setAnchor(today)}>
          Today
        </button>
        <button className={btn} onClick={() => step(1)} aria-label="Next">
          <ArrowLeftIcon width={14} height={14} className="rotate-180" />
        </button>
        <span className="flex-1" />
        <div
          role="radiogroup"
          aria-label="View"
          className="inline-flex gap-1 rounded-lg bg-hover p-1"
        >
          {(['month', 'week'] as Mode[]).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 text-sm font-medium capitalize ${
                mode === m ? 'bg-field shadow-sm' : 'text-muted hover:text-fg'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </header>

      <div
        className="grid px-4 text-center text-[11px] font-semibold tracking-wide text-muted uppercase"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {(mode === 'week'
          ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
          : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        ).map((d) => (
          <div key={d} className="pb-1">
            {d}
          </div>
        ))}
      </div>

      <div
        className="grid min-h-0 flex-1 auto-rows-fr gap-px overflow-y-auto px-4 pb-4"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {cells.map((date) => {
          const d = days.get(date)
          const isToday = date === today
          const weekend = parse(date).getDay() === 0 || parse(date).getDay() === 6
          const max = mode === 'week' ? 99 : 3
          const events = d?.events ?? []
          const extra = Math.max(0, events.length - max)
          return (
            <div
              key={date}
              className={`flex min-h-[7rem] flex-col gap-0.5 rounded-lg border p-1.5 ${
                isToday ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
              } ${mode === 'month' && !inMonth(date) ? 'opacity-45' : ''} ${weekend ? 'bg-hover/40' : ''}`}
            >
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setAnchor(date)
                    setMode('week')
                  }}
                  className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold hover:bg-hover ${
                    isToday ? 'bg-accent text-accent-fg hover:bg-accent' : ''
                  }`}
                  title="Open this week"
                >
                  {parse(date).getDate()}
                </button>
                <span className="flex-1" />
                {d && <DueBadge due={d.due} />}
              </div>

              {events.slice(0, max).map((e) => (
                <button
                  key={e.id}
                  onClick={() => onOpenPrep(e.id)}
                  title={`${e.title}${e.startTime ? ` · ${fmtTime(e.startTime)}` : ''}: open the prep sheet`}
                  className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-hover ${
                    e.status === 'tentative' ? 'italic' : ''
                  }`}
                >
                  <span className="shrink-0 tabular-nums text-muted">
                    {e.startTime
                      ? fmtTime(e.startTime).replace(' AM', 'a').replace(' PM', 'p')
                      : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  {e.notePath && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      aria-label="Has notes"
                    />
                  )}
                </button>
              ))}
              {extra > 0 && (
                <button
                  onClick={() => {
                    setAnchor(date)
                    setMode('week')
                  }}
                  className="px-1 text-left text-[11px] text-muted hover:text-fg"
                >
                  +{extra} more
                </button>
              )}
              {(d?.notes ?? []).slice(0, mode === 'week' ? 10 : 2).map((n) => (
                <button
                  key={n.path}
                  onClick={() => onOpenNote(n.path)}
                  className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-muted hover:bg-hover hover:text-fg"
                >
                  <NoteIcon width={11} height={11} className="shrink-0" />
                  <span className="truncate">{n.title}</span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
