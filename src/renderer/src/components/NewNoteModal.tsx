import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarStatus, DayData } from '@shared/contract'
import { addDays, dayLabel, fmtTime, relativeTime, todayIso } from '../format'
import { RefreshIcon } from './Icons'
import { useFocusTrap } from '../useFocusTrap'

type Ev = DayData['events'][number] & { date: string }

/**
 * One place to start a note: type a title for a blank note, or pick a meeting (today, coming up,
 * or recent) and its title, date, time and account are filled in. Resync pulls new invites.
 */
export default function NewNoteModal({
  cal,
  onClose,
  onBlank,
  onMeeting,
  onSync,
  onConnect
}: {
  cal: CalendarStatus
  onClose: () => void
  onBlank: (title: string) => void
  onMeeting: (eventId: string) => void
  onSync: () => Promise<void>
  onConnect: () => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  useFocusTrap(dialog, onClose)
  const [q, setQ] = useState('')
  const [days, setDays] = useState<DayData[] | null>(null)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(() => {
    const t = todayIso()
    void window.api
      .invoke('calendar:range', { from: addDays(t, -7), to: addDays(t, 14) })
      .then((r) => {
        if (r.ok) setDays(r.data)
      })
  }, [])
  useEffect(() => load(), [load])

  const resync = async (): Promise<void> => {
    setSyncing(true)
    await onSync()
    load()
    setSyncing(false)
  }

  const today = todayIso()
  const groups = useMemo(() => {
    const f = q.trim().toLowerCase()
    const all: Ev[] = (days ?? [])
      .flatMap((d) => d.events.map((e) => ({ ...e, date: d.date })))
      .filter((e) => e.status !== 'declined' && e.startTime)
      .filter((e) => !f || e.title.toLowerCase().includes(f))
    const upcoming = all
      .filter((e) => e.date >= today)
      .sort((a, b) => (a.date + (a.startTime ?? '')).localeCompare(b.date + (b.startTime ?? '')))
    const recent = all
      .filter((e) => e.date < today)
      .sort((a, b) => (b.date + (b.startTime ?? '')).localeCompare(a.date + (a.startTime ?? '')))
    return [
      { label: 'Today and coming up', items: upcoming },
      { label: 'Recent', items: recent }
    ].filter((g) => g.items.length > 0)
  }, [days, q, today])

  const row = (e: Ev): React.JSX.Element => (
    <li key={e.id + e.date} className="lib-item">
      <button
        onClick={() => onMeeting(e.id)}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-hover"
      >
        <span className="w-16 shrink-0 text-xs text-muted tabular-nums">
          {e.date === today ? fmtTime(e.startTime) : dayLabel(e.date).replace(/,.*/, '')}
          {e.date !== today && <span className="block">{fmtTime(e.startTime)}</span>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{e.title}</span>
          <span className="block text-xs text-muted">
            {e.notePath ? 'Open its notes' : 'Start notes'}
          </span>
        </span>
        {e.notePath && (
          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs">
            has notes
          </span>
        )}
      </button>
    </li>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[10vh]"
      onMouseDown={onClose}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="New Note"
        className="glass spring-in flex max-h-[78vh] w-[34rem] max-w-[94vw] flex-col overflow-hidden rounded-3xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-3">
          <h2 className="text-lg font-semibold tracking-tight">New Note</h2>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onBlank(q.trim())
              }
            }}
            placeholder="Type a title, or search your meetings…"
            aria-label="Note title"
            className="mt-3 w-full rounded-xl border border-line bg-field px-4 py-3 text-base outline-none focus:border-[var(--accent)]"
          />
          <div className="mt-3 flex items-center gap-2">
            <button
              className="btn-primary rounded-xl px-4 py-2 text-sm font-semibold"
              onClick={() => onBlank(q.trim())}
            >
              {q.trim()
                ? `Create “${q.trim().slice(0, 28)}${q.trim().length > 28 ? '…' : ''}”`
                : 'Blank note'}
            </button>
            <span className="flex-1" />
            <span className="text-xs text-muted">
              {cal.state === 'needs-auth'
                ? 'Calendar not connected'
                : cal.lastSyncAt
                  ? `Synced ${relativeTime(cal.lastSyncAt)}`
                  : 'Not synced yet'}
            </span>
            {cal.state === 'needs-auth' ? (
              <button
                className="rounded-lg border border-line bg-field px-3 py-1.5 text-xs font-medium hover:bg-hover"
                onClick={onConnect}
              >
                Sign in to Google
              </button>
            ) : (
              <button
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-field px-3 py-1.5 text-xs font-medium hover:bg-hover disabled:opacity-60"
                onClick={() => void resync()}
                disabled={syncing}
                aria-label="Resync meetings"
              >
                <RefreshIcon width={13} height={13} className={syncing ? 'spin' : ''} />
                {syncing ? 'Syncing…' : 'Resync meetings'}
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-3 py-2">
          {days === null && (
            <p className="px-3 py-6 text-center text-sm text-muted">Loading your meetings…</p>
          )}
          {days !== null && groups.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-muted">
              {q
                ? 'No meeting matches. Press Enter to create a blank note with this title.'
                : 'No meetings found. Resync, or just type a title.'}
            </p>
          )}
          {groups.map((g) => (
            <section key={g.label} className="mb-2">
              <h3 className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                {g.label}
              </h3>
              <ul>{g.items.map(row)}</ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
