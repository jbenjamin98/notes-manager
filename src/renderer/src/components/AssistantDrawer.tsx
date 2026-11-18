import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, Input, Proposal } from '@shared/contract'
import Typewriter from './Typewriter'
import Thinking from './Thinking'
import AiModeSwitch from './AiModeSwitch'
import PersonaAvatar from './PersonaAvatar'
import { usePersona } from '../aiMode'
import { PERSONAS } from '@shared/personas'
import { aiHealth } from '@shared/aiHealth'
import { useLlmStatus, useNow } from '../hooks'
import { initialMood, stepMood, type Mood, type MoodEvent } from '@shared/avatarMood'

export type ActionReq = Input<'assistant:action'>

const field =
  'w-full rounded-md border border-line bg-field px-2 py-1 text-sm outline-none focus:border-[var(--accent)]'
const btn =
  'rounded-md border border-line bg-field px-2.5 py-1 text-xs font-medium hover:bg-hover disabled:opacity-50'
const btnPrimary =
  'rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50'

type Edits = Record<string, unknown>

/** A word under the name that matches the face. */
const MOOD_LINE: Record<Mood, string> = {
  idle: 'Here when you need me',
  listening: 'Listening…',
  thinking: 'Thinking it through…',
  talking: 'Here is what I found',
  happy: 'Done!',
  concerned: 'Hmm, that did not work',
  surprised: 'Something new for you',
  sleepy: 'Dozing. Type to wake me',
  waking: 'Oh! Hello again'
}

