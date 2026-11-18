import { useEffect, useState } from 'react'
import type { Insights } from '@shared/contract'
import { Network, WordCloud } from './Charts'

const RANGES: [number | null, string][] = [
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
  [null, 'All time']
]

export default function InsightsView({
  onOpenEntity
}: {
  onOpenEntity: (id: string) => void
}): React.JSX.Element {
  const [days, setDays] = useState<number | null>(30)
  const [data, setData] = useState<Insights | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api
        .invoke('insights:analyze', { days })
        .then((r) => alive && r.ok && setData(r.data))
    }
    load()
    const off = window.api.on('vault:changed', load)
    return () => {
      alive = false
      off()
    }
  }, [days])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <header className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Topics &amp; Insights</h1>
            <p className="mt-1 text-sm text-muted">
              {data
                ? `${data.notes} note${data.notes === 1 ? '' : 's'} analyzed. Everything is computed on this computer.`
                : 'Analyzing…'}
            </p>
          </div>
          <div
            role="radiogroup"
            aria-label="Time range"
            className="inline-flex gap-1 rounded-lg bg-hover p-1"
          >
            {RANGES.map(([d, label]) => (
              <button
                key={label}
                role="radio"
                aria-checked={days === d}
                onClick={() => setDays(d)}
                className={`rounded-md px-3 py-1 text-sm font-medium ${
                  days === d ? 'bg-field shadow-sm' : 'text-muted hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        {data && data.notes === 0 ? (
          <p className="py-16 text-center text-sm text-muted">No notes in this time range.</p>
        ) : (
          data && (
            <>
              <section className="mt-6 rounded-2xl border border-line bg-surface p-4">
                <h2 className="text-sm font-semibold">What You Talk About</h2>
                <p className="mb-2 text-xs text-muted">
                  Bigger words come up more often across your notes.
                </p>
                {data.words.length > 0 ? (
                  <WordCloud words={data.words} />
                ) : (
                  <p className="py-6 text-center text-sm text-muted">Not enough text yet.</p>
                )}
              </section>

              <section className="mt-6 rounded-2xl border border-line bg-surface p-4">
                <h2 className="text-sm font-semibold">How Things Connect</h2>
                <p className="mb-2 text-xs text-muted">
                  People, accounts, systems and topics that show up in the same notes are linked.
                  Click one to open it.
                </p>
                {data.nodes.length > 0 ? (
                  <Network nodes={data.nodes} edges={data.edges} onOpen={onOpenEntity} />
                ) : (
                  <p className="py-6 text-center text-sm text-muted">
                    Nothing to connect yet. Use @names, #tags or an account on a note.
                  </p>
                )}
              </section>
            </>
          )
        )}
      </div>
    </div>
  )
}
