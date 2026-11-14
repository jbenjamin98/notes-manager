import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, Proposal } from '@shared/contract'
import { SparkleIcon } from './Icons'

const field =
  'w-full rounded-md border border-line bg-field px-2 py-1 text-sm outline-none focus:border-[var(--accent)]'
const btn =
  'rounded-md border border-line bg-field px-2.5 py-1 text-xs font-medium hover:bg-hover disabled:opacity-50'
const btnPrimary =
  'rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50'

type Edits = Record<string, unknown>

function Card({
  p,
  busy,
  error,
  onApply,
  onDismiss,
  onOpenNote
}: {
  p: Proposal
  busy: boolean
  error: string | null
  onApply: (edits: Edits) => void
  onDismiss: () => void
  onOpenNote: (path: string) => void
}): React.JSX.Element {
  const [e, setE] = useState<Edits>({})
  const val = <K extends string>(k: K, fallback: string): string =>
    typeof e[k] === 'string' ? (e[k] as string) : fallback
  const set = (k: string, v: unknown): void => setE((x) => ({ ...x, [k]: v }))
  const pending = p.status === 'pending'

  const label =
    p.kind === 'task'
      ? 'Task'
      : p.kind === 'note'
        ? p.noteKind === 'meeting'
          ? 'Meeting note'
          : 'Note'
        : 'Reminder'

  return (
    <div
      className={`rounded-xl border border-line bg-surface p-2.5 text-sm ${p.status === 'dismissed' ? 'opacity-50' : ''}`}
      data-testid="proposal"
    >
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold tracking-wide text-muted uppercase">
        <span>{label}</span>
        {p.status === 'applied' && <span className="text-ok">Added</span>}
        {p.status === 'dismissed' && <span>Dismissed</span>}
      </div>

      {p.kind === 'task' && (
        <div className="space-y-1.5">
          <input
            className={field}
            disabled={!pending}
            value={val('description', p.description)}
            onChange={(x) => set('description', x.target.value)}
            aria-label="Task"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <label className="text-[11px] text-muted">
              Owner
              <input
                className={field}
                disabled={!pending}
                value={val('owner', p.owner)}
                onChange={(x) => set('owner', x.target.value)}
              />
            </label>
            <label className="text-[11px] text-muted">
              Due
              <input
                type="date"
                className={field}
                disabled={!pending}
                value={'due' in e ? ((e.due as string | null) ?? '') : (p.due ?? '')}
                onChange={(x) => set('due', x.target.value || null)}
              />
            </label>
          </div>
          {p.dueNote && pending && !('due' in e) && (
            <p className="text-[11px] text-warn">{p.dueNote}</p>
          )}
        </div>
      )}

      {p.kind === 'note' && (
        <div className="space-y-1.5">
          <input
            className={field}
            disabled={!pending}
            value={val('title', p.title)}
            onChange={(x) => set('title', x.target.value)}
            aria-label="Note title"
          />
          <p className="text-[11px] text-muted">
            {p.date}
            {p.account ? ` · ${p.account}` : ''}
          </p>
          {p.body && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted">Preview contents</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-field p-2 whitespace-pre-wrap">
                {p.body}
              </pre>
            </details>
          )}
        </div>
      )}

      {p.kind === 'reminder' && (
        <div className="space-y-1.5">
          <input
            className={field}
            disabled={!pending}
            value={val('text', p.text)}
            onChange={(x) => set('text', x.target.value)}
            aria-label="Reminder"
          />
          <label className="block text-[11px] text-muted">
            When
            <input
              type="datetime-local"
              className={field}
              disabled={!pending}
              value={val('at', p.at ?? '')}
              onChange={(x) => set('at', x.target.value)}
            />
          </label>
          {p.atNote && pending && !e.at && <p className="text-[11px] text-warn">{p.atNote}</p>}
        </div>
      )}

      {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
      <div className="mt-2 flex items-center gap-1.5">
        {pending && (
          <>
            <button className={btnPrimary} disabled={busy} onClick={() => onApply(e)}>
              {p.kind === 'reminder'
                ? 'Set reminder'
                : p.kind === 'note'
                  ? 'Create note'
                  : 'Add task'}
            </button>
            <button className={btn} disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
          </>
        )}
        {p.kind === 'note' && p.status === 'applied' && p.appliedPath && (
          <button className={btn} onClick={() => onOpenNote(p.appliedPath!)}>
            Open note
          </button>
        )}
      </div>
    </div>
  )
}

const HINTS = [
  'What did we decide about the cutover?',
  'Remind Sarah to send the deck by Friday',
  'Met with the Navy team. Cutover moves to Dec 4. Sarah owns the firewall rules.'
]

