import { useCallback, useEffect, useState } from 'react'
import type { Output } from '@shared/contract'
import { useNavState } from '../nav'
import { shortDate } from '../format'
import EmptyState from './EmptyState'
import CategoryIcon, { type CategoryKind } from './CategoryIcon'

type Summary = Output<'meetings:series'>[number]
type Detail = NonNullable<Output<'meetings:series-detail'>>
type Candidate = Output<'meetings:series-candidates'>[number]

const btn =
  'rounded-md border border-line bg-field px-2.5 py-1 text-xs font-medium hover:bg-hover disabled:opacity-50'

const STATUS: Record<Detail['sessions'][number]['status'], { label: string; tone: string }> = {
  notes: { label: 'Notes', tone: 'bg-ok/15 text-ok' },
  scheduled: { label: 'Scheduled', tone: 'bg-accent-soft text-accent' },
  'no-notes': { label: 'No notes', tone: 'bg-warn/15 text-warn' }
}

function Block({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="card-modern mb-4 p-4">
      <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-hover px-1.5 tabular-nums">{count}</span>
        )}
      </h2>
      {children}
    </section>
  )
}

/**
 * Meeting Series: a meeting held again and again, with every session as its own independent
 * note. This page is built from their dates and titles: nothing is stored here, so it cannot go
 * out of date. It carries open actions and questions forward and starts the next session.
 */