/** On short windows the face shrinks so the conversation keeps its room. */
function useShortWindow(): boolean {
  const q = '(max-height: 760px)'
  const [short, setShort] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const on = (): void => setShort(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return short
}

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
        : p.kind === 'email'
          ? 'Email draft'
          : 'Reminder'

  return (
    <div
      className={`rounded-xl border border-line bg-surface p-2.5 text-sm ${p.status === 'dismissed' ? 'opacity-50' : ''}`}
      data-testid="proposal"
    >
      <div className="mb-1.5 flex items-center justify-between text-xs font-semibold tracking-wide text-muted uppercase">
        <span>{label}</span>
        {p.status === 'applied' && (
          <span className="text-ok">{p.kind === 'email' ? 'Opened' : 'Added'}</span>
        )}
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
            <label className="text-xs text-muted">
              Owner
              <input
                className={field}
                disabled={!pending}
                value={val('owner', p.owner)}
                onChange={(x) => set('owner', x.target.value)}
              />
            </label>
            <label className="text-xs text-muted">
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
            <p className="text-xs text-warn">{p.dueNote}</p>
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
          <p className="text-xs text-muted">
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

      {p.kind === 'email' && (
        <div className="space-y-1.5">
          <label className="block text-xs text-muted">
            To
            <input
              className={field}
              disabled={!pending}
              value={val('to', p.to ?? '')}
              placeholder="Add a recipient in Gmail"
              onChange={(x) => set('to', x.target.value)}
            />
          </label>
          <label className="block text-xs text-muted">
            Subject
            <input
              className={field}
              disabled={!pending}
              value={val('subject', p.subject)}
              onChange={(x) => set('subject', x.target.value)}
            />
          </label>
          <textarea
            className={`${field} h-40 resize-y`}
            disabled={!pending}
            value={val('body', p.body)}
            aria-label="Email body"
            onChange={(x) => set('body', x.target.value)}
          />
          {pending && (
            <p className="text-xs text-muted">
              Opens a draft in Gmail for you to read and send yourself. Nothing is sent from here.
            </p>
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
          <label className="block text-xs text-muted">
            When
            <input
              type="datetime-local"
              className={field}
              disabled={!pending}
              value={val('at', p.at ?? '')}
              onChange={(x) => set('at', x.target.value)}
            />
          </label>
          {p.atNote && pending && !e.at && <p className="text-xs text-warn">{p.atNote}</p>}
        </div>
      )}

      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      <div className="mt-2 flex items-center gap-1.5">
        {pending && (
          <>
            <button className={btnPrimary} disabled={busy} onClick={() => onApply(e)}>
              {p.kind === 'reminder'
                ? 'Set Reminder'
                : p.kind === 'note'
                  ? 'Create Note'
                  : p.kind === 'email'
                    ? 'Open in Gmail'
                    : p.kind === 'task' && p.owner && p.owner !== 'Me'
                      ? 'Save to Waiting On'
                      : 'Add Task'}
            </button>
            <button className={btn} disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
          </>
        )}
        {p.kind === 'note' && p.status === 'applied' && p.appliedPath && (
          <button className={btn} onClick={() => onOpenNote(p.appliedPath!)}>
            Open Note
          </button>
        )}
      </div>
    </div>
  )
}

const PENDING: ChatMessage = {
  id: '',
  role: 'user',
  content: '',
  createdAt: '',
  proposals: [],
  citations: [],
  notice: null,
  via: null,
  followups: [],
  kind: 'chat',
  unread: false
}

interface Chip {
  label: string
  title: string
  req: ActionReq
}

/** Quick actions: the ones for the open note first, then the ones that always make sense. */
function chips(ctx: { path: string; title: string } | null | undefined): Chip[] {
  const out: Chip[] = []
  if (ctx) {
    out.push(
      {
        label: 'Summarize this note',
        title: `Summarize “${ctx.title}”`,
        req: { kind: 'summarize-note', path: ctx.path }
      },
      {
        label: 'Find action items',
        title: `Find action items in “${ctx.title}”`,
        req: { kind: 'extract-actions', path: ctx.path }
      },
      {
        label: 'Draft follow-up',
        title: `Draft a follow-up email for “${ctx.title}”`,
        req: { kind: 'draft-followup', path: ctx.path }
      }
    )
  }
  out.push(
    { label: 'Plan my day', title: 'What is on my plate today?', req: { kind: 'day-brief' } },
    { label: 'Chat digest', title: 'What needs me in Chat?', req: { kind: 'chat-digest' } },
    {
      label: 'Draft my weekly update',
      title: 'Draft my weekly update',
      req: { kind: 'week-update' }
    }
  )
  return out
}

const KIND_LABEL: Record<ChatMessage['kind'], string> = {
  chat: '',
  brief: 'Morning brief',
  pre_meeting: 'Meeting heads-up',
  overdue: 'Overdue',
  nudge: 'Heads-up'
}

// Shown until the real ones (from your own notes) arrive.
const PLAIN_HINTS = [
  "What's on my plate this week?",
  'Summarize my most recent meeting',
  'What did I decide recently?'
]

export default function AssistantDrawer({
  onClose,
  onOpenNote,
  onOpenSettings,
  onFlash,
  seed,
  action,
  context
}: {
  onClose: () => void
  onOpenNote: (path: string) => void
  onOpenSettings: () => void
  onFlash: (m: string) => void
  /** A message to send as soon as the drawer is ready (e.g. "tidy this note"). */
  seed?: { text: string; nonce: number } | null
  /** A one-click action to run as soon as the drawer is ready (from a button elsewhere). */
  action?: { req: ActionReq; label: string; nonce: number } | null
  /** What the user is looking at, so the chips can act on it. */
  context?: { path: string; title: string } | null
}): React.JSX.Element {
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [hints, setHints] = useState<string[]>(PLAIN_HINTS)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [busyCard, setBusyCard] = useState<string | null>(null)
  const [cardErr, setCardErr] = useState<Record<string, string>>({})
  const [aiReady, setAiReady] = useState<boolean | null>(null)
  const [persona] = usePersona()
  const [thinking, setThinking] = useState<string | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  // Quick (free) answers remember their request so "Polish With AI" can redo them with a model.
  const [polish, setPolish] = useState<Record<string, { req: ActionReq; label: string }>>({})
  const [tokens, setTokens] = useState(0)
  const health = aiHealth(useLlmStatus(), useNow(15_000))
  const end = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // The view never chases new text. It moves once, by itself, in two cases only: to the bottom when
  // you send (so you see your message), and to the START of a new answer (so you read it from the top).
  const toBottom = useCallback(() => {
    requestAnimationFrame(() => end.current?.scrollIntoView({ block: 'end' }))
  }, [])
  const toMessage = useCallback((id: string) => {
    requestAnimationFrame(() =>
      scroller.current
        ?.querySelector<HTMLElement>(`[data-mid="${id}"]`)
        ?.scrollIntoView({ block: 'start' })
    )
  }, [])
  const input = useRef<HTMLTextAreaElement>(null)

  const compactHead = useShortWindow()
  // The assistant's face follows the conversation (see avatarMood.ts).
  const [moodS, setMoodS] = useState(() => initialMood(Date.now()))
  const lastTalk = useRef(0)
  const feel = useCallback((type: MoodEvent['type']) => {
    if (type === 'talk') {
      const now = Date.now()
      if (now - lastTalk.current < 150) return // the typewriter runs every frame; a few beats is enough
      lastTalk.current = now
    }
    setMoodS((s) => stepMood(s, { type } as MoodEvent, Date.now()))
  }, [])
  useEffect(() => {
    const t = setInterval(() => setMoodS((s) => stepMood(s, { type: 'tick' }, Date.now())), 400)
    return () => clearInterval(t)
  }, [])
  // What the assistant is doing while it works ("Checking your calendar…").
  useEffect(
    () =>
      window.api.on('assistant:progress', ({ label }) => setThinking((cur) => (cur ? label : cur))),
    []
  )
  const onTalk = useCallback(() => feel('talk'), [feel])

  // Where your text goes when the AI is used (null = nowhere: everything stays on this computer).
  const [sentTo, setSentTo] = useState<string | null>(null)
  const loadStatus = useCallback(() => {
    void window.api.invoke('llm:status').then((r) => {
      if (!r.ok) return
      setAiReady(r.data.enabled && r.data.providers.some((p) => p.hasKey && p.enabled))
      const first = r.data.providers.find((p) => p.hasKey && p.enabled)
      setSentTo(r.data.enabled && first ? first.label : null)
      setTokens(r.data.providers.reduce((n, p) => n + p.usage.tokensToday, 0))
    })
  }, [])

  useEffect(() => {
    void window.api.invoke('assistant:history').then((r) => {
      if (!r.ok) return
      setMsgs(r.data)
      void window.api.invoke('assistant:mark-read')
    })
    const off = window.api.on('assistant:changed', () => {
      void window.api.invoke('assistant:history').then((r) => {
        if (!r.ok) return
        setMsgs(r.data)
        if (r.data.some((m) => m.unread)) feel('proactive')
        setFresh((f) => new Set([...f, ...r.data.filter((m) => m.unread).map((m) => m.id)]))
        void window.api.invoke('assistant:mark-read')
      })
    })
    void window.api.invoke('assistant:hints').then((r) => r.ok && setHints(r.data))
    loadStatus()
    input.current?.focus()
    return off
  }, [loadStatus, feel])

  const replace = (m: ChatMessage): void => setMsgs((xs) => xs.map((x) => (x.id === m.id ? m : x)))

  const send = async (
    raw?: string,
    how: { mode?: 'capture'; quiet?: boolean; shown?: string } = {}
  ): Promise<void> => {
    const t = (raw ?? text).trim()
    if (!t || sending) return
    setSending(true)
    feel('send')
    toBottom()
    setThinking('Thinking')
    setText('')
    // Show what was asked straight away; the answer replaces the placeholder when it arrives.
    setMsgs((xs) => [...xs, { ...PENDING, id: 'pending-user', content: how.shown ?? t }])
    const r = await window.api.invoke('assistant:send', {
      text: t,
      mode: how.mode,
      quiet: how.quiet
    })
    setSending(false)
    setThinking(null)
    setMsgs((xs) => xs.filter((x) => x.id !== 'pending-user'))
    if (!r.ok) {
      feel('error')
      return onFlash(r.error.message)
    }
    feel('done')
    setMsgs((xs) => [...xs, ...r.data])
    setFresh(
      (f) => new Set([...f, ...r.data.filter((m) => m.role === 'assistant').map((m) => m.id)])
    )
    const first = r.data.find((m) => m.role === 'assistant')
    if (first) toMessage(first.id)
    loadStatus()
    input.current?.focus()
  }

  const runAction = async (req: ActionReq, label: string): Promise<void> => {
    if (sending) return
    setSending(true)
    feel('send')
    toBottom()
    setThinking(label)
    setMsgs((xs) => [...xs, { ...PENDING, id: 'pending-user', content: label }])
    // The model answers whenever AI works; the on-computer rules are the fallback.
    const quick = req.quick ?? (aiReady === false && !req.ephemeral)
    const r = await window.api.invoke('assistant:action', { ...req, quick })
    if (r.ok && quick) {
      const add: Record<string, { req: ActionReq; label: string }> = {}
      for (const m of r.data)
        if (m.role === 'assistant' && m.notice?.startsWith('Quick answer'))
          add[m.id] = { req, label }
      setPolish((p) => ({ ...p, ...add }))
    }
    setSending(false)
    setThinking(null)
    setMsgs((xs) => xs.filter((x) => x.id !== 'pending-user'))
    if (!r.ok) {
      feel('error')
      return onFlash(r.error.message)
    }
    feel('done')
    setMsgs((xs) => [...xs, ...r.data])
    setFresh(
      (f) => new Set([...f, ...r.data.filter((m) => m.role === 'assistant').map((m) => m.id)])
    )
    const first = r.data.find((m) => m.role === 'assistant')
    if (first) toMessage(first.id)
    loadStatus()
  }

  const acted = useRef<number | null>(null)
  useEffect(() => {
    if (!action || acted.current === action.nonce) return
    acted.current = action.nonce
    void runAction(action.req, action.label)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  /** A suggestion button: plain text is a question; `Label::kind:arg` runs an action. */
  const chip = (raw: string): void => {
    const [label, act] = raw.split('::')
    if (!act) return void send(label)
    const [kind, arg] = act.split(':')
    if (kind === 'capture') {
      // "Turn these into tasks": run capture on what you last wrote, without repeating it in the chat.
      const said = [...msgs].reverse().find((m) => m.role === 'user')?.content
      if (said) void send(said, { mode: 'capture', quiet: true, shown: label })
    } else if (kind === 'prep-brief') void runAction({ kind, eventId: arg }, label)
    else if (kind === 'day-brief') void runAction({ kind }, 'What is on my plate today?')
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
    if (!r.ok) {
      feel('error')
      return setCardErr((x) => ({ ...x, [key]: r.error.message }))
    }
    feel('success')
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
      className="glass drawer-in flex h-full w-[22rem] shrink-0 flex-col overflow-hidden rounded-2xl max-[1180px]:fixed max-[1180px]:top-3 max-[1180px]:right-3 max-[1180px]:bottom-3 max-[1180px]:z-40 max-[1180px]:h-auto max-[1180px]:shadow-2xl"
      aria-label="Co-Pilot"
    >
      <header className="relative flex flex-col items-center border-b border-line px-3 pt-3 pb-2.5">
        <div className="absolute top-2 right-2 flex items-center gap-1">
          {msgs.length > 0 && (
            <button
              className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
              onClick={() => void clear()}
            >
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
        </div>
        <div className="av-stage relative" data-testid="assistant-avatar">
          <span aria-hidden className="av-halo absolute inset-0 rounded-full" />
          <PersonaAvatar id={persona} size={compactHead ? 64 : 104} live mood={moodS.mood} />
        </div>
        <h2 className="mt-1.5 text-center leading-tight">
          <span className="block text-base font-semibold tracking-tight">
            {PERSONAS[persona].name}
          </span>
          <span className="block text-xs text-muted" aria-live="polite">
            {MOOD_LINE[moodS.mood]}
          </span>
        </h2>
      </header>

      {!health.hidden && health.tone !== 'ok' ? (
        <p
          role="status"
          data-testid="ai-banner"
          className={`border-b border-line px-3 py-1.5 text-xs ${health.tone === 'bad' ? 'bg-danger/10 text-danger' : 'bg-warn/10 text-warn'}`}
        >
          {health.detail}
        </p>
      ) : (
        tokens > 0 && (
          <p className="border-b border-line px-3 py-1 text-xs text-muted">
            About {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens used today
          </p>
        )
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          data-testid="assistant-scroll"
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
        >
          {msgs.length === 0 && (
            <div className="space-y-2 text-sm text-muted">
              <p>
                Ask about your work, think out loud, or paste what happened. I look things up across
                your notes, calendar, mail and chat, and offer to turn to-dos into tasks for you to
                review.
              </p>
              {hints.map((h) => (
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
            <div
              key={m.id}
              data-mid={m.id}
              className={`msg-in ${m.role === 'user' ? 'flex justify-end' : ''}`}
            >
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
                    {m.kind !== 'chat' && (
                      <div className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
                        {m.unread && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                        {KIND_LABEL[m.kind]}
                      </div>
                    )}
                    <Typewriter text={m.content} animate={fresh.has(m.id)} onProgress={onTalk} />
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
                            className="rounded-full border border-line bg-surface px-2 py-0.5 text-xs hover:bg-hover"
                            onClick={() => onOpenNote(c.path)}
                            title={`${c.title} (${c.date})`}
                          >
                            [{c.n}] {c.title}
                          </button>
                        ))}
                      </div>
                    )}
                    {m.notice && <p className="text-xs text-muted">{m.notice}</p>}
                    {polish[m.id] && (
                      <button
                        className="self-start rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs hover:bg-hover disabled:opacity-60"
                        disabled={sending}
                        onClick={() => {
                          const p = polish[m.id]
                          setPolish((cur) =>
                            Object.fromEntries(Object.entries(cur).filter(([k]) => k !== m.id))
                          )
                          void runAction({ ...p.req, quick: false }, p.label)
                        }}
                      >
                        Polish With AI
                      </button>
                    )}
                    {m.followups.length > 0 && (
                      <div className="flex flex-col gap-1">
                        {m.followups.map((f) => (
                          <button
                            key={f}
                            className="rounded-full border border-line bg-surface px-2.5 py-1 text-left text-xs hover:bg-hover"
                            onClick={() => chip(f)}
                          >
                            {f.split('::')[0]}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
          {thinking && <Thinking label={thinking.length > 70 ? 'Working on it' : thinking} />}
          <div ref={end} />
        </div>
      </div>

      <div
        className="flex gap-1.5 overflow-x-auto border-t border-line px-2.5 pt-2 pb-0.5"
        aria-label="Quick actions"
      >
        {chips(context).map((c) => (
          <button
            key={c.label}
            disabled={sending}
            onClick={() => void runAction(c.req, c.title)}
            className="shrink-0 rounded-full border border-line bg-surface px-2.5 py-1 text-xs hover:bg-hover disabled:opacity-50"
          >
            {c.label}
          </button>
        ))}
      </div>

      <form
        className="p-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            feel('typing')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
            if (e.key === 'Escape') onClose()
          }}
          rows={3}
          placeholder="Ask me anything, think out loud, or paste what happened…"
          className={`${field} resize-none`}
          aria-label="Message"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <AiModeSwitch variant="compact" />
          <button type="submit" className={btnPrimary} disabled={sending || !text.trim()}>
            Send
          </button>
        </div>
        <div className="mt-1 flex items-center">
          <span className="min-w-0 text-xs leading-snug text-muted">
            Enter to send · Shift+Enter for a new line
            <span
              className="block truncate"
              data-testid="ai-destination"
              title={
                sentTo
                  ? `When AI is used, your question and the matching note text are sent to ${sentTo}. Quick answers stay on this computer.`
                  : 'No AI is set up: everything stays on this computer.'
              }
            >
              {sentTo
                ? `AI answers are sent to ${sentTo}`
                : 'Local only: nothing leaves this computer'}
            </span>
          </span>
        </div>
      </form>
    </aside>
  )
}