export default function AssistantDrawer({
  onClose,
  onOpenNote,
  onOpenSettings,
  onFlash,
  seed
}: {
  onClose: () => void
  onOpenNote: (path: string) => void
  onOpenSettings: () => void
  onFlash: (m: string) => void
  /** A message to send as soon as the drawer is ready (e.g. "tidy this note"). */
  seed?: { text: string; nonce: number } | null
}): React.JSX.Element {
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [busyCard, setBusyCard] = useState<string | null>(null)
  const [cardErr, setCardErr] = useState<Record<string, string>>({})
  const [aiReady, setAiReady] = useState<boolean | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  const loadStatus = useCallback(() => {
    void window.api.invoke('llm:status').then((r) => {
      if (r.ok) setAiReady(r.data.enabled && r.data.providers.some((p) => p.hasKey && p.enabled))
    })
  }, [])

  useEffect(() => {
    void window.api.invoke('assistant:history').then((r) => r.ok && setMsgs(r.data))
    loadStatus()
    input.current?.focus()
  }, [loadStatus])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [msgs, sending])

  const replace = (m: ChatMessage): void => setMsgs((xs) => xs.map((x) => (x.id === m.id ? m : x)))

  const send = async (raw?: string): Promise<void> => {
    const t = (raw ?? text).trim()
    if (!t || sending) return
    setSending(true)
    setText('')
    const r = await window.api.invoke('assistant:send', { text: t })
    setSending(false)
    if (!r.ok) return onFlash(r.error.message)
    setMsgs((xs) => [...xs, ...r.data])
    loadStatus()
    input.current?.focus()
  }

  const seeded = useRef<number | null>(null)
  useEffect(() => {
    if (!seed || seeded.current === seed.nonce) return
    seeded.current = seed.nonce
    void send('/note ' + seed.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  const apply = async (m: ChatMessage, i: number, edits: Edits): Promise<void> => {
    const key = `${m.id}:${i}`
    setBusyCard(key)
    setCardErr((x) => ({ ...x, [key]: '' }))
    const r = await window.api.invoke('assistant:apply', { messageId: m.id, index: i, edits })
    setBusyCard(null)
    if (!r.ok) return setCardErr((x) => ({ ...x, [key]: r.error.message }))
    replace(r.data)
  }

  const dismiss = async (m: ChatMessage, i: number): Promise<void> => {
    const r = await window.api.invoke('assistant:dismiss', { messageId: m.id, index: i })
    if (r.ok) replace(r.data)
  }

  const clear = async (): Promise<void> => {
    await window.api.invoke('assistant:clear')
    setMsgs([])
  }

  return (
    <aside
      className="glass flex h-full w-[22rem] shrink-0 flex-col overflow-hidden rounded-2xl"
      aria-label="Co-Pilot"
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <SparkleIcon className="text-[var(--accent)]" />
        <h2 className="flex-1 text-sm font-semibold">Co-Pilot</h2>
        {msgs.length > 0 && (
          <button className="text-xs text-muted hover:text-fg" onClick={() => void clear()}>
            Clear
          </button>
        )}
        <button
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
          onClick={onClose}
          aria-label="Close Co-Pilot"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {msgs.length === 0 && (
          <div className="space-y-2 text-sm text-muted">
            <p>
              Ask about your notes, or dump what just happened. I turn it into tasks, notes and
              reminders for you to review.
            </p>
            {HINTS.map((h) => (
              <button
                key={h}
                className="block w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-xs hover:bg-hover"
                onClick={() => setText(h)}
              >
                {h}
              </button>
            ))}
          </div>
        )}
        {aiReady === false && (
          <p className="rounded-lg border border-line bg-surface p-2 text-xs text-muted">
            AI is off until you add your own API key (a free Gemini key works).{' '}
            <button className="underline" onClick={onOpenSettings}>
              Open Settings
            </button>
            . Search and quick parsing still work.
          </p>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div
              className={
                m.role === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-accent-soft px-3 py-2 text-sm whitespace-pre-wrap'
                  : 'w-full space-y-2'
              }
            >
              {m.role === 'user' ? (
                m.content
              ) : (
                <>
                  <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                  {m.proposals.map((p, i) => (
                    <Card
                      key={i}
                      p={p}
                      busy={busyCard === `${m.id}:${i}`}
                      error={cardErr[`${m.id}:${i}`] || null}
                      onApply={(ed) => void apply(m, i, ed)}
                      onDismiss={() => void dismiss(m, i)}
                      onOpenNote={onOpenNote}
                    />
                  ))}
                  {m.citations.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {m.citations.map((c) => (
                        <button
                          key={c.n + c.path}
                          className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] hover:bg-hover"
                          onClick={() => onOpenNote(c.path)}
                          title={`${c.title} (${c.date})`}
                        >
                          [{c.n}] {c.title}
                        </button>
                      ))}
                    </div>
                  )}
                  {m.notice && <p className="text-[11px] text-muted">{m.notice}</p>}
                </>
              )}
            </div>
          </div>
        ))}
        {sending && <p className="text-xs text-muted">Thinking…</p>}
        <div ref={end} />
      </div>

      <form
        className="border-t border-line p-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
            if (e.key === 'Escape') onClose()
          }}
          rows={3}
          placeholder="Ask a question or paste what happened…"
          className={`${field} resize-none`}
          aria-label="Message"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[11px] text-muted">Enter to send · Shift+Enter for a new line</span>
          <button type="submit" className={btnPrimary} disabled={sending || !text.trim()}>
            Send
          </button>
        </div>
      </form>
    </aside>
  )
}
