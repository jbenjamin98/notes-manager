import { useEffect, useState } from 'react'
import type { CalendarStatus, LlmStatus } from '@shared/contract'
import { KEY_GUIDES, type KeyGuide } from '../keyGuide'

const btn =
  'rounded-lg border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover disabled:opacity-50'
const primary =
  'rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50'

const STEPS = ['Welcome', 'Your notes', 'Google', 'AI (optional)', 'Shortcuts'] as const

/** Numbered "how to get a key" steps for one provider, with a button that opens the right page. */
export function KeySteps({ g, keyUrl }: { g: KeyGuide; keyUrl: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-surface p-3 text-sm">
      <p className="text-xs text-muted">
        {g.cost} A real key looks like <code className="rounded bg-field px-1">{g.looksLike}</code>
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
        {g.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <button
        className={`${btn} mt-3`}
        onClick={() => void window.api.invoke('app:open-external', { url: keyUrl })}
      >
        Open the key page
      </button>
      {g.note && <p className="mt-2 text-xs text-muted">{g.note}</p>}
    </div>
  )
}

function KeyStep(): React.JSX.Element {
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [pick, setPick] = useState<KeyGuide['id']>('gemini')
  const [key, setKey] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.invoke('llm:status').then((r) => r.ok && setStatus(r.data))
  }, [])
  const guide = KEY_GUIDES.find((g) => g.id === pick)!
  const prov = status?.providers.find((p) => p.id === pick)

  const save = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.invoke('llm:set-key', { provider: pick, key })
    if (!r.ok) {
      setBusy(false)
      return setMsg({ ok: false, text: r.error.message })
    }
    setKey('')
    setStatus(r.data)
    setMsg({ ok: true, text: 'Saved. Testing…' })
    const t = await window.api.invoke('llm:test', { provider: pick })
    setBusy(false)
    setMsg(t.ok ? { ok: t.data.ok, text: t.data.message } : { ok: false, text: t.error.message })
    const s = await window.api.invoke('llm:status')
    if (s.ok) setStatus(s.data)
  }

  return (
    <div>
      <p className="text-sm">
        The Co-Pilot answers questions about your notes and turns a messy brain-dump into tasks and
        notes. It needs <strong>your own</strong> API key. This step is optional: skip it and
        everything else still works, and you can add a key later in Settings.
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Provider">
        {KEY_GUIDES.map((g) => (
          <button
            key={g.id}
            role="tab"
            aria-selected={g.id === pick}
            onClick={() => {
              setPick(g.id)
              setMsg(null)
            }}
            className={`rounded-full border px-3 py-1 text-xs ${g.id === pick ? 'border-transparent bg-accent-soft' : 'border-line text-muted hover:bg-hover'}`}
          >
            {g.name}
            {g.id === 'gemini' && ' (recommended)'}
          </button>
        ))}
      </div>
      <div className="mt-3">
        <KeySteps g={guide} keyUrl={prov?.keyUrl ?? ''} />
      </div>
      {status && !status.canStoreKeys && (
        <p className="mt-2 text-xs text-danger">
          This computer cannot encrypt secrets, so a key cannot be saved.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={
            prov?.hasKey
              ? 'A key is saved. Paste a new one to replace it'
              : 'Paste your API key here'
          }
          aria-label={`${guide.name} API key`}
          className="min-w-0 flex-1 rounded-lg border border-line bg-field px-3 py-1.5 text-sm"
        />
        <button
          className={btn}
          disabled={busy || !key.trim() || !status?.canStoreKeys}
          onClick={() => void save()}
        >
          Save and test
        </button>
      </div>
      {msg && (
        <p className={`mt-1.5 text-xs ${msg.ok ? 'text-muted' : 'text-danger'}`}>{msg.text}</p>
      )}
      <p className="mt-3 text-xs text-muted">
        Your key is encrypted for your Windows account on this computer. Anything marked CUI, and
        your email, is never sent to an AI.
      </p>
    </div>
  )
}

export default function SetupGuide({
  cal,
  onConnect,
  onFinish
}: {
  cal: CalendarStatus
  onConnect: () => void
  onFinish: () => void
}): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [vault, setVault] = useState('')
  const [name, setName] = useState('')
  const connected = cal.state !== 'needs-auth' && cal.lastSyncAt !== null

  useEffect(() => {
    void window.api.invoke('settings:get').then((r) => {
      if (!r.ok) return
      setVault(r.data.vaultPath)
      const own = r.data.meAliases.find((a) => a.toLowerCase() !== 'me')
      if (own) setName(own)
    })
  }, [])

  const chooseVault = async (): Promise<void> => {
    const picked = await window.api.invoke('vault:choose-folder')
    if (picked.ok && picked.data) {
      const u = await window.api.invoke('settings:update', { vaultPath: picked.data })
      if (u.ok) setVault(u.data.vaultPath)
    }
  }
  const saveName = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    const first = n.split(/\s+/)[0]
    await window.api.invoke('settings:update', { meAliases: [...new Set(['Me', n, first])] })
  }

  const last = step === STEPS.length - 1
  const next = async (): Promise<void> => {
    if (step === 1) await saveName()
    if (last) return onFinish()
    setStep((s) => s + 1)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Setup guide"
    >
      <div className="glass flex max-h-[92vh] w-[40rem] max-w-full flex-col overflow-hidden rounded-3xl">
        <div className="flex items-center gap-2 border-b border-line px-6 py-3">
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-1 flex-col gap-1">
              <div
                className={`h-1 rounded-full transition-colors ${i <= step ? 'bg-[var(--accent)]' : 'bg-hover'}`}
              />
              <span className={`text-[10px] ${i === step ? 'text-fg' : 'text-muted'}`}>{s}</span>
            </div>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && (
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Welcome to notes-manager</h1>
              <p className="mt-2 text-sm text-muted">
                Three minutes to set up. You can change everything later in Settings.
              </p>
              <ul className="mt-4 space-y-3 text-sm">
                <li>
                  <strong>Notes that stay yours.</strong> Every note is a plain file in a folder on
                  your computer. Nothing is locked in, and old notes are never removed.
                </li>
                <li>
                  <strong>Your calendar, ready for notes.</strong> Your Google Calendar meetings
                  appear here so you can start notes in one click, with prep for what happened last
                  time.
                </li>
                <li>
                  <strong>Tasks that find themselves.</strong> Write “Remind Sarah to send the deck
                  by Friday” and the owner and date are picked up for you.
                </li>
                <li>
                  <strong>Nudges and a Co-Pilot.</strong> Gentle reminders before meetings and at
                  the end of the day, plus an assistant that answers questions about your notes.
                </li>
              </ul>
            </div>
          )}

          {step === 1 && (
            <div>
              <h2 className="text-xl font-semibold">Where your notes live</h2>
              <p className="mt-2 text-sm text-muted">
                Notes are saved as files in this folder. If it sits inside a folder that Google
                Drive backs up (such as your Desktop), your notes are backed up automatically.
              </p>
              <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm break-all">
                {vault || '…'}
              </p>
              <button className={`${btn} mt-2`} onClick={() => void chooseVault()}>
                Choose a different folder…
              </button>
              <label className="mt-5 block text-sm font-medium" htmlFor="setup-name">
                What is your name?
              </label>
              <input
                id="setup-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Jacob Benjamin"
                className="mt-1 w-full rounded-lg border border-line bg-field px-3 py-1.5 text-sm"
              />
              <p className="mt-1 text-xs text-muted">
                So tasks written for you are recognised as yours. It also happens automatically
                after you connect Google.
              </p>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-xl font-semibold">Connect Google</h2>
              <p className="mt-2 text-sm text-muted">
                This brings in your calendar and the emails you may owe a reply to. You sign in to
                Google in a separate, private window, exactly as you would in a browser (password,
                then your security key if your company requires one). The app never sees your
                password, and it only reads: it never sends email or edits your calendar.
              </p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
                <li>You may need to sign in again each day if your company signs you out.</li>
                <li>
                  Only email subjects, senders and dates are kept, on this computer. Message bodies
                  are never read.
                </li>
                <li>You can skip this and connect later with the Sign in button on the sidebar.</li>
              </ul>
              <div className="mt-4 flex items-center gap-3">
                <button className={primary} onClick={onConnect}>
                  {connected ? 'Sign in again' : 'Sign in to Google'}
                </button>
                {connected ? (
                  <span className="text-sm text-ok">Connected ✓</span>
                ) : (
                  <span className="text-xs text-muted">A sign-in window will open.</span>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 className="text-xl font-semibold">Turn on the Co-Pilot (optional)</h2>
              <div className="mt-2">
                <KeyStep />
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <h2 className="text-xl font-semibold">You are set</h2>
              <p className="mt-2 text-sm text-muted">A few shortcuts worth knowing:</p>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {[
                  ['Ctrl + N', 'Start a new note'],
                  ['Ctrl + K', 'Search everything and run any action'],
                  ['Ctrl + J', 'Open the Co-Pilot'],
                  [
                    'Ctrl + Shift + Space',
                    'Add a task from any app, even when this window is hidden'
                  ]
                ].map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt>
                      <kbd className="rounded-md border border-line bg-field px-2 py-0.5 text-xs">
                        {k}
                      </kbd>
                    </dt>
                    <dd className="text-muted">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 text-xs text-muted">
                Closing the window keeps the app in the system tray so reminders still arrive. You
                can reopen this guide any time from Settings.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-6 py-3">
          <button className={btn} disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            Back
          </button>
          <span className="flex-1" />
          {!last && (
            <button className="text-sm text-muted hover:text-fg" onClick={onFinish}>
              Skip setup
            </button>
          )}
          <button className={primary} onClick={() => void next()}>
            {last ? 'Start using notes-manager' : step === 3 ? 'Next' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