export default function MeetingSeriesView({
  onOpenNote,
  onFlash
}: {
  onOpenNote: (path: string) => void
  onFlash: (m: string) => void
}): React.JSX.Element {
  const [key, setKey] = useNavState<string | null>('series.key', null)
  const [list, setList] = useState<Summary[] | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [pick, setPick] = useState('')

  useEffect(() => {
    let alive = true
    void window.api.invoke('meetings:series').then((r) => alive && r.ok && setList(r.data))
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    let alive = true
    if (!key) {
      const t = setTimeout(() => alive && setDetail(null), 0)
      return () => {
        alive = false
        clearTimeout(t)
      }
    }
    void window.api
      .invoke('meetings:series-detail', { key })
      .then((r) => alive && r.ok && setDetail(r.data))
    return () => {
      alive = false
    }
  }, [key, tick])
  useEffect(() => {
    let alive = true
    if (!key) return
    void window.api
      .invoke('meetings:series-candidates', { key })
      .then((r) => alive && r.ok && setCandidates(r.data))
    return () => {
      alive = false
    }
  }, [key, tick])

  const link = useCallback(
    async (path: string, join: boolean) => {
      if (!key) return
      const r = await window.api.invoke('meetings:series-link', { key, path, join })
      if (!r.ok) return onFlash(r.error.message)
      setPick('')
      setTick((t) => t + 1)
      onFlash(join ? 'Added to this series.' : 'Taken out of the series.')
    },
    [key, onFlash]
  )
  const master = useCallback(async () => {
    if (!key || busy) return
    setBusy(true)
    const r = await window.api.invoke('meetings:series-master', { key })
    setBusy(false)
    if (!r.ok) return onFlash(r.error.message)
    onOpenNote(r.data.path)
  }, [key, busy, onFlash, onOpenNote])

  const startNext = useCallback(async () => {
    if (!key || busy) return
    setBusy(true)
    const r = await window.api.invoke('meetings:series-next', { key })
    setBusy(false)
    if (!r.ok) return onFlash(r.error.message)
    onOpenNote(r.data.path)
  }, [key, busy, onFlash, onOpenNote])

  if (!key) {
    return (
      <div className="h-full overflow-y-auto px-6 py-5" data-testid="series-list">
        <h1 className="text-2xl font-semibold tracking-tight">Meeting Series</h1>
        <p className="mt-1 mb-4 text-sm text-muted">
          Meetings you hold again and again. Every session is still its own note.
        </p>
        {list === null ? (
          <p className="text-sm text-muted">Looking for repeating meetings…</p>
        ) : list.length === 0 ? (
          <EmptyState
            title="No repeating meetings yet"
            body="When a meeting with the same title has two or more sessions, in your calendar or your notes, it appears here."
          />
        ) : (
          <ul className="space-y-2">
            {list.map((s) => (
              <li key={s.key}>
                <button
                  onClick={() => setKey(s.key)}
                  className="card-modern flex w-full items-center gap-3 p-3 text-left hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{s.title}</span>
                    <span className="block text-xs text-muted">
                      {s.sessions} sessions · last {shortDate(s.lastDate)}
                      {s.nextDate ? ` · next ${shortDate(s.nextDate)}` : ''}
                    </span>
                  </span>
                  {s.openActions > 0 && (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">
                      {s.openActions} open
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-5" data-testid="series-detail">
      <button className="mb-2 text-xs text-muted hover:text-accent" onClick={() => setKey(null)}>
        ← All Series
      </button>
      {!detail ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <>
          <header className="mb-4 flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{detail.title}</h1>
              <p className="mt-1 text-xs text-muted">
                {detail.sessions.length} sessions
                {detail.account ? ` · ${detail.account}` : ''}
                {detail.attendees.length ? ` · ${detail.attendees.slice(0, 6).join(', ')}` : ''}
              </p>
            </div>
            <button className={btn} disabled={busy} onClick={() => void master()}>
              Create Master Page
            </button>
            <button className={btn} disabled={busy} onClick={() => void startNext()}>
              Start Next Session
            </button>
          </header>

          <Block title="Sessions" count={detail.sessions.length}>
            <ul>
              {detail.sessions.map((s) => (
                <li
                  key={`${s.date}|${s.path ?? s.eventId}`}
                  className="flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-hover"
                >
                  <span className="w-20 text-xs tabular-nums text-muted">{shortDate(s.date)}</span>
                  {s.path ? (
                    <button
                      className="min-w-0 flex-1 truncate text-left text-sm hover:text-accent hover:underline"
                      onClick={() => onOpenNote(s.path!)}
                    >
                      {s.title}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm text-muted">{s.title}</span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[s.status].tone}`}>
                    {STATUS[s.status].label}
                  </span>
                  {s.path && (
                    <button
                      className="text-xs text-muted hover:text-accent hover:underline"
                      aria-label={`Take ${s.title} out of this series`}
                      onClick={() => void link(s.path!, false)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {candidates.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <select
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  aria-label="Meeting to add to this series"
                  data-testid="series-pick"
                  className="min-w-0 max-w-xs flex-1 rounded-lg border border-line bg-field px-2 py-1 text-xs"
                >
                  <option value="">Add another meeting to this series…</option>
                  {candidates.map((c) => (
                    <option key={c.path} value={c.path}>
                      {shortDate(c.date)} · {c.title}
                    </option>
                  ))}
                </select>
                <button
                  className={btn}
                  disabled={!pick}
                  data-testid="series-add"
                  onClick={() => void link(pick, true)}
                >
                  Add
                </button>
              </div>
            )}
          </Block>

          {detail.threads.length > 0 && (
            <Block title="Topic Threads" count={detail.threads.length}>
              <ul className="space-y-3" data-testid="series-threads">
                {detail.threads.map((t) => (
                  <li key={t.name}>
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <CategoryIcon kind={t.category as CategoryKind} size={14} />
                      {t.name}
                      <span className="text-xs font-normal text-muted">
                        in {t.sessions} sessions
                      </span>
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {t.lines.map((l, i) => (
                        <li key={i} className="flex items-baseline gap-2 text-sm">
                          <span className="min-w-0 flex-1">{l.text}</span>
                          <button
                            className="text-xs text-muted hover:text-accent hover:underline"
                            onClick={() => onOpenNote(l.path)}
                          >
                            {shortDate(l.date)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {detail.carried.length > 0 && (
            <Block title="Carried Forward" count={detail.carried.length}>
              <ul className="space-y-1">
                {detail.carried.map((t) => (
                  <li key={t.id} className="flex items-baseline gap-2 text-sm">
                    <span className="min-w-0 flex-1">{t.description}</span>
                    <button
                      className="text-xs text-muted hover:text-accent hover:underline"
                      onClick={() => onOpenNote(t.path)}
                    >
                      {shortDate(t.date)}
                    </button>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {detail.questions.length > 0 && (
            <Block title="Open Questions" count={detail.questions.length}>
              <ul className="space-y-1">
                {detail.questions.map((q, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-sm">
                    <span className="min-w-0 flex-1">{q.text}</span>
                    <button
                      className="text-xs text-muted hover:text-accent hover:underline"
                      onClick={() => onOpenNote(q.path)}
                    >
                      {shortDate(q.date)}
                    </button>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {detail.decisions.length > 0 && (
            <Block title="Decisions Log" count={detail.decisions.length}>
              <ul className="space-y-1">
                {detail.decisions.map((d, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-sm">
                    <span className="min-w-0 flex-1">{d.text}</span>
                    <button
                      className="text-xs text-muted hover:text-accent hover:underline"
                      onClick={() => onOpenNote(d.path)}
                    >
                      {shortDate(d.date)}
                    </button>
                  </li>
                ))}
              </ul>
            </Block>
          )}
        </>
      )}
    </div>
  )
}
