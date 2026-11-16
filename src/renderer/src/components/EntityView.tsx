import { useEffect, useState } from 'react'
import type { InsightItem } from '@shared/contract'
import SourceChip from './SourceChip'
import { SparkleIcon } from './Icons'
import type { Dossier } from '@shared/contract'
import { dayLabel, shortDate, todayIso } from '../format'
import { nudgeTask } from '../nudge'
import { ActivityChart } from './Charts'
import { TaskRowItem } from './TasksView'

const LABEL: Record<string, string> = {
  person: 'Person',
  customer: 'Account',
  system: 'System',
  topic: 'Topic',
  event: 'Event'
}

const KIND_NAME: Record<InsightItem['kind'], string> = {
  action: 'Action',
  ask: 'Asked of you',
  promise: 'You promised',
  decision: 'Decision',
  question: 'Question',
  risk: 'Risk',
  change: 'Change',
  fact: 'Fact'
}

export default function EntityView({
  id,
  onOpenNote,
  onEdit,
  onCatchUp,
  onToggle,
  onSetDue,
  onFlash,
  onReview
}: {
  id: string
  onOpenNote: (path: string) => void
  onEdit: (d: Dossier) => void
  onCatchUp: (id: string, name: string) => void
  onToggle: (id: string, done: boolean) => void
  onSetDue: (id: string, due: string | null) => void
  onFlash: (m: string) => void
  /** Open Review Names (sort out notes that only say a shared first name). */
  onReview?: () => void
}): React.JSX.Element {
  const [d, setD] = useState<Dossier | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [known, setKnown] = useState<InsightItem[]>([])
  const today = todayIso()

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api.invoke('entities:detail', { id }).then((r) => {
        if (!alive) return
        if (r.ok) {
          setD(r.data)
          setError(null)
          // What we know about them from meetings, email and chat, each with its source.
          void window.api
            .invoke('insights:for-entity', { name: r.data.name })
            .then((k) => alive && k.ok && setKnown(k.data))
        } else setError(r.error.message)
      })
    }
    load()
    const off = window.api.on('vault:changed', load)
    return () => {
      alive = false
      off()
    }
  }, [id])

  if (error) return <p className="p-8 text-sm text-muted">{error}</p>
  if (!d) return <p className="p-8 text-sm text-muted">Loading…</p>

  const canRegister = d.category !== 'topic' && d.category !== 'event'
  const last = d.notes[0]?.date
  const nudge = (t: Dossier['tasks'][number]): Promise<void> => nudgeTask(t, today, onFlash)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium tracking-wide text-muted uppercase">
              {LABEL[d.category]}
              {!d.inRegistry && canRegister && ' · found in your notes'}
            </div>
            <h1 className="truncate text-2xl font-semibold tracking-tight">{d.name}</h1>
            {d.aliases.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.aliases.map((a) => (
                  <span
                    key={a}
                    className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent"
                  >
                    {a}
                  </span>
                ))}
              </div>
            )}
            <p className="mt-2 text-sm text-muted">
              {d.totalNotes} note{d.totalNotes === 1 ? '' : 's'} · {d.totalMentions} mention
              {d.totalMentions === 1 ? '' : 's'}
              {last ? ` · last ${dayLabel(last).toLowerCase()}` : ''}
            </p>
          </div>
          <button
            onClick={() => onCatchUp(d.id, d.name)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover"
          >
            <SparkleIcon width={14} height={14} className="text-[var(--accent)]" /> Catch me up
          </button>
          {canRegister && (
            <button
              onClick={() => onEdit(d)}
              className="shrink-0 rounded-lg border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover"
            >
              {d.inRegistry ? 'Edit Names' : 'Add Nicknames'}
            </button>
          )}
          {d.category === 'person' && onReview && (
            <button
              onClick={onReview}
              title="Notes that only say a name several things share"
              className="shrink-0 rounded-lg border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover"
            >
              Review Mentions
            </button>
          )}
        </header>

        {known.length > 0 && (
          <section className="mt-6" aria-label="What We Know">
            <h2 className="mb-1 px-2 text-sm font-semibold">
              What We Know <span className="font-normal text-muted">· {known.length}</span>
            </h2>
            <ul className="space-y-1.5">
              {known.slice(0, 12).map((k) => (
                <li
                  key={k.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm"
                >
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                    {KIND_NAME[k.kind]}
                  </span>
                  <span className="min-w-0 flex-1">{k.text}</span>
                  <SourceChip id={k.id} label={k.sourceLabel} onOpenNote={onOpenNote} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-6 rounded-2xl border border-line bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold">Activity</h2>
          <ActivityChart weeks={d.weeks} />
        </section>

        <section className="mt-6">
          <h2 className="mb-1 px-2 text-sm font-semibold">
            Open Tasks <span className="font-normal text-muted">· {d.tasks.length}</span>
          </h2>
          {d.tasks.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted">Nothing open for {d.name}.</p>
          ) : (
            <ul>
              {d.tasks.map((t) => (
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
          )}
        </section>

        <section className="mt-6 pb-10">
          <h2 className="mb-1 px-2 text-sm font-semibold">
            Notes <span className="font-normal text-muted">· newest first</span>
          </h2>
          <ul>
            {d.notes.map((n) => (
              <li key={n.path}>
                <button
                  onClick={() => onOpenNote(n.path)}
                  className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-hover"
                >
                  <span className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted">
                    {shortDate(n.date)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {n.title}
                      {n.account ? <span className="text-muted"> · {n.account}</span> : null}
                    </span>
                    {n.snippet && (
                      <span className="block truncate text-xs text-muted">{n.snippet}</span>
                    )}
                  </span>
                  {n.mentions > 1 && (
                    <span className="rounded-full bg-hover px-1.5 text-xs tabular-nums text-muted">
                      ×{n.mentions}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
