import { useEffect, useMemo, useState } from 'react'
import type { CalendarStatus, GoogleStatus, Settings } from '@shared/contract'
import { relativeTime, setAppTimezone } from '../format'
import { useGoogleConnection } from '../hooks'

/** Run the connection's suggested fix and say what happened (never a silent button). */
function useConnectionActions(): {
  run: (action: string | null) => Promise<void>
  busy: boolean
  note: { ok: boolean; text: string } | null
} {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (action: string | null): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      if (action === 'setup') {
        document
          .querySelector('[data-testid="bridge-setup"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setNote({ ok: true, text: 'Follow the steps in “Your Google account” above.' })
      } else if (action === 'copy-script') {
        const r = await window.api.invoke('google:bridge-script')
        if (!r.ok) throw new Error(r.error.message)
        await navigator.clipboard.writeText(r.data.script)
        setNote({
          ok: true,
          text: 'Script copied. In Apps Script, paste it over the old code, then Deploy > Manage deployments > Edit > New version, and press Verify.'
        })
      } else if (action === 'sign-in') {
        const r = await window.api.invoke('google:open-login')
        if (!r.ok) throw new Error(r.error.message)
        setNote({
          ok: true,
          text: 'A Google sign-in window is open. Sign in there and close it; we refresh straight after.'
        })
      } else {
        setNote({ ok: true, text: 'Refreshing calendar and mail…' })
        const r = await window.api.invoke('google:refresh')
        if (!r.ok) throw new Error(r.error.message)
        setNote({ ok: r.data.ok, text: r.data.message })
      }
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return { run, busy, note }
}

/** Everything support needs to know, with no keys or tokens. */
async function connectionDetails(): Promise<string> {
  const [c, h, b, i] = await Promise.all([
    window.api.invoke('google:connection'),
    window.api.invoke('google:health'),
    window.api.invoke('google:bridge-status'),
    window.api.invoke('app:info')
  ])
  const L = ['Note Manager connection details']
  if (i.ok) L.push(`Version: ${(i.data as { version?: string }).version ?? '?'}`)
  if (c.ok)
    L.push(
      `Source: ${c.data.source}`,
      `State: ${c.data.state} (${c.data.label})`,
      `Detail: ${c.data.detail}`,
      `Last sync: ${c.data.lastSyncAt ?? 'never'}`
    )
  if (b.ok)
    L.push(
      `Script address saved: ${b.data.url ? 'yes' : 'no'}`,
      `Script key on this computer: ${b.data.hasToken ? 'yes' : 'no'}`,
      `Script version expected: ${b.data.bundledVersion}`
    )
  if (h.ok) for (const r of h.data.rows) L.push(`${r.label}: ${r.state} - ${r.detail}`)
  return L.join('\n')
}

/** The connection, what is wrong, and one button that fixes it. */
export function ConnectionPanel(): React.JSX.Element | null {
  const conn = useGoogleConnection()
  const { run, busy, note } = useConnectionActions()
  const [copied, setCopied] = useState(false)
  if (!conn) return null
  const good = conn.state === 'ok' || conn.state === 'syncing'
  return (
    <div
      data-testid="google-connection"
      data-state={conn.state}
      className={`rounded-xl border p-3 ${good ? 'border-line bg-surface' : 'border-warn/40 bg-warn/10'}`}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${good ? 'bg-ok' : conn.state === 'not-set-up' ? 'bg-muted' : 'bg-warn'} ${conn.state === 'syncing' ? 'animate-pulse' : ''}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {conn.label}
            {conn.lastSyncAt && good && (
              <span className="font-normal text-muted"> · {relativeTime(conn.lastSyncAt)}</span>
            )}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{conn.detail}</p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {conn.action && (
          <button
            className={
              good
                ? btn
                : 'rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50'
            }
            disabled={busy || conn.state === 'syncing'}
            onClick={() => void run(conn.action)}
          >
            {busy ? 'Working…' : conn.actionLabel}
          </button>
        )}
        {conn.action !== 'refresh' && conn.source !== 'none' && (
          <button className={btn} disabled={busy} onClick={() => void run('refresh')}>
            Refresh Now
          </button>
        )}
        <button
          className={btn}
          onClick={async () => {
            await navigator.clipboard.writeText(await connectionDetails())
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'Copied' : 'Copy Connection Details'}
        </button>
      </div>
      {note && (
        <p role="status" className={`mt-2 text-xs ${note.ok ? 'text-muted' : 'text-danger'}`}>
          {note.text}
        </p>
      )}
    </div>
  )
}

const btn =
  'rounded-md border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover disabled:opacity-50'
/**
 * How this computer reaches Google. Colleagues sign in with the company's built-in Google sign-in
 * (nothing to create or paste); without it in this build, the private script is the way in.
 */
export function GoogleSettings({
  cal
}: {
  cal: CalendarStatus
  onSync?: () => void
  onConnect?: () => void
}): React.JSX.Element {
  const [cfg, setCfg] = useState<Settings['google']>({
    method: 'script',
    clientId: '',
    bridgeUrl: '',
    meetNotes: true,
    meetFullText: false,
    readMailBodies: true,
    chat: false
  })
  const [api, setApi] = useState<GoogleStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.invoke('settings:get').then((r) => alive && r.ok && setCfg(r.data.google))
    void window.api.invoke('google:api-status').then((r) => alive && r.ok && setApi(r.data))
    const offCal = window.api.on('calendar:changed', () => {
      void window.api.invoke('google:api-status').then((r) => alive && r.ok && setApi(r.data))
    })
    const offSettings = window.api.on('settings:changed', (s) => alive && setCfg(s.google))
    return () => {
      alive = false
      offCal()
      offSettings()
    }
  }, [])

  const updateCfg = async (patch: Partial<Settings['google']>): Promise<void> => {
    setCfg((c) => ({ ...c, ...patch }))
    // Only the changed fields: main merges them, so the script address can't be wiped.
    const r = await window.api.invoke('settings:update', { google: patch })
    if (r.ok) setCfg(r.data.google)
  }

  const connectApi = async (): Promise<void> => {
    setBusy(true)
    setMsg({ ok: true, text: 'Finish signing in in your browser…' })
    const r = await window.api.invoke('google:api-connect')
    setBusy(false)
    if (!r.ok) {
      setMsg({ ok: false, text: r.error.message })
      return
    }
    setApi(r.data)
    setCfg((c) => ({ ...c, method: 'oauth' }))
    setMsg({ ok: true, text: 'Signed in. Syncing your calendar and mail…' })
  }

  const disconnectApi = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.invoke('google:api-disconnect')
    setBusy(false)
    if (r.ok) {
      setApi(r.data)
      setCfg((c) => ({ ...c, method: r.data.method }))
      setMsg({ ok: true, text: 'Signed out of Google sign-in. The private script still works.' })
    } else setMsg({ ok: false, text: r.error.message })
  }

  const builtIn = !!api?.defaultClient
  const activeScopes = api
    ? (['calendar', 'gmail', 'meet', 'chat'] as const).filter((k) => api.scopes[k])
    : []

  const toggles = (
    <div className="space-y-1.5 pt-1">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={cfg.meetNotes}
          onChange={(e) => void updateCfg({ meetNotes: e.target.checked })}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Bring in Google Meet notes and transcripts
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={cfg.readMailBodies}
          onChange={(e) => void updateCfg({ readMailBodies: e.target.checked })}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Read recent email to find actions and decisions (the text is not kept)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={cfg.meetFullText}
          onChange={(e) => void updateCfg({ meetFullText: e.target.checked })}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Copy the whole Gemini notes into the meeting note (otherwise key points and a link)
      </label>
    </div>
  )

  if (!builtIn)
    return (
      <div className="space-y-3" data-testid="google-signin">
        <p className="rounded-xl border border-line bg-surface px-3 py-2 text-xs text-muted">
          Google sign-in is not set up in this build, so this computer uses your private script
          (above). Builds for your company include sign-in: then everyone just presses Sign In With
          Google.
        </p>
        {toggles}
        <p className="text-xs text-muted">Refreshes automatically every 15 minutes.</p>
      </div>
    )

  return (
    <div className="space-y-3" data-testid="google-signin">
      <div className="rounded-xl border border-line bg-surface p-3">
        <p className="text-sm font-semibold">Sign In With Google</p>
        <p className="mt-0.5 text-xs text-muted">
          Your company’s Google sign-in is built in. Sign in once with your own account; it stays
          signed in and also brings in Meet notes and Chat. Read-only.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {api?.connected ? (
            <>
              <span className="flex items-center gap-1.5 rounded-md bg-ok/10 px-2.5 py-1.5 text-sm">
                <span className="h-2 w-2 rounded-full bg-ok" />
                Signed in{api.email ? ` as ${api.email}` : ''}
              </span>
              <button className={btn} disabled={busy} onClick={() => void connectApi()}>
                Sign In Again
              </button>
              <button className={btn} disabled={busy} onClick={() => void disconnectApi()}>
                Sign Out
              </button>
            </>
          ) : (
            <button
              className="btn-primary rounded-lg px-4 py-1.5 text-sm font-semibold disabled:opacity-60"
              disabled={busy}
              onClick={() => void connectApi()}
            >
              {busy ? 'Waiting for Sign-In…' : 'Sign In With Google'}
            </button>
          )}
        </div>
        {msg && (
          <p role="status" className={`mt-2 text-xs ${msg.ok ? 'text-muted' : 'text-danger'}`}>
            {msg.text}
          </p>
        )}
        {api?.lastError && !msg && <p className="mt-2 text-xs text-danger">{api.lastError}</p>}
      </div>
      {api?.connected && (
        <p className="text-xs text-muted">
          {cal.lastSyncAt && `Last synced ${relativeTime(cal.lastSyncAt)}. `}
          Reading: {activeScopes.length ? activeScopes.join(', ') : 'calendar and mail'} · Meet
          files: {api.meet.files} · Chat messages: {api.chat.messages}
        </p>
      )}
      {toggles}
      <p className="text-xs text-muted">
        Changing Meet notes or Chat options takes effect the next time you sign in.
      </p>
    </div>
  )
}

