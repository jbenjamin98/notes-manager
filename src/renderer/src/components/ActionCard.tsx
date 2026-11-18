import { useState } from 'react'
import type { ActionItem } from '@shared/actionFeed'
import { ageLabel } from '../format'
import CategoryIcon from './CategoryIcon'

const stripRe = (s: string): string => s.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim()

const btn =
  'rounded-md border border-line bg-field px-2 py-0.5 text-xs font-medium hover:bg-hover disabled:opacity-50'
const ghost =
  'rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-50'

const LEVEL: Record<ActionItem['level'], { label: string; tone: string }> = {
  important: { label: 'Important', tone: 'bg-danger/10 text-danger' },
  maybe: { label: 'Maybe', tone: 'bg-warn/15 text-warn' },
  noise: { label: 'Hidden', tone: 'bg-hover text-muted' }
}

const INSIGHT_TASK = new Set(['action', 'ask', 'promise'])

/**
 * One thing that wants a decision, whether it is an email, a chat or something pulled out of a
 * meeting: the same card, the same few actions. Teaching it what matters is one click.
 */
export default function ActionCard({
  item,
  now,
  onChanged,
  onFlash
}: {
  item: ActionItem
  now: number
  onChanged: () => void
  onFlash: (m: string, undo?: () => void) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [blocking, setBlocking] = useState(false)

  const run = async (
    p: Promise<{ ok: boolean; error?: { message: string } }>,
    ok?: string,
    undo?: () => void
  ): Promise<boolean> => {
    setBusy(true)
    const r = await p
    setBusy(false)
    if (!r.ok) {
      onFlash(r.error?.message ?? 'Something went wrong.')
      return false
    }
    if (ok) onFlash(ok, undo)
    onChanged()
    return true
  }

  const teach = (important: boolean): void => {
    const verdict = important ? 'important' : 'not-important'
    if (item.kind === 'email') {
      void window.api.invoke('gmail:importance', { id: item.id, verdict }).then((r) => {
        if (!r.ok) return onFlash(r.error.message)
        const who = r.data.sender ?? 'this sender'
        onFlash(
          important
            ? `Marked ${who} important. Their mail will rank higher.`
            : r.data.quieted
              ? `Quieted ${who}. Their mail now goes to Hidden.`
              : `Noted: ${who} is not important. Mark it again to hide them.`,
          () =>
            void window.api
              .invoke('gmail:importance-undo', { id: item.id, verdict })
              .then(() => onChanged())
        )
        onChanged()
      })
    } else if (item.kind === 'chat') {
      void run(
        window.api.invoke('chat:feedback', {
          key: item.id,
          reasons: item.conversation.reasons,
          relevant: important
        }),
        important ? 'Noted: conversations like this matter.' : 'Noted: less of this.'
      )
    } else {
      // An insight you do not want is dismissed.
      void run(window.api.invoke('inbox:dismiss', { id: item.id }), 'Dismissed.')
    }
  }

  const block = (target: string): void => {
    void window.api.invoke('gmail:mute', { target }).then((r) => {
      if (!r.ok) return onFlash(r.error.message)
      setBlocking(false)
      onFlash(
        `Blocked ${target}. It will not show up again. Undo, or manage blocked senders in Settings.`,
        () => void window.api.invoke('gmail:unmute', { pattern: r.data }).then(() => onChanged())
      )
      onChanged()
    })
  }

  const dismiss = (): void => {
    if (item.kind === 'email') void run(window.api.invoke('gmail:dismiss', { id: item.id }))
    else if (item.kind === 'chat')
      void run(
        window.api.invoke('chat:feedback', {
          key: item.id,
          reasons: item.conversation.reasons,
          relevant: false
        })
      )
    else void run(window.api.invoke('inbox:dismiss', { id: item.id }))
  }

  const t = item.kind === 'email' ? item.thread : null
  const first = (item.from ?? '').split(/\s+/)[0]
  const level = LEVEL[item.level]

  let primary: React.ReactNode = null
  if (item.kind === 'email' && t) {
    primary = (
      <>
        {item.bucket === 'waiting' ? (
          <button
            className={btn}
            disabled={busy}
            title="Open a pre-filled follow-up draft in Gmail"
            onClick={() =>
              void run(
                window.api.invoke('gmail:compose', {
                  to: t.senderEmail ?? undefined,
                  subject: `Re: ${stripRe(t.subject)}`.slice(0, 200),
                  body: `Hi ${first || 'there'},\n\nFollowing up on "${stripRe(t.subject)}". Do you have an update?\n\nThanks,`
                }),
                'Gmail draft opened. Review it, then send or close to keep the draft.'
              )
            }
          >
            Nudge
          </button>
        ) : (
          <button
            className={btn}
            disabled={busy}
            onClick={() => void run(window.api.invoke('gmail:open-thread', { id: item.id }))}
          >
            Reply
          </button>
        )}
        {t.taskAdded ? (
          <span className="px-1 text-xs text-ok">Task added ✓</span>
        ) : (
          <button
            className={btn}
            disabled={busy}
            title={`Add a task: ${t.taskText}`}
            onClick={() =>
              void run(
                window.api.invoke('gmail:add-task', { id: item.id, text: t.taskText }),
                'Added to your inbox tasks.'
              )
            }
          >
            Add task
          </button>
        )}
      </>
    )
  } else if (item.kind === 'chat') {
    primary = (
      <button
        className={btn}
        disabled={busy}
        onClick={() =>
          void run(
            window.api.invoke('tasks:quick-add', {
              text: `Reply to ${item.conversation.lastSender || item.title} in chat`.slice(0, 200)
            }),
            'Added to your inbox tasks.'
          )
        }
      >
        Add task
      </button>
    )
  } else if (item.kind === 'insight') {
    const i = item.insight
    const label = INSIGHT_TASK.has(i.kind)
      ? i.mine
        ? 'Add as Task'
        : 'Save to Waiting On'
      : 'Save to Notes'
    primary = (
      <button
        className={`${btn} bg-accent-soft text-accent`}
        disabled={busy}
        onClick={() =>
          void run(window.api.invoke('inbox:accept', { id: item.id }), `${label}: done.`)
        }
      >
        {label}
      </button>
    )
  }

  return (
    <li
      className="card-modern group p-3"
      data-testid="action-card"
      data-kind={item.kind}
      data-level={item.level}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">
          <CategoryIcon
            kind={item.kind === 'email' ? 'inbox' : item.kind === 'chat' ? 'person' : 'review'}
            size={22}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className={`min-w-0 flex-1 truncate text-sm ${item.unread ? 'font-semibold' : ''}`}>
              {item.title}
            </p>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${level.tone}`}>
              {level.label}
            </span>
          </div>
          <p className="truncate text-xs text-muted">
            {item.from ?? 'Unknown'}
            {item.when ? ` · ${ageLabel(item.when, now)}` : ''}
          </p>
          {item.snippet && item.kind !== 'insight' && (
            <p className="mt-1 line-clamp-2 text-xs text-muted">{item.snippet}</p>
          )}
          {item.reasons.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {item.reasons.slice(0, 3).map((r) => (
                <span
                  key={r}
                  className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] text-muted"
                >
                  {r}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {primary}
        <span className="flex-1" />
        {item.kind !== 'insight' && (
          <button
            className={ghost}
            disabled={busy}
            data-testid="mark-important"
            title="Teach it: this matters"
            onClick={() => teach(true)}
          >
            ▲ Important
          </button>
        )}
        {item.kind === 'email' && item.thread.senderEmail && (
          <button
            className={ghost}
            disabled={busy}
            data-testid="block-sender"
            title="Never show mail from this sender"
            onClick={() => setBlocking((b) => !b)}
          >
            Block…
          </button>
        )}
        <button
          className={ghost}
          disabled={busy}
          data-testid="mark-not-important"
          title="Teach it: this does not matter"
          onClick={() => teach(false)}
        >
          {item.kind === 'insight' ? '▼ Not pertinent' : '▼ Not important'}
        </button>
        <button
          className={ghost}
          disabled={busy}
          aria-label="Dismiss"
          title="Dismiss"
          onClick={dismiss}
        >
          ✕
        </button>
      </div>
      {blocking && item.kind === 'email' && item.thread.senderEmail && (
        <div
          className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-field/60 p-2 text-xs"
          data-testid="block-options"
        >
          <span className="text-muted">Block</span>
          <button className={btn} onClick={() => block(item.thread.senderEmail!)}>
            {item.thread.senderEmail}
          </button>
          <button
            className={btn}
            onClick={() => block(`@${item.thread.senderEmail!.split('@')[1]}`)}
          >
            everything from @{item.thread.senderEmail.split('@')[1]}
          </button>
          <button className={ghost} onClick={() => setBlocking(false)}>
            Cancel
          </button>
        </div>
      )}
    </li>
  )
}
