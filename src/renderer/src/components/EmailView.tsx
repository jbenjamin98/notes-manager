import type { GmailOverview, GmailStatus, ThreadItem } from '@shared/contract'
import { ageLabel, relativeTime } from '../format'
import { useNow } from '../hooks'

const btn =
  'rounded-md border border-line bg-field px-2 py-0.5 text-xs font-medium hover:bg-hover disabled:opacity-60'

const stripPrefix = (s: string): string => s.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim()

const DROP_LABEL: Record<string, string> = {
  automated: 'from automated senders (no-reply, notifications, newsletters)',
  archived: 'archived with no label, star or reply from you',
  calendar: 'calendar invitations and responses',
  muted: 'from senders you muted',
  'ignored-label': 'with a label set to Ignore'
}

function Section({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-1 px-2 text-sm font-semibold">
        {title}
        {count !== undefined && <span className="font-normal text-muted"> · {count}</span>}
      </h2>
      {children}
    </section>
  )
}

function Thread({
  t,
  kind,
  onFlash
}: {
  t: ThreadItem
  kind: 'reply' | 'star' | 'label' | 'inbound'
  onFlash: (m: string) => void
}): React.JSX.Element {
  const now = useNow()
  const run = async (
    p: Promise<{ ok: boolean; error?: { message: string } }>,
    ok?: string
  ): Promise<void> => {
    const r = await p
    if (!r.ok) onFlash(r.error?.message ?? 'Something went wrong.')
    else if (ok) onFlash(ok)
  }
  const first = (t.senderName ?? '').split(/\s+/)[0]

  return (
    <li className="group flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-hover">
      <span
        className={`mt-2 h-2 w-2 shrink-0 rounded-full ${t.unread ? 'bg-accent' : 'bg-transparent'}`}
        title={t.unread ? 'Unread' : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-sm ${t.unread ? 'font-semibold' : ''}`}>{t.subject}</div>
        <div className="truncate text-xs text-muted">
          {kind === 'reply' && (t.senderName || t.senderEmail) ? 'To ' : ''}
          {t.senderName ??
            t.senderEmail ??
            (kind === 'reply' ? 'Open to see recipients' : 'Unknown')}{' '}
          · {ageLabel(t.lastMessageAt, now)}
          {kind !== 'label' && t.labels.length > 0 && ` · ${t.labels.join(', ')}`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 opacity-80 group-hover:opacity-100">
        {kind === 'reply' && (t.senderEmail || t.senderName) && (
          <button
            className={btn}
            title="Open a pre-filled draft in Gmail"
            onClick={() =>
              void run(
                window.api.invoke('gmail:compose', {
                  to: t.senderEmail ?? undefined,
                  subject: `Re: ${stripPrefix(t.subject)}`.slice(0, 200),
                  body: `Hi ${first || 'there'},\n\nFollowing up on "${stripPrefix(t.subject)}". Do you have an update?\n\nThanks,`
                }),
                'Gmail draft opened. Review it, then send or close to keep the draft.'
              )
            }
          >
            Draft follow-up
          </button>
        )}
        {t.taskAdded ? (
          <span className="px-1 text-xs text-ok">Task added ✓</span>
        ) : (
          <button
            className={btn}
            title={`Add a task: ${t.taskText}`}
            onClick={() =>
              void run(
                window.api.invoke('gmail:add-task', { id: t.id, text: t.taskText }),
                'Added to your inbox tasks.'
              )
            }
          >
            Add task
          </button>
        )}
        <button
          className={btn}
          onClick={() => void run(window.api.invoke('gmail:open-thread', { id: t.id }))}
          title="Open in Gmail"
        >
          Open
        </button>
        {t.senderEmail && (
          <button
            className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
            title={`Never show mail from ${t.senderEmail}`}
            onClick={() =>
              void run(
                window.api.invoke('gmail:mute', { target: t.senderEmail! }),
                `Muted ${t.senderEmail}. You can undo this in Settings.`
              )
            }
          >
            Mute
          </button>
        )}
        <button
          className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
          onClick={() => void run(window.api.invoke('gmail:dismiss', { id: t.id }))}
          aria-label={`Dismiss "${t.subject}"`}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    </li>
  )
}

export default function EmailView({
  mail,
  gmail,
  onConnect,
  onSync,
  onSettings,
  onFlash
}: {
  mail: GmailOverview | null
  gmail: GmailStatus
  onConnect: () => void
  onSync: () => void
  onSettings: () => void
  onFlash: (m: string) => void
}): React.JSX.Element {
  const never = gmail.lastSyncAt === null
  const empty =
    mail &&
    mail.needsReply.length + mail.starred.length + mail.groups.length + mail.info.length === 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <header className="mb-4 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Email Follow-Ups</h1>
            <p className="mt-1 text-xs text-muted">
              {never
                ? 'Not synced yet.'
                : `Synced ${relativeTime(gmail.lastSyncAt)} · only subjects, senders and labels are read, and they stay on this computer.`}
            </p>
          </div>
          <button className={btn} onClick={onSync} disabled={gmail.state === 'syncing'}>
            {gmail.state === 'syncing' ? 'Syncing…' : 'Refresh'}
          </button>
        </header>

        {gmail.state === 'needs-auth' && (
          <div className="mb-4 rounded-xl border border-line bg-field p-4 text-sm">
            <p className="font-medium">Connect Google</p>
            <p className="mt-1 text-muted">Sign in once and your follow-ups show up here.</p>
            <button
              onClick={onConnect}
              className="btn-primary mt-3 rounded-lg px-3 py-1.5 font-medium"
            >
              Sign in
            </button>
          </div>
        )}
        {gmail.health === 'degraded' && gmail.state !== 'needs-auth' && (
          <div className="mb-4 rounded-lg bg-warn/15 px-3 py-2 text-sm text-warn">
            Mail may be out of date. {gmail.healthDetail}
          </div>
        )}
        {gmail.state === 'error' && (
          <div className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            Mail sync failed: {gmail.error}
          </div>
        )}

        {mail && mail.stats.stored > 0 && (
          <details className="mb-4 text-xs text-muted">
            <summary className="cursor-pointer select-none">
              {mail.stats.kept - (mail.stats.keptBy.counted ?? 0)} of {mail.stats.stored}{' '}
              conversations matter here. {mail.stats.keptBy.counted ?? 0} more are only counted
              under labels, and the rest were skipped.
            </summary>
            <ul className="mt-1 ml-4 list-disc">
              {Object.entries(DROP_LABEL).map(([k, label]) =>
                mail.stats.dropped[k] ? (
                  <li key={k}>
                    {mail.stats.dropped[k]} {label}
                  </li>
                ) : null
              )}
            </ul>
          </details>
        )}

        {mail && mail.info.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-2">
            {mail.info.map((i) => (
              <span key={i.label} className="rounded-full bg-hover px-2.5 py-1 text-xs">
                {i.label} <span className="text-muted">· {i.unread} unread</span>
              </span>
            ))}
            <button onClick={onSettings} className="text-xs text-muted underline hover:text-fg">
              Choose what happens with each label
            </button>
          </div>
        )}

        {mail && mail.awaitingMe.length > 0 && (
          <Section title="Waiting for your reply" count={mail.awaitingMeTotal}>
            <p className="mb-1 px-2 text-xs text-muted">
              People wrote to you and it is still in your inbox. Unread first.
              {mail.awaitingMeTotal > mail.awaitingMe.length &&
                ` Showing ${mail.awaitingMe.length} of ${mail.awaitingMeTotal}.`}
            </p>
            <ul>
              {mail.awaitingMe.map((t) => (
                <Thread key={t.id} t={t} kind="inbound" onFlash={onFlash} />
              ))}
            </ul>
          </Section>
        )}

        {mail && mail.needsReply.length > 0 && (
          <Section title="Waiting on them" count={mail.needsReply.length}>
            <p className="mb-1 px-2 text-xs text-muted">
              You wrote last and it has been over 2 days with no answer.
            </p>
            <ul>
              {mail.needsReply.map((t) => (
                <Thread key={t.id} t={t} kind="reply" onFlash={onFlash} />
              ))}
            </ul>
          </Section>
        )}

        {mail?.groups.map((g) => (
          <Section key={g.label} title={g.label} count={g.total}>
            <ul>
              {g.threads.map((t) => (
                <Thread key={t.id} t={t} kind="label" onFlash={onFlash} />
              ))}
            </ul>
          </Section>
        ))}

        {mail && mail.starred.length > 0 && (
          <Section title="Starred" count={mail.starred.length}>
            <ul>
              {mail.starred.map((t) => (
                <Thread key={t.id} t={t} kind="star" onFlash={onFlash} />
              ))}
            </ul>
          </Section>
        )}

        {(empty ||
          (!never && mail && !empty && mail.attention === 0 && mail.needsReply.length === 0)) && (
          <p className="py-10 text-center text-sm text-muted">
            {empty
              ? 'Nothing to follow up on right now.'
              : 'You are caught up: nothing needs a reply.'}
          </p>
        )}
        {never && gmail.state !== 'needs-auth' && gmail.state !== 'syncing' && (
          <p className="py-10 text-center text-sm text-muted">Press Refresh to read your mail.</p>
        )}
      </div>
    </div>
  )
}
