import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildReview, type ActionItem } from '@shared/actionFeed'
import { useNow } from '../hooks'
import ActionCard from './ActionCard'
import EmptyState from './EmptyState'

const GROUPS: { title: string; hint: string; kinds: string[] }[] = [
  { title: 'Decisions', hint: 'Choices that were made or agreed.', kinds: ['decision'] },
  { title: 'Changes', hint: 'Dates, scope or plans that moved.', kinds: ['change'] },
  { title: 'Facts', hint: 'Roles and relationships: who owns or sponsors what.', kinds: ['fact'] }
]

/**
 * Decisions, changes and facts pulled from meetings, email and chat. There is nothing to do about
 * them, so they are not in the Action Center: keep the ones worth remembering (they are written
 * into the note) and mark the rest not pertinent.
 */
export default function FactsPage({
  onFlash
}: {
  onFlash: (m: string, undo?: () => void) => void
}): React.JSX.Element {
  const [items, setItems] = useState<ActionItem[] | null>(null)
  const now = useNow()

  const load = useCallback(() => {
    void window.api.invoke('inbox:list').then((r) => setItems(buildReview(r.ok ? r.data : [])))
  }, [])
  useEffect(() => {
    load()
    const off = window.api.on('assistant:changed', load)
    return off
  }, [load])

  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: (items ?? []).filter((i) => i.kind === 'insight' && g.kinds.includes(i.insight.kind))
      })).filter((g) => g.items.length > 0),
    [items]
  )

  return (
    <div className="h-full overflow-y-auto px-6 py-5" data-testid="facts-page">
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Decisions &amp; Facts</h1>
        <p className="mt-1 mb-4 text-xs text-muted">
          Things worth knowing, found in your meetings, email and chat. Keep the useful ones (they
          are saved into the note) and mark the rest not pertinent.
        </p>
        {items === null ? (
          <p className="text-sm text-muted">Looking…</p>
        ) : groups.length === 0 ? (
          <EmptyState
            title="Nothing to review"
            body="New decisions, changes and facts appear here as your meetings and mail are read."
          />
        ) : (
          groups.map((g) => (
            <section key={g.title} className="mb-5">
              <h2 className="mb-0.5 flex items-center gap-2 text-sm font-semibold">
                {g.title}
                <span className="rounded-full bg-hover px-1.5 text-xs font-normal tabular-nums text-muted">
                  {g.items.length}
                </span>
              </h2>
              <p className="mb-2 text-xs text-muted">{g.hint}</p>
              <ul className="space-y-2">
                {g.items.map((i) => (
                  <ActionCard key={i.key} item={i} now={now} onChanged={load} onFlash={onFlash} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
