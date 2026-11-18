import { useEffect, useMemo, useRef, useState } from 'react'
import type { DayData } from '@shared/contract'
import { addDays, fmtTime, todayIso } from '../format'
import { ArrowLeftIcon, NoteIcon } from './Icons'
import { useNavState } from '../nav'

type Mode = 'month' | 'week' | 'day' | 'agenda'
const MODES: Mode[] = ['month', 'week', 'day', 'agenda']
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
    const m = localStorage.getItem(MODE_KEY) as Mode
    return MODES.includes(m) ? m : 'month'
  } catch {
    return 'month'
  }
}

const btn = 'rounded-md border border-line bg-field px-2.5 py-1 text-sm font-medium hover:bg-hover'

function DueBadge({ due }: { due: DayData['due'] }): React.JSX.Element | null {
  if (due.count === 0) return null
  return (
    <span
      className={`rounded-full px-1.5 text-xs font-medium ${
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
  const [anchor, setAnchor] = useNavState('calendar.anchor', today)
  const [days, setDays] = useState<Map<string, DayData>>(new Map())
  // The view follows the space it has: a grid when wide, a list when narrow, one day when tiny.
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1200)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const narrow = width < 520
  const medium = width < 900
  const view: Mode = narrow
    ? mode === 'agenda'
      ? 'agenda'
      : 'day'
    : medium && (mode === 'month' || mode === 'week')
      ? 'agenda'
      : mode

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
    if (view === 'day') {
      const mon = mondayOf(anchor)
      return Array.from({ length: 7 }, (_, i) => addDays(mon, i))
    }
    if (view === 'agenda') {
      const mon = mondayOf(anchor)
      return Array.from({ length: 14 }, (_, i) => addDays(mon, i))
    }
    if (view === 'week') {
      const mon = mondayOf(anchor)
      return Array.from({ length: 5 }, (_, i) => addDays(mon, i))
    }
    const first = mondayOf(monthStart(anchor))
    const last = addDays(monthStart(addMonths(anchor, 1)), -1)
    const out: string[] = []
    for (let d = first; d <= addDays(mondayOf(last), 6); d = addDays(d, 1)) out.push(d)
    return out
  }, [view, anchor])

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
    setAnchor(
      view === 'day'
        ? addDays(anchor, dir)
        : view === 'week'
          ? addDays(anchor, dir * 7)
          : view === 'agenda'
            ? addDays(anchor, dir * 14)
            : addMonths(anchor, dir)
    )

  const title =
    view === 'month'
      ? parse(anchor).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : view === 'day'
        ? parse(anchor).toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'short',
            day: 'numeric'
          })
        : `${parse(cells[0]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${parse(
            cells[cells.length - 1]
          ).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  const inMonth = (d: string): boolean => d.slice(0, 7) === anchor.slice(0, 7)
  const cols = view === 'week' ? 5 : 7
  const goDay = (date: string): void => {
    setAnchor(date)
    setMode(narrow ? 'day' : medium ? 'agenda' : 'week')
  }

  return (
    <div ref={box} className="flex h-full flex-col" data-testid="calendar" data-view={view}>
      <header className={`flex flex-wrap items-center gap-2 pt-5 pb-3 ${narrow ? 'px-3' : 'px-6'}`}>
        <h1
          className={`mr-2 font-semibold tracking-tight ${narrow ? 'w-full text-xl' : 'text-2xl'}`}
        >
          {title}
        </h1>
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
          {MODES.filter((m) => !narrow || m === 'day' || m === 'agenda').map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={view === m}
              onClick={() => setMode(m)}
              className={`rounded-md py-1 text-sm font-medium capitalize ${narrow ? 'px-2' : 'px-3'} ${
                view === m ? 'bg-field shadow-sm' : 'text-muted hover:text-fg'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </header>

      {view === 'day' && (
        <DayStrip dates={cells} selected={anchor} today={today} days={days} onPick={setAnchor} />
      )}
      {(view === 'day' || view === 'agenda') && (
        <ListView
          dates={view === 'day' ? [anchor] : cells}
          today={today}
          days={days}
          compact={narrow}
          onOpenPrep={onOpenPrep}
          onOpenNote={onOpenNote}
        />
      )}
      {(view === 'month' || view === 'week') && (
        <>
          <div
            className="grid px-4 text-center text-xs font-semibold tracking-wide text-muted uppercase"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {(view === 'week'
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
              const max = view === 'week' ? 99 : 3
              const events = d?.events ?? []
              const extra = Math.max(0, events.length - max)
              return (
                <div
                  key={date}
                  className={`flex min-h-[7rem] flex-col gap-0.5 rounded-lg border p-1.5 ${
                    isToday ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
                  } ${view === 'month' && !inMonth(date) ? 'opacity-45' : ''} ${weekend ? 'bg-hover/40' : ''}`}
                >
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => goDay(date)}
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
                      className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-hover ${
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
                      onClick={() => goDay(date)}
                      className="px-1 text-left text-xs text-muted hover:text-fg"
                    >
                      +{extra} more
                    </button>
                  )}
                  {(d?.notes ?? []).slice(0, view === 'week' ? 10 : 2).map((n) => (
                    <button
                      key={n.path}
                      onClick={() => onOpenNote(n.path)}
                      className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs text-muted hover:bg-hover hover:text-fg"
                    >
                      <NoteIcon width={11} height={11} className="shrink-0" />
                      <span className="truncate">{n.title}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

const dayName = (iso: string): string =>
  parse(iso).toLocaleDateString('en-US', { weekday: 'short' })

/** Tiny screens: the week as a strip of dates to tap, one day shown below. */
function DayStrip({
  dates,
  selected,
  today,
  days,
  onPick
}: {
  dates: string[]
  selected: string
  today: string
  days: Map<string, DayData>
  onPick: (d: string) => void
}): React.JSX.Element {
  return (
    <div className="flex gap-1 overflow-x-auto px-3 pb-2" role="tablist" aria-label="Days">
      {dates.map((d) => {
        const n = days.get(d)?.events.length ?? 0
        const on = d === selected
        return (
          <button
            key={d}
            role="tab"
            aria-selected={on}
            onClick={() => onPick(d)}
            className={`flex min-w-11 flex-col items-center rounded-xl px-2 py-1.5 text-xs transition-colors ${
              on ? 'bg-accent text-accent-fg' : d === today ? 'bg-accent-soft' : 'hover:bg-hover'
            }`}
          >
            <span className={on ? '' : 'text-muted'}>{dayName(d)}</span>
            <span className="text-base font-semibold tabular-nums">{parse(d).getDate()}</span>
            <span
              className={`h-1 w-1 rounded-full ${n ? (on ? 'bg-accent-fg' : 'bg-accent') : 'bg-transparent'}`}
            />
          </button>
        )
      })}
    </div>
  )
}

/** Narrow screens: days as a list, each with its meetings and notes. */
function ListView({
  dates,
  today,
  days,
  compact,
  onOpenPrep,
  onOpenNote
}: {
  dates: string[]
  today: string
  days: Map<string, DayData>
  compact: boolean
  onOpenPrep: (id: string) => void
  onOpenNote: (path: string) => void
}): React.JSX.Element {
  return (
    <div className={`min-h-0 flex-1 space-y-2 overflow-y-auto pb-6 ${compact ? 'px-3' : 'px-5'}`}>
      {dates.map((date) => {
        const d = days.get(date)
        const events = d?.events ?? []
        const notes = d?.notes ?? []
        const empty = events.length === 0 && notes.length === 0
        const isToday = date === today
        return (
          <section
            key={date}
            className={`card-modern p-3 ${isToday ? 'ring-1 ring-accent/40' : ''} ${empty && dates.length > 1 ? 'opacity-70' : ''}`}
          >
            <header className="mb-1.5 flex items-center gap-2">
              <span
                className={`flex h-8 w-8 flex-col items-center justify-center rounded-lg text-xs leading-none font-semibold ${isToday ? 'bg-accent text-accent-fg' : 'bg-hover'}`}
              >
                {parse(date).getDate()}
              </span>
              <span className="text-sm font-semibold">
                {parse(date).toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric'
                })}
              </span>
              <span className="flex-1" />
              {d && <DueBadge due={d.due} />}
            </header>
            {empty && <p className="px-1 text-xs text-muted">Nothing scheduled.</p>}
            <ul className="space-y-1">
              {events.map((e) => (
                <li key={e.id}>
                  <button
                    onClick={() => onOpenPrep(e.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-hover ${e.status === 'tentative' ? 'italic' : ''}`}
                  >
                    <span className="w-14 shrink-0 text-xs text-muted tabular-nums">
                      {e.startTime ? fmtTime(e.startTime) : 'All day'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                    {e.notePath && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                        aria-label="Has notes"
                      />
                    )}
                  </button>
                </li>
              ))}
              {notes.map((n) => (
                <li key={n.path}>
                  <button
                    onClick={() => onOpenNote(n.path)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-muted hover:bg-hover hover:text-fg"
                  >
                    <NoteIcon width={12} height={12} className="shrink-0" />
                    <span className="truncate">{n.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