export function TimeZoneSettings(): React.JSX.Element {
  const [tz, setTz] = useState('America/New_York')
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf(
        'timeZone'
      )
    } catch {
      return ['America/New_York']
    }
  }, [])
  useEffect(() => {
    void window.api.invoke('settings:get').then((r) => r.ok && setTz(r.data.timezone))
  }, [])
  const save = async (z: string): Promise<void> => {
    setTz(z)
    setAppTimezone(z)
    await window.api.invoke('settings:update', { timezone: z })
  }
  const list = zones.includes(tz) ? zones : [tz, ...zones]
  return (
    <>
      <p className="mb-2 text-xs text-muted">
        Work hours, “today”, nudge times and the weekly review follow this zone, not the clock on
        this computer, so they stay right when you travel. Pick the zone your Google Calendar uses.
      </p>
      <select
        value={tz}
        onChange={(e) => void save(e.target.value)}
        aria-label="Time zone"
        className="w-full rounded-lg border border-line bg-field px-2 py-1.5 text-sm"
      >
        {list.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
    </>
  )
}

export function PrivacySettings(): React.JSX.Element {
  const [cleared, setCleared] = useState(false)

  return (
    <>
      <h3 className="mt-5 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
        Email Data on This Computer
      </h3>
      <p className="mb-2 text-xs text-muted">
        Subjects, senders and dates are kept in the app’s data folder. Email text is read only in
        memory to find actions and decisions: just those points and a short excerpt are kept. Clear
        the list if you no longer want it there; it is rebuilt at the next mail sync.
      </p>
      <button
        className={btn}
        onClick={async () => {
          if (
            !window.confirm(
              'Remove all stored email subjects, senders and dates from this computer?'
            )
          )
            return
          const r = await window.api.invoke('mail:clear')
          setCleared(r.ok)
          setTimeout(() => setCleared(false), 3000)
        }}
      >
        Clear stored email data
      </button>
      {cleared && <span className="ml-2 text-xs text-ok">Cleared.</span>}
    </>
  )
}

export function SupportSettings(): React.JSX.Element {
  const [msg, setMsg] = useState<string | null>(null)
  const say = (m: string): void => {
    setMsg(m)
    setTimeout(() => setMsg(null), 5000)
  }
  return (
    <>
      <p className="mb-3 text-xs text-muted">
        Your notes are plain files in your notes folder. A backup is a single zip of that folder.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className={btn}
          onClick={async () => {
            say('Creating the backup…')
            const r = await window.api.invoke('app:backup')
            say(!r.ok ? r.error.message : r.data ? `Saved ${r.data.path}` : '')
          }}
        >
          Back Up My Notes…
        </button>
        <button
          className={btn}
          onClick={async () => {
            const r = await window.api.invoke('app:diagnostics')
            if (!r.ok) return say(r.error.message)
            try {
              await navigator.clipboard.writeText(r.data)
              say(
                'Copied. Paste it into a message when you ask for help. It contains no note or email content.'
              )
            } catch {
              say('Could not copy.')
            }
          }}
        >
          Copy Diagnostics
        </button>
        <button className={btn} onClick={() => void window.api.invoke('app:open-logs')}>
          Open the log folder
        </button>
      </div>
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </>
  )
}
