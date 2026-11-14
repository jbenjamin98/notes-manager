import { useCallback, useEffect, useState } from 'react'
import type { Rollup } from '@shared/contract'
import { addDays, shortDate, todayIso } from '../format'

const btn =
  'rounded-md border border-line bg-field px-2.5 py-1 text-xs font-medium hover:bg-hover disabled:opacity-50'

function Tile({ n, label, tone }: { n: number; label: string; tone?: 'warn' }): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3 text-center">
      <div className={`text-2xl font-semibold ${tone === 'warn' && n > 0 ? 'text-warn' : ''}`}>
        {n}
      </div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  )
}

function Block({
  title,
  empty,
  children
}: {
  title: string
  empty?: boolean
  children: React.ReactNode
}): React.JSX.Element | null {
  if (empty) return null
  return (
    <section className="mb-5">
      <h2 className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
        {title}
      </h2>
      <ul className="space-y-1 rounded-2xl border border-line bg-surface p-2">{children}</ul>
    </section>
  )
}

export default function RollupView({
  onOpenNote,
  onFlash
}: {
  onOpenNote: (path: string) => void
  onFlash: (m: string) => void
}): React.JSX.Element {
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined)
  const [r, setR] = useState<Rollup | null>(null)

  const load = useCallback((ws?: string) => {
    void window.api.invoke('rollup:get', ws ? { weekStart: ws } : undefined).then((x) => {
      if (x.ok) {
        setR(x.data)
        setWeekStart(x.data.weekStart)
      }
    })
  }, [])
  useEffect(() => load(), [load])

  const thisWeek = r ? r.weekStart <= todayIso() && todayIso() <= r.weekEnd : true

  const copy = async (): Promise<void> => {
    if (!r) return
    try {
      await navigator.clipboard.writeText(r.markdown)
      onFlash('Copied. Paste it into an email or doc.')
    } catch {
      onFlash('Could not copy. Use "Save as note" instead.')
    }
  }
  const save = async (): Promise<void> => {
    if (!weekStart) return
    const x = await window.api.invoke('rollup:save-note', { weekStart })
    if (!x.ok) return onFlash(x.error.message)
    onFlash('Saved as a note.')
    onOpenNote(x.data.path)
  }

  const task = (t: Rollup['completed'][number]): React.JSX.Element => (
    <li key={t.id}>
      <button
        className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-hover"
        onClick={() => onOpenNote(t.notePath)}
      >
        <span className="min-w-0 flex-1 truncate">{t.description}</span>
        {t.owner !== 'Me' && <span className="text-xs text-muted">{t.owner}</span>}
        {t.due && <span className="text-xs text-muted">due {shortDate(t.due)}</span>}
      </button>
    </li>
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <header className="mb-4 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Weekly review</h1>
            <p className="mt-1 text-xs text-muted">
              {r ? `${shortDate(r.weekStart)} to ${shortDate(r.weekEnd)}` : 'Loading…'}
              {thisWeek ? ' (this week)' : ''}. Worked out on this computer from your notes and
              tasks.
            </p>
          </div>
          <button
            className={btn}
            aria-label="Previous week"
            onClick={() => weekStart && load(addDays(weekStart, -7))}
          >
            ←
          </button>
          <button
            className={btn}
            aria-label="Next week"
            disabled={thisWeek}
            onClick={() => weekStart && load(addDays(weekStart, 7))}
          >
            →
          </button>
        </header>

        {r && (
          <>
            <div className="mb-5 grid grid-cols-4 gap-3">
              <Tile n={r.notes.length} label="meetings & notes" />
              <Tile n={r.completed.length} label="tasks done" />
              <Tile n={r.createdCount} label="new tasks" />
              <Tile n={r.overdue.length} label="overdue" tone="warn" />
            </div>

            <div className="mb-5 flex gap-2">
              <button className={btn} onClick={() => void copy()}>
                Copy as text
              </button>
              <button className={btn} onClick={() => void save()}>
                Save as note
              </button>
            </div>

            {r.notes.length + r.completed.length + r.overdue.length === 0 && (
              <p className="py-10 text-center text-sm text-muted">
                Nothing recorded for this week yet.
              </p>
            )}

            <Block title="Finished" empty={r.completed.length === 0}>
              {r.completed.map(task)}
            </Block>
            <Block title="Meetings & notes" empty={r.notes.length === 0}>
              {r.notes.map((n) => (
                <li key={n.path}>
                  <button
                    className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-hover"
                    onClick={() => onOpenNote(n.path)}
                  >
                    <span className="w-14 shrink-0 text-xs text-muted">{shortDate(n.date)}</span>
                    <span className="min-w-0 flex-1 truncate">{n.title}</span>
                    {n.account && <span className="text-xs text-muted">{n.account}</span>}
                  </button>
                </li>
              ))}
            </Block>
            <Block title="Overdue" empty={r.overdue.length === 0}>
              {r.overdue.map(task)}
            </Block>
            <Block title="Coming up next week" empty={r.comingUp.length === 0}>
              {r.comingUp.map(task)}
            </Block>
            <Block title="Waiting on others" empty={r.waitingOn.length === 0}>
              {r.waitingOn.map((w) => (
                <li key={w.owner} className="flex justify-between px-2 py-1 text-sm">
                  <span>{w.owner}</span>
                  <span className="text-xs text-muted">{w.count} open</span>
                </li>
              ))}
            </Block>
            {r.people.length > 0 && (
              <p className="px-1 text-xs text-muted">
                Most mentioned: {r.people.map((p) => `${p.name} (${p.notes})`).join(', ')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
