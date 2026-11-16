import { useEffect, useState } from 'react'
import type { PrepDossier } from '@shared/contract'
import { ageLabel, dayLabel, fmtTime, shortDate, todayIso } from '../format'
import { nudgeTask } from '../nudge'
import { ArrowLeftIcon, SparkleIcon } from './Icons'
import { TaskRowItem } from './TasksView'

type Detail = 'ok' | 'needs-auth' | 'failed'

const btn =
  'rounded-lg border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover disabled:opacity-60'

function Card({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="mb-2 text-sm font-semibold">
        {title}
        {count !== undefined && <span className="font-normal text-muted"> · {count}</span>}
      </h2>
      {children}
    </section>
  )
}

export default function PrepView({
  eventId,
  onBack,
  onStartNotes,
  onBrief,
  onOpenNote,
  onOpenEntity,
  onToggle,
  onSetDue,
  onConnect,
  onFlash
}: {
  eventId: string
  onBack: () => void
  onStartNotes: (eventId: string) => void
  onBrief: (eventId: string, title: string) => void
  onOpenNote: (path: string) => void
  onOpenEntity: (id: string) => void
  onToggle: (id: string, done: boolean) => void
  onSetDue: (id: string, due: string | null) => void
  onConnect: () => void
  onFlash: (m: string) => void
}): React.JSX.Element {
  const [data, setData] = useState<{ dossier: PrepDossier; detail: Detail } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const today = todayIso()

  const load = (refresh = false): void => {
    setLoading(true)
    void window.api.invoke('prep:get', { eventId, refresh }).then((r) => {
      setLoading(false)
      if (r.ok) {
        setData(r.data as { dossier: PrepDossier; detail: Detail })
        setError(null)
      } else setError(r.error.message)
    })
  }

  useEffect(() => {
    let alive = true
    // 1) Paint what is already known straight away. 2) Fetch guests/Meet link from Google if we never have.
    void window.api.invoke('prep:get', { eventId, cacheOnly: true }).then((r) => {
      if (!alive) return
      if (!r.ok) {
        setLoading(false)
        return setError(r.error.message)
      }
      const first = r.data as { dossier: PrepDossier; detail: Detail }
      setData(first)
      if (first.dossier.event.detailFetched) return setLoading(false)
      void window.api.invoke('prep:get', { eventId }).then((r2) => {
        if (!alive) return
        setLoading(false)
        if (r2.ok) setData(r2.data as { dossier: PrepDossier; detail: Detail })
      })
    })
    return () => {
      alive = false
    }
  }, [eventId])

  if (error) {
    return (
      <div className="p-8">
        <button className={btn} onClick={onBack}>
          Back
        </button>
        <p className="mt-4 text-sm text-muted">{error}</p>
      </div>
    )
  }
  if (!data) return <p className="p-8 text-sm text-muted">Preparing your sheet…</p>

  const { dossier: d, detail } = data
  const e = d.event
  const nothing =
    d.attendees.length === 0 &&
    d.series.previous.length === 0 &&
    d.attendeeTasks.length === 0 &&
    d.accountTasks.length === 0 &&
    d.emails.length === 0
  const nudge = (t: PrepDossier['attendeeTasks'][number]): Promise<void> =>
    nudgeTask(t, today, onFlash)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <button
          onClick={onBack}
          className="mb-3 flex items-center gap-1.5 text-sm text-muted hover:text-fg"
        >
          <ArrowLeftIcon width={14} height={14} /> Back
        </button>

        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium tracking-wide text-muted uppercase">Prep sheet</div>
            <h1 className="text-2xl font-semibold tracking-tight">{e.title}</h1>
            <p className="mt-1 text-sm text-muted">
              {dayLabel(e.date)}
              {e.startTime &&
                ` · ${fmtTime(e.startTime)}${e.endTime ? ` – ${fmtTime(e.endTime)}` : ''}`}
              {d.account && ` · ${d.account}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => onBrief(e.id, e.title)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover"
            >
              <SparkleIcon width={14} height={14} className="text-[var(--accent)]" /> Brief me
            </button>
            {e.meetUrl && (
              <button
                className="btn-primary rounded-lg px-3 py-1.5 text-sm font-semibold"
                onClick={() => void window.api.invoke('app:open-external', { url: e.meetUrl! })}
              >
                Join Meet
              </button>
            )}
            <button className={btn} onClick={() => onStartNotes(e.id)}>
              {e.notePath ? 'Open notes' : 'Start notes'}
            </button>
            {(d.attachments ?? []).slice(0, 4).map((a) => (
              <button
                key={a.fileId}
                className={btn}
                title="Open the attached document in Google Drive"
                onClick={() => void window.api.invoke('app:open-external', { url: a.url })}
              >
                📄 {a.title.length > 28 ? a.title.slice(0, 27) + '…' : a.title}
              </button>
            ))}
            <button
              className={btn}
              onClick={() => load(true)}
              disabled={loading}
              title="Reload guests from Google"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </header>

        {loading && !e.detailFetched && (
          <p className="mt-4 text-xs text-muted">
            Loading the guest list and Meet link from Google…
          </p>
        )}
        {detail === 'needs-auth' && (
          <div className="mt-4 rounded-xl border border-line bg-field p-3 text-sm">
            Sign in to Google to see who is invited.{' '}
            <button className="font-medium underline" onClick={onConnect}>
              Sign in
            </button>
          </div>
        )}
        {detail === 'failed' && !e.detailFetched && (
          <p className="mt-4 rounded-lg bg-warn/15 px-3 py-2 text-sm text-warn">
            Could not load the guest list this time. Everything else below is from your own notes.
          </p>
        )}

        {nothing && (
          <p className="mt-8 text-center text-sm text-muted">
            Nothing to prepare from yet. After this meeting, its notes become the next prep sheet.
          </p>
        )}

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {d.attendees.length > 0 && (
            <Card title="Who is coming" count={d.attendees.length}>
              <ul>
                {d.attendees.map((a) => (
                  <li key={a.email} className="flex items-center gap-2 py-1.5 text-sm">
                    <div className="min-w-0 flex-1">
                      {a.personId ? (
                        <button
                          className="font-medium hover:text-accent hover:underline"
                          onClick={() => onOpenEntity(a.personId!)}
                        >
                          {a.name}
                        </button>
                      ) : (
                        <span className="font-medium">{a.name}</span>
                      )}
                      <div className="truncate text-xs text-muted">{a.email}</div>
                    </div>
                    {a.theyOwe > 0 && (
                      <span
                        className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent"
                        title="Open tasks they owe you"
                      >
                        owes you {a.theyOwe}
                      </span>
                    )}
                    {a.lastNoteDate && (
                      <span className="text-xs text-muted" title="Last note that mentions them">
                        {shortDate(a.lastNoteDate)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {(d.series.previous.length > 0 || d.series.questions.length > 0) && (
            <Card title="Last time">
              <ul>
                {d.series.previous.map((p) => (
                  <li key={p.path}>
                    <button
                      onClick={() => onOpenNote(p.path)}
                      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-hover"
                    >
                      <span className="w-14 shrink-0 text-xs tabular-nums text-muted">
                        {shortDate(p.date)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      {p.openTasks > 0 && (
                        <span className="rounded-full bg-hover px-1.5 text-xs tabular-nums text-muted">
                          {p.openTasks} open
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {d.series.questions.length > 0 && (
                <>
                  <h3 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                    Still Unresolved
                  </h3>
                  <ul className="list-disc pl-5 text-sm">
                    {d.series.questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          )}
        </div>

        {d.attendeeTasks.length > 0 && (
          <section className="mt-5">
            <h2 className="mb-1 px-2 text-sm font-semibold">
              Waiting on These People{' '}
              <span className="font-normal text-muted">· {d.attendeeTasks.length}</span>
            </h2>
            <ul>
              {d.attendeeTasks.map((t) => (
                <TaskRowItem
                  key={t.id}
                  task={t}
                  today={today}
                  waiting
                  onToggle={onToggle}
                  onOpenNote={onOpenNote}
                  onSetDue={onSetDue}
                  onNudge={(x) => void nudge(x)}
                />
              ))}
            </ul>
          </section>
        )}

        {d.series.openTasks.length > 0 && (
          <section className="mt-5">
            <h2 className="mb-1 px-2 text-sm font-semibold">
              Open From the Last Meetings{' '}
              <span className="font-normal text-muted">· {d.series.openTasks.length}</span>
            </h2>
            <ul>
              {d.series.openTasks.map((t) => (
                <TaskRowItem
                  key={t.id}
                  task={t}
                  today={today}
                  waiting={!t.isMine}
                  onToggle={onToggle}
                  onOpenNote={onOpenNote}
                  onSetDue={onSetDue}
                  onNudge={(x) => void nudge(x)}
                />
              ))}
            </ul>
          </section>
        )}

        {d.accountTasks.length > 0 && (
          <section className="mt-5">
            <h2 className="mb-1 px-2 text-sm font-semibold">
              Your Open Work for {d.account}{' '}
              <span className="font-normal text-muted">· {d.accountTasks.length}</span>
            </h2>
            <ul>
              {d.accountTasks.map((t) => (
                <TaskRowItem
                  key={t.id}
                  task={t}
                  today={today}
                  waiting={false}
                  onToggle={onToggle}
                  onOpenNote={onOpenNote}
                  onSetDue={onSetDue}
                  onNudge={(x) => void nudge(x)}
                />
              ))}
            </ul>
          </section>
        )}

        {d.emails.length > 0 && (
          <section className="mt-5 pb-10">
            <h2 className="mb-1 px-2 text-sm font-semibold">
              Recent Email <span className="font-normal text-muted">· {d.emails.length}</span>
            </h2>
            <ul>
              {d.emails.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => void window.api.invoke('gmail:open-thread', { id: m.id })}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-hover"
                    title="Open in Gmail"
                  >
                    {m.starred && (
                      <span className="text-warn" aria-label="Starred">
                        ★
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{m.subject}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {m.from}
                      {m.when ? ` · ${ageLabel(m.when)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
