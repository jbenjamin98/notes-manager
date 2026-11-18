import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildFeed, type ActionBucket, type Feed } from '@shared/actionFeed'
import { useNow } from '../hooks'
import { useNavState } from '../nav'
import ActionCard from './ActionCard'
import EmptyState from './EmptyState'

const TABS: { id: ActionBucket; label: string; hint: string }[] = [
  { id: 'needs-you', label: 'Needs you', hint: 'Waiting on a decision or reply from you.' },
  { id: 'waiting', label: 'Waiting on them', hint: 'You asked or wrote last; no answer yet.' },
  {
    id: 'hidden',
    label: 'Hidden',
    hint: 'Looks unimportant: bulk, copied or old. Mark what matters.'
  }
]

/**
 * One list for everything that wants you: email, chat and what was pulled out of meetings.
 * Anything that looks unimportant is held back under Hidden, so what is shown is worth a look.
 */
export default function ActionCenter({
  onFlash,
  onSettings
}: {
  onFlash: (m: string, undo?: () => void) => void
  onSettings: () => void
}): React.JSX.Element {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [connected, setConnected] = useState(true)
  const [checking, setChecking] = useState(false)
  const [tab, setTab] = useNavState<ActionBucket>('dash.tab', 'needs-you')
  const now = useNow()

  const load = useCallback(() => {
    void Promise.all([
      window.api.invoke('gmail:overview'),
      window.api.invoke('chat:overview'),
      window.api.invoke('inbox:list')
    ]).then(([m, c, i]) => {
      setConnected(m.ok || c.ok)
      setFeed(buildFeed(m.ok ? m.data : null, c.ok ? c.data : null, i.ok ? i.data : []))
    })
  }, [])

  useEffect(() => {
    load()
    const offG = window.api.on('gmail:changed', load)
    const offV = window.api.on('assistant:changed', load)
    const t = setInterval(load, 5 * 60_000)
    return () => {
      offG()
      offV()
      clearInterval(t)
    }
  }, [load])

  const items = useMemo(() => (feed?.items ?? []).filter((i) => i.bucket === tab), [feed, tab])

  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="action-center">
      <header className="flex items-center gap-2 px-1 pb-2">
        <span className="flex-1" />
        <button
          title="Look through your latest meetings, mail and chat for new actions and decisions"
          disabled={checking}
          className="rounded-md px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-60"
          onClick={() => {
            setChecking(true)
            void window.api
              .invoke('inbox:refresh')
              .catch(() => undefined)
              .finally(() => {
                setChecking(false)
                load()
              })
          }}
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </header>
      <div
        role="group"
        aria-label="Action Center"
        className="mb-2 grid grid-cols-3 gap-1 rounded-full border border-line bg-field/70 p-0.5 text-xs font-semibold"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            aria-pressed={tab === t.id}
            data-testid={`ac-tab-${t.id}`}
            title={t.hint}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-2 py-1 ${tab === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
          >
            {t.label}
            {feed && feed.counts[t.id] > 0 && (
              <span className="ml-1 tabular-nums">{feed.counts[t.id]}</span>
            )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {feed === null ? (
          <p className="px-2 py-6 text-center text-sm text-muted">Looking…</p>
        ) : items.length === 0 ? (
          !connected && tab === 'needs-you' ? (
            <EmptyState
              title="Connect Google to see your mail"
              body="Email and chat that need you show up here, ranked by how much they matter."
              action={{ label: 'Open Settings', onClick: onSettings }}
            />
          ) : (
            <EmptyState
              title={tab === 'hidden' ? 'Nothing hidden' : 'All clear'}
              body={
                tab === 'needs-you'
                  ? 'Nothing needs you right now.'
                  : tab === 'waiting'
                    ? 'You are not waiting on anyone.'
                    : 'Bulk, copied and old mail would be listed here.'
              }
            />
          )
        ) : (
          <ul className="space-y-2" data-testid="action-list">
            {items.map((i) => (
              <ActionCard key={i.key} item={i} now={now} onChanged={load} onFlash={onFlash} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
