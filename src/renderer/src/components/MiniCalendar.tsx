import { useEffect, useMemo, useState } from 'react'
import type { Output } from '@shared/contract'
import { addDays, fmtTime, shortDate, todayIso } from '../format'

type Day = Output<'calendar:range'>[number]

const parse = (iso: string): Date => new Date(`${iso}T12:00:00`)
const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`
const addMonths = (iso: string, n: number): string => {
  const d = parse(monthStart(iso))
  d.setMonth(d.getMonth() + n)
  return d.toLocaleDateString('en-CA')
}
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/**
 * A small month for the side of the dashboard: dots for meetings and for tasks that are due, and
 * the picked day's agenda underneath. Click a meeting to open its prep.
 */
export default function MiniCalendar({
  onOpenPrep,
  onOpenCalendar
}: {
  onOpenPrep: (eventId: string) => void
  onOpenCalendar: () => void
}): React.JSX.Element {
  const today = todayIso()
  const [anchor, setAnchor] = useState(monthStart(today))
  const [picked, setPicked] = useState(today)
  const [days, setDays] = useState<Record<string, Day>>({})

  const cells = useMemo(() => {
    const first = parse(anchor)
    const lead = (first.getDay() + 6) % 7
    const start = addDays(anchor, -lead)
    return Array.from({ length: 42 }, (_, i) => addDays(start, i))
  }, [anchor])

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api
        .invoke('calendar:range', { from: cells[0], to: cells[cells.length - 1] })
        .then((r) => {
          if (!alive || !r.ok) return
          setDays(Object.fromEntries(r.data.map((d) => [d.date, d])))
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
  }, [cells])

  const day = days[picked]
  const title = parse(anchor).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  return (
    <section className="card-modern p-3" data-testid="mini-calendar">
      <header className="mb-2 flex items-center gap-1">
        <button
          aria-label="Previous month"
          className="rounded-md px-1.5 py-0.5 text-muted hover:bg-hover"
          onClick={() => setAnchor(addMonths(anchor, -1))}
        >
          ‹
        </button>
        <button
          className="min-w-0 flex-1 truncate text-sm font-semibold hover:text-accent"
          onClick={() => {
            setAnchor(monthStart(today))
            setPicked(today)
          }}
          title="Back to today"
        >
          {title}
        </button>
        <button
          aria-label="Next month"
          className="rounded-md px-1.5 py-0.5 text-muted hover:bg-hover"
          onClick={() => setAnchor(addMonths(anchor, 1))}
        >
          ›
        </button>
      </header>
      <div className="grid grid-cols-7 text-center text-xs font-semibold text-muted">
        {WEEKDAYS.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-y-0.5 text-center text-xs">
        {cells.map((iso) => {
          const d = days[iso]
          const inMonth = iso.slice(0, 7) === anchor.slice(0, 7)
          const isToday = iso === today
          const isPicked = iso === picked
          return (
            <button
              key={iso}
              onClick={() => setPicked(iso)}
              aria-label={shortDate(iso)}
              aria-pressed={isPicked}
              className={`relative mx-auto flex h-8 w-8 flex-col items-center justify-center rounded-lg tabular-nums ${
                isPicked
                  ? 'bg-accent text-accent-fg'
                  : isToday
                    ? 'bg-accent-soft font-semibold text-accent'
                    : inMonth
                      ? 'hover:bg-hover'
                      : 'text-muted/50 hover:bg-hover'
              }`}
            >
              {Number(iso.slice(8))}
              <span className="absolute bottom-0.5 flex gap-0.5">
                {d && d.events.length > 0 && (
                  <i className={`h-1 w-1 rounded-full ${isPicked ? 'bg-white' : 'bg-accent'}`} />
                )}
                {d && d.due.count > 0 && (
                  <i
                    className={`h-1 w-1 rounded-full ${isPicked ? 'bg-white' : d.due.high ? 'bg-danger' : 'bg-warn'}`}
                  />
                )}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-3 border-t border-line pt-2" data-testid="mini-agenda">
        <p className="mb-1 flex items-center text-xs font-semibold tracking-wide text-muted uppercase">
          {picked === today ? 'Today' : shortDate(picked)}
          <button
            className="ml-auto font-medium tracking-normal normal-case hover:text-accent hover:underline"
            onClick={onOpenCalendar}
          >
            Full calendar
          </button>
        </p>
        {!day || (day.events.length === 0 && day.due.count === 0) ? (
          <p className="py-2 text-xs text-muted">Nothing scheduled.</p>
        ) : (
          <ul className="space-y-0.5">
            {day.events.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => onOpenPrep(e.id)}
                  className="flex w-full items-baseline gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-hover"
                >
                  <span className="w-12 shrink-0 tabular-nums text-muted">
                    {e.startTime ? fmtTime(e.startTime) : 'All day'}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  {e.notePath && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" title="Has notes" />
                  )}
                </button>
              </li>
            ))}
            {day.due.count > 0 && (
              <li className="px-1 py-1 text-xs text-muted">
                {day.due.count} task{day.due.count === 1 ? '' : 's'} due
                {day.due.high ? `, ${day.due.high} high priority` : ''}
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  )
}
