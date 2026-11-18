import { useEffect, useState } from 'react'
import type { BridgeStatus, BridgeVerify, GoogleHealth } from '@shared/contract'
import { relativeTime } from '../format'

const btn =
  'rounded-md border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover disabled:opacity-50'
const primary =
  'rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50'

const SECTION_LABEL: Record<string, string> = {
  calendar: 'Calendar',
  mail: 'Mail',
  meet: 'Meeting notes',
  chat: 'Chat'
}

/**
 * Google connection through your own private Apps Script. Nothing here reads a screen: you copy a
 * small read-only script into your own Google account, deploy it for yourself, and paste its address.
 */
export function BridgeSetup(): React.JSX.Element {
  const [st, setSt] = useState<BridgeStatus | null>(null)
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState<'script' | 'manifest' | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [res, setRes] = useState<BridgeVerify | null>(null)
  const [open, setOpen] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [health, setHealth] = useState<GoogleHealth | null>(null)

  // Health and status follow every change (setup, verify, sync), not just a slow poll, so this
  // panel never says "not connected" after setup worked.
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api.invoke('google:health').then((r) => alive && r.ok && setHealth(r.data))
      void window.api.invoke('google:bridge-status').then((r) => alive && r.ok && setSt(r.data))
    }
    const first = setTimeout(load, 0)
    const t = setInterval(load, 30_000)
    const offs = [
      window.api.on('google:changed', load),
      window.api.on('calendar:changed', load),
      window.api.on('gmail:changed', load),
      window.api.on('settings:changed', load)
    ]
    return () => {
      alive = false
      clearTimeout(first)
      clearInterval(t)
      offs.forEach((o) => o())
    }
  }, [])

  // Builds with the company's Google sign-in make the script an alternative, not the first step.
  const [signInBuild, setSignInBuild] = useState(false)
  useEffect(() => {
    void Promise.all([
      window.api.invoke('google:bridge-status'),
      window.api.invoke('google:api-status')
    ]).then(([r, a]) => {
      const builtIn = a.ok && a.data.defaultClient
      setSignInBuild(builtIn)
      if (r.ok) {
        setSt(r.data)
        setUrl(r.data.url)
        setOpen(!r.data.configured && !builtIn)
      }
    })
  }, [])

  const copy = async (what: 'script' | 'manifest'): Promise<void> => {
    const r = await window.api.invoke('google:bridge-script')
    if (!r.ok) return setErr(r.error.message)
    await navigator.clipboard.writeText(what === 'script' ? r.data.script : r.data.manifest)
    setCopied(what)
    const s = await window.api.invoke('google:bridge-status')
    if (s.ok) setSt(s.data)
  }

  const repair = async (): Promise<void> => {
    setRepairing(true)
    const r = await window.api.invoke('google:repair')
    if (r.ok) setRes(r.data)
    const h = await window.api.invoke('google:health')
    if (h.ok) setHealth(h.data)
    setRepairing(false)
  }

  const verify = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    setRes(null)
    const c = await window.api.invoke('google:bridge-configure', { url })
    if (!c.ok) {
      setBusy(false)
      return setErr(c.error.message)
    }
    setSt(c.data)
    const r = await window.api.invoke('google:bridge-verify')
    setBusy(false)
    if (r.ok) setRes(r.data)
    else setErr(r.error.message)
  }

  const fix = (code: string | null): string | null =>
    code === 'needs-login'
      ? 'Sign in to Google, then verify again.'
      : code === 'needs-update'
        ? 'Copy the script again, paste it over the old one, then Deploy > Manage deployments > Edit > New version.'
        : code === 'bad-token'
          ? 'The pasted script has a different key. Copy it again from here and redeploy.'
          : null

  return (
    <div className="rounded-lg border border-line p-3" data-testid="bridge-setup">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">
            {signInBuild && !st?.configured
              ? 'Or use your own private script'
              : 'Your Google account (private script)'}
          </div>
          <div className="text-xs text-muted">
            {st?.configured
              ? 'Connected through your own read-only script.'
              : signInBuild
                ? 'Only if Sign In With Google does not work for you. About 5 minutes.'
                : 'Calendar, mail and meeting notes, about 5 minutes to set up.'}
          </div>
        </div>
        <button className={btn} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : st?.configured ? 'Manage' : 'Set up'}
        </button>
      </div>

      {health && (
        <ul className="mt-3 space-y-1" data-testid="google-health">
          {health.rows.map((r) => (
            <li key={r.section} className="flex items-start gap-2 text-sm">
              <span
                className={
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full ' +
                  (r.state === 'healthy'
                    ? 'bg-ok'
                    : r.state === 'off'
                      ? 'bg-muted'
                      : r.state === 'syncing'
                        ? 'bg-accent'
                        : 'bg-warn')
                }
              />
              <div className="min-w-0 flex-1">
                <div>
                  <b>{r.label}</b>
                  <span className="text-xs text-muted">
                    {r.source === 'api'
                      ? ' · Google sign-in'
                      : r.source === 'bridge'
                        ? ' · Private script'
                        : ''}
                    {r.lastAt ? ` · ${relativeTime(r.lastAt)}` : ''}
                  </span>
                </div>
                <div className="text-xs text-muted">{r.detail}</div>
              </div>
              {(r.state === 'degraded' || r.state === 'syncing') && (
                <button className={btn} disabled={repairing} onClick={() => void repair()}>
                  {repairing ? 'Repairing…' : 'Repair'}
                </button>
              )}
              {r.state === 'needs-login' && (
                <button className={btn} onClick={() => void window.api.invoke('google:open-login')}>
                  Sign in
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <ol className="mt-3 space-y-3 text-sm">
          <li>
            <b>1.</b> Open{' '}
            <button
              className="text-[var(--accent)] underline"
              onClick={() =>
                void window.api.invoke('app:open-external', { url: 'https://script.google.com/' })
              }
            >
              script.google.com
            </button>{' '}
            and choose <b>New project</b>.
          </li>
          <li>
            <b>2.</b> Replace everything in the editor with the script:{' '}
            <button className={btn} onClick={() => void copy('script')}>
              {copied === 'script' ? 'Copied' : 'Copy script'}
            </button>
            <div className="mt-1 text-xs text-muted">
              It only reads your calendar, email (subjects, senders and the text of recent threads,
              to find actions and decisions), and meeting-notes documents. It never changes or sends
              anything.
            </div>
          </li>
          <li>
            <b>3.</b> Click <b>Project Settings</b> (gear), tick <b>Show appsscript.json</b>, open
            that file and replace it with:{' '}
            <button className={btn} onClick={() => void copy('manifest')}>
              {copied === 'manifest' ? 'Copied' : 'Copy settings file'}
            </button>
          </li>
          <li>
            <b>4.</b> Click <b>Deploy &gt; New deployment &gt; Web app</b>. Set{' '}
            <i>Execute as: Me</i> and <i>Who has access: Only myself</i>, then Deploy and approve
            the permissions.
          </li>
          <li>
            <b>5.</b> Paste the web app address (ends in <code>/exec</code>):
            <div className="mt-1 flex gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://script.google.com/macros/s/…/exec"
                className="min-w-0 flex-1 rounded-lg border border-line bg-field px-3 py-1.5 text-sm"
              />
              <button
                className={primary}
                disabled={busy || !url.trim()}
                onClick={() => void verify()}
              >
                {busy ? 'Checking…' : 'Verify'}
              </button>
            </div>
          </li>
        </ol>
      )}

      {err && <div className="mt-2 text-sm text-danger">{err}</div>}
      {res && (
        <div className="mt-3 text-sm" data-testid="bridge-result">
          {res.ok ? (
            <div className="text-ok">Connected as {res.email}.</div>
          ) : (
            <div className="text-danger">
              {res.message} {fix(res.code)}
              {res.code === 'needs-login' && (
                <button
                  className={btn + ' ml-2'}
                  onClick={() => void window.api.invoke('google:open-login')}
                >
                  Sign in
                </button>
              )}
            </div>
          )}
          {res.sections.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {res.sections.map((s) => (
                <li key={s.name} className={s.ok ? 'text-ok' : 'text-warn'}>
                  {s.ok ? '✓' : '!'} {SECTION_LABEL[s.name] ?? s.name}
                  {!s.ok && s.error ? `: ${s.error}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
