import { useCallback, useEffect, useState } from 'react'
import type { InsightItem } from '@shared/contract'
import { relativeTime } from '../format'
import { useNavState } from '../nav'
import ChatView from './ChatView'
import EmptyState from './EmptyState'
import SourceChip from './SourceChip'

const GROUPS: { title: string; hint: string; kinds: InsightItem['kind'][] }[] = [
  { title: 'To do', hint: 'Things you or others need to do.', kinds: ['ask', 'promise', 'action'] },
  {
    title: 'Decisions and changes',
    hint: 'What was settled, and what moved.',
    kinds: ['decision', 'change']
  },
  {
    title: 'Risks and open questions',
    hint: 'What could go wrong or is still unanswered.',
    kinds: ['risk', 'question']
  },
  { title: 'Who is who', hint: 'Roles and relationships.', kinds: ['fact'] }
]

const KIND_LABEL: Record<InsightItem['kind'], string> = {
  action: 'Action',
  ask: 'Asked of you',
  promise: 'You promised',
  decision: 'Decision',
  question: 'Question',
  risk: 'Risk',
  change: 'Change',
  fact: 'Fact'
}

const isTask = (k: InsightItem['kind']): boolean => k === 'action' || k === 'ask' || k === 'promise'

function Card({
  i,
  busy,
  onAccept,
  onDismiss,
  onOpenNote
}: {
  i: InsightItem
  busy: boolean
  onAccept: (i: InsightItem) => void
  onDismiss: (i: InsightItem) => void
  onOpenNote: (path: string) => void
}): React.JSX.Element {
  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">
          {KIND_LABEL[i.kind]}
        </span>
        {i.owner && i.owner !== 'Me' && <span>@{i.owner}</span>}
        {i.due && <span>Due {i.due}</span>}
        {i.sourceAt && <span className="ml-auto">{relativeTime(i.sourceAt)}</span>}
      </div>
      <p className="mt-1.5 text-sm leading-snug">{i.text}</p>
      {i.sourceSnippet && i.sourceSnippet !== i.text && (
        <p className="mt-1 line-clamp-2 border-l-2 border-line pl-2 text-xs text-muted">
          {i.sourceSnippet}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <SourceChip id={i.id} label={i.sourceLabel} onOpenNote={onOpenNote} />
        {i.entities.slice(0, 3).map((e) => (
          <span key={e} className="rounded-full bg-hover px-2 py-0.5 text-xs text-muted">
            {e}
          </span>
        ))}
        <span className="ml-auto flex gap-1.5">
          <button
            disabled={busy}
            onClick={() => onAccept(i)}
            className="rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {isTask(i.kind) && i.mine
              ? 'Add as Task'
              : isTask(i.kind)
                ? 'Save to Waiting On'
                : 'Save to Notes'}
          </button>
          <button
            disabled={busy}
            onClick={() => onDismiss(i)}
            className="rounded-full border border-line bg-field px-3 py-1 text-xs font-medium hover:bg-hover disabled:opacity-50"
          >
            Dismiss
          </button>
        </span>
      </div>
    </li>
  )
}

/** Everything worth knowing from your meetings, email and chat, each pointing back to its source. */
export default function InboxView({
  onSettings,
  onOpenNote,
  onFlash
}: {
  onSettings: () => void
  onOpenNote: (path: string) => void
  onFlash: (msg: string) => void
}): React.JSX.Element {
  const [tab, setTab] = useNavState<'insights' | 'reply'>('chat.tab', 'insights')
  const [items, setItems] = useState<InsightItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (refresh = false) => {
    if (refresh) await window.api.invoke('inbox:refresh')
    const r = await window.api.invoke('inbox:list')
    if (r.ok) {
      setItems(r.data)
      setError(null)
    } else setError(r.error.message)
  }, [])
  useEffect(() => {
    const first = setTimeout(() => void load(), 0)
    const t = setInterval(() => void load(), 60_000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [load])

  const accept = async (i: InsightItem): Promise<void> => {
    setBusy(true)
    const r = await window.api.invoke('inbox:accept', { id: i.id })
    setBusy(false)
    if (!r.ok) return onFlash(r.error.message)
    onFlash(
      r.data.kind === 'task'
        ? 'Added to your tasks.'
        : r.data.kind === 'waiting'
          ? `Saved to Waiting On${i.owner ? ` (${i.owner})` : ''}.`
          : 'Saved to your notes.'
    )
    void load()
  }
  const dismiss = async (i: InsightItem): Promise<void> => {
    await window.api.invoke('inbox:dismiss', { id: i.id })
    void load()
  }

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6" data-testid="inbox-view">
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Inbox</h1>
        <div
          role="tablist"
          aria-label="Inbox sections"
          className="relative grid w-64 grid-cols-2 rounded-full border border-line bg-field/70 p-0.5 text-xs font-semibold"
        >
          <span
            aria-hidden
            className="seg-pill absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full"
            style={{ transform: tab === 'insights' ? 'translateX(0)' : 'translateX(100%)' }}
          />
          {(
            [
              ['insights', `What Matters${items?.length ? ` · ${items.length}` : ''}`],
              ['reply', 'Needs a Reply']
            ] as ['insights' | 'reply', string][]
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`relative z-10 rounded-full py-1 transition-colors ${tab === k ? 'text-white' : 'text-muted hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'insights' && (
          <button
            onClick={() => void load(true)}
            className="ml-auto rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg"
          >
            Check Now
          </button>
        )}
      </div>

      {tab === 'reply' ? (
        <ChatView onSettings={onSettings} embedded />
      ) : error ? (
        <EmptyState
          className="mt-8"
          icon="⚠️"
          tone="error"
          title="The inbox could not load"
          body={error}
          action={{ label: 'Try again', onClick: () => void load() }}
        />
      ) : !items ? (
        <p className="mt-6 text-sm text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState
          className="mt-8"
          icon="🗂️"
          title="Nothing new from your meetings, email or chat"
          body="Actions, decisions, risks and key facts will appear here with a link back to where they came from. Nothing is added to your notes until you say so."
          secondary={{ label: 'Google Settings', onClick: onSettings }}
        />
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            The important parts of your meetings, email and chat. Each one links back to where it
            came from.
          </p>
          {GROUPS.map((g) => {
            const list = items.filter((i) => g.kinds.includes(i.kind))
            if (!list.length) return null
            return (
              <section key={g.title} className="mb-6">
                <h2 className="px-1 text-sm font-semibold">
                  {g.title}
                  <span className="font-normal text-muted"> · {list.length}</span>
                </h2>
                <p className="mb-2 px-1 text-xs text-muted">{g.hint}</p>
                <ul className="space-y-2">
                  {list.map((i) => (
                    <Card
                      key={i.id}
                      i={i}
                      busy={busy}
                      onAccept={(x) => void accept(x)}
                      onDismiss={(x) => void dismiss(x)}
                      onOpenNote={onOpenNote}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}
