import { useCallback, useEffect, useState } from 'react'
import EmptyState from './EmptyState'
import type { ChatConversation, ChatOverview } from '@shared/contract'
import { relativeTime } from '../format'

const btn =
  'rounded-md border border-line bg-field px-2 py-0.5 text-xs font-medium hover:bg-hover disabled:opacity-60'

const REASON: Record<string, string> = {
  dm: 'Direct message',
  mention: 'Mentions you',
  'reply-to-me': 'Reply in your thread',
  question: 'Asks a question',
  deadline: 'Has a deadline',
  topic: 'About something you track',
  frequent: 'Someone you talk to often',
  recent: 'Recent',
  unanswered: 'Waiting for your reply'
}

const hours = (h: number): string => (h < 24 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`)

function Card({
  c,
  onFeedback
}: {
  c: ChatConversation
  onFeedback: (c: ChatConversation, relevant: boolean) => void
}): React.JSX.Element {
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{c.title}</span>
        <span className="shrink-0 text-xs text-muted">{relativeTime(c.lastAt)}</span>
      </div>
      <div className="mt-0.5 truncate text-sm text-muted">
        {c.lastFromMe ? 'You: ' : `${c.lastSender}: `}
        {c.lastText}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {c.awaitingMeHours > 0 && (
          <span className="rounded-full bg-accent-soft px-2 text-xs text-accent">
            You haven’t replied in {hours(c.awaitingMeHours)}
          </span>
        )}
        {c.awaitingThemHours > 0 && (
          <span className="rounded-full bg-accent-soft px-2 text-xs text-accent">
            No answer for {hours(c.awaitingThemHours)}
          </span>
        )}
        {c.reasons
          .filter((r) => r !== 'recent' && r !== 'unanswered')
          .map((r) => (
            <span key={r} className="rounded-full border border-line px-2 text-xs text-muted">
              {REASON[r] ?? r}
            </span>
          ))}
        <span className="ml-auto flex gap-1">
          <button className={btn} title="Show more like this" onClick={() => onFeedback(c, true)}>
            Relevant
          </button>
          <button className={btn} title="Show less like this" onClick={() => onFeedback(c, false)}>
            Not relevant
          </button>
        </span>
      </div>
    </li>
  )
}

function Group({
  title,
  hint,
  items,
  onFeedback
}: {
  title: string
  hint: string
  items: ChatConversation[]
  onFeedback: (c: ChatConversation, relevant: boolean) => void
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <section className="mb-6">
      <h2 className="px-1 text-sm font-semibold">
        {title}
        <span className="font-normal text-muted"> · {items.length}</span>
      </h2>
      <p className="mb-2 px-1 text-xs text-muted">{hint}</p>
      <ul className="space-y-2">
        {items.map((c) => (
          <Card key={c.key} c={c} onFeedback={onFeedback} />
        ))}
      </ul>
    </section>
  )
}

export default function ChatView({
  onSettings,
  embedded = false
}: {
  onSettings: () => void
  /** Shown inside the Inbox: no page title or outer frame. */
  embedded?: boolean
}): React.JSX.Element {
  const [data, setData] = useState<ChatOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSpaces, setShowSpaces] = useState(false)

  const load = useCallback(async () => {
    const r = await window.api.invoke('chat:overview')
    if (r.ok) setData(r.data)
    else setError(r.error.message)
  }, [])
  useEffect(() => {
    const first = setTimeout(() => void load(), 0)
    const t = setInterval(() => void load(), 60_000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [load])

  const feedback = async (c: ChatConversation, relevant: boolean): Promise<void> => {
    await window.api.invoke('chat:feedback', { key: c.key, reasons: c.reasons, relevant })
    await load()
  }
  const setMode = async (
    space: string,
    mode: ChatOverview['spaces'][number]['mode']
  ): Promise<void> => {
    await window.api.invoke('chat:set-mode', { space, mode })
    await load()
  }

  if (error)
    return (
      <EmptyState
        className="mt-10"
        icon="⚠️"
        tone="error"
        title="Chat could not load"
        body={error}
        action={{
          label: 'Try again',
          onClick: () => {
            setError(null)
            void load()
          }
        }}
        secondary={{ label: 'Google Settings', onClick: onSettings }}
      />
    )
  if (!data) return <div className="p-6 text-sm text-muted">Loading…</div>
  if (data.source === 'none')
    return (
      <EmptyState
        className="mt-10"
        icon="💬"
        title="Chat is not connected"
        body="Connect your Google account to see which conversations need a reply and what you promised."
        action={{ label: 'Connect Google', onClick: onSettings }}
      />
    )
  const by = (b: ChatConversation['bucket']): ChatConversation[] =>
    data.conversations.filter((c) => c.bucket === b)
  const fb = (c: ChatConversation, r: boolean): void => void feedback(c, r)

  return (
    <div
      className={embedded ? 'pt-4' : 'mx-auto h-full max-w-3xl overflow-y-auto p-6'}
      data-testid="chat-view"
    >
      {!embedded && <h1 className="text-lg font-semibold">Chat</h1>}
      <p className="mb-4 text-sm text-muted">
        {data.complete
          ? 'All your direct messages, group chats and followed spaces.'
          : 'Partial coverage: mentions and missed messages only. Full Chat needs Google sign-in (OAuth) with the Chat API enabled.'}
        {data.lastAt && ` Updated ${relativeTime(data.lastAt)}.`}{' '}
        <button className="text-[var(--accent)] underline" onClick={onSettings}>
          Google Settings
        </button>
      </p>

      <Group
        title="Needs you"
        hint="Someone is waiting on you."
        items={by('needs-you')}
        onFeedback={fb}
      />
      <Group
        title="Waiting on them"
        hint="You asked, and nobody has answered yet."
        items={by('waiting')}
        onFeedback={fb}
      />
      <Group
        title="Worth a Look"
        hint="Relevant, nothing to answer."
        items={by('fyi')}
        onFeedback={fb}
      />

      {data.commitments.length > 0 && (
        <section className="mb-6">
          <h2 className="px-1 text-sm font-semibold">What You Said You’d Do</h2>
          <ul className="mt-1 space-y-1">
            {data.commitments.map((m, i) => (
              <li key={i} className="rounded-md border border-line px-3 py-1.5 text-sm">
                {m.text}
                <span className="text-xs text-muted">
                  {' '}
                  · {m.spaceName}, {relativeTime(m.at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.conversations.length === 0 && (
        <div className="text-sm text-muted">Nothing needs you right now.</div>
      )}

      <button className={btn} onClick={() => setShowSpaces(!showSpaces)}>
        {showSpaces ? 'Hide' : 'Choose what to follow'}
      </button>
      {showSpaces && (
        <ul className="mt-2 space-y-1">
          {data.spaces.map((s) => (
            <li key={s.space} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {s.name} <span className="text-xs text-muted">({s.type})</span>
              </span>
              <select
                value={s.mode}
                onChange={(e) => void setMode(s.space, e.target.value as typeof s.mode)}
                className="rounded-md border border-line bg-field px-2 py-0.5 text-xs"
              >
                <option value="auto">Automatic</option>
                <option value="track">Everything</option>
                <option value="mentions">Mentions and replies</option>
                <option value="ignore">Ignore</option>
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
