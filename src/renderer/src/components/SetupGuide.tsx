import { useCallback, useEffect, useRef, useState } from 'react'
import type { LlmStatus } from '@shared/contract'
import { KEY_GUIDES, type KeyGuide } from '../keyGuide'
import { useFocusTrap } from '../useFocusTrap'
import { useGoogleConnection } from '../hooks'
import { BridgeSetup } from './BridgeSetup'
import Confetti from './Confetti'
import { SparkleIcon } from './Icons'

const btn =
  'rounded-lg border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover disabled:opacity-50'
const primary =
  'btn-primary rounded-lg px-4 py-1.5 text-sm font-semibold disabled:opacity-50 disabled:transform-none'

const STEPS = ['Welcome', 'Your Notes', 'Google', 'AI', 'Shortcuts'] as const
/** A small animated picture per step. */
const ART = ['👋', '📁', '🔗', 'ai', '🎉'] as const

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
        Open the Key Page
      </button>
      {g.note && <p className="mt-2 text-xs text-muted">{g.note}</p>}
    </div>
  )
}

type KeyPhase = 'idle' | 'typing' | 'checking' | 'ok' | 'bad'
export interface KeyDraft {
  pick: KeyGuide['id']
  key: string
  phase: KeyPhase
  text: string
}

/** Looks like something worth testing (no spaces, long enough). */
const plausible = (k: string): boolean => k.trim().length >= 20 && !/\s/.test(k.trim())

/**
 * Saves and tests a key as soon as it looks like one (paste is enough), so leaving the step never
 * loses it. The state lives in the guide, not the step.
 */
function useKeyDraft(onStatus: (s: LlmStatus) => void): {
  draft: KeyDraft
  setDraft: (d: Partial<KeyDraft>) => void
  commit: () => Promise<void>
} {
  const [draft, setState] = useState<KeyDraft>({ pick: 'gemini', key: '', phase: 'idle', text: '' })
  const setDraft = useCallback((d: Partial<KeyDraft>) => setState((s) => ({ ...s, ...d })), [])
  const running = useRef<string | null>(null)

  const commit = useCallback(async (): Promise<void> => {
    const { pick, key } = draft
    const k = key.trim()
    if (!k || running.current === pick + k) return
    running.current = pick + k
    setDraft({ phase: 'checking', text: 'Checking your key…' })
    const r = await window.api.invoke('llm:set-key', { provider: pick, key: k })
    if (!r.ok) {
      running.current = null
      return setDraft({ phase: 'bad', text: r.error.message })
    }
    onStatus(r.data)
    const t = await window.api.invoke('llm:test', { provider: pick })
    running.current = null
    const ok = t.ok && t.data.ok
    setDraft({
      phase: ok ? 'ok' : 'bad',
      text: t.ok ? t.data.message : t.error.message,
      key: ok ? '' : key
    })
    const s = await window.api.invoke('llm:status')
    if (s.ok) onStatus(s.data)
  }, [draft, onStatus, setDraft])

  // Paste (or finish typing) a plausible key: save and test it without a button press.
  useEffect(() => {
    if (draft.phase !== 'typing' || !plausible(draft.key)) return
    const t = setTimeout(() => void commit(), 700)
    return () => clearTimeout(t)
  }, [draft.phase, draft.key, commit])

  return { draft, setDraft, commit }
}

function KeyStep({
  status,
  draft,
  setDraft,
  commit
}: {
  status: LlmStatus | null
  draft: KeyDraft
  setDraft: (d: Partial<KeyDraft>) => void
  commit: () => Promise<void>
}): React.JSX.Element {
  const guide = KEY_GUIDES.find((g) => g.id === draft.pick)!
  const prov = status?.providers.find((p) => p.id === draft.pick)
  const working = status?.providers.filter((p) => p.hasKey && p.state !== 'auth-failed') ?? []

  return (
    <div className="wiz-stagger">
      <p className="text-sm">
        The Co-Pilot answers questions about your notes and turns a messy brain-dump into tasks and
        notes. It needs <strong>your own</strong> API key. Optional: skip it and everything else
        still works.
      </p>

      {working.length > 0 && (
        <div
          data-testid="ai-connected"
          className="pop mt-3 flex items-center gap-2 rounded-xl border border-ok/30 bg-ok/10 px-3 py-2 text-sm"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ok text-xs text-white">
            ✓
          </span>
          <span>
            <strong>Connected:</strong> {working.map((p) => p.label).join(', ')}
            <span className="text-muted"> · {working[0].models.chat}</span>
          </span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Provider">
        {KEY_GUIDES.map((g) => {
          const p = status?.providers.find((x) => x.id === g.id)
          return (
            <button
              key={g.id}
              role="tab"
              aria-selected={g.id === draft.pick}
              onClick={() => setDraft({ pick: g.id, phase: 'idle', text: '', key: '' })}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${g.id === draft.pick ? 'border-transparent bg-accent-soft' : 'border-line text-muted hover:bg-hover'}`}
            >
              {p?.hasKey && (
                <span
                  aria-label="key saved"
                  className={`h-1.5 w-1.5 rounded-full ${p.state === 'auth-failed' ? 'bg-danger' : 'bg-ok'}`}
                />
              )}
              {g.name}
              {g.id === 'gemini' && ' (Recommended)'}
            </button>
          )
        })}
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
        <div className="relative min-w-0 flex-1">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft.key}
            onChange={(e) => setDraft({ key: e.target.value, phase: 'typing', text: '' })}
            onKeyDown={(e) => e.key === 'Enter' && void commit()}
            placeholder={
              prov?.hasKey
                ? 'A key is saved. Paste a new one to replace it'
                : 'Paste your API key here'
            }
            aria-label={`${guide.name} API key`}
            className={`w-full rounded-lg border bg-field py-1.5 pr-8 pl-3 text-sm transition-colors ${
              draft.phase === 'ok'
                ? 'border-ok'
                : draft.phase === 'bad'
                  ? 'border-danger'
                  : 'border-line'
            }`}
          />
          <span aria-hidden className="absolute top-1/2 right-2.5 -translate-y-1/2 text-sm">
            {draft.phase === 'checking' ? (
              <span className="spin inline-block h-3.5 w-3.5 rounded-full border-2 border-accent border-t-transparent" />
            ) : draft.phase === 'ok' ? (
              <span className="pop inline-block text-ok">✓</span>
            ) : draft.phase === 'bad' ? (
              <span className="pop inline-block text-danger">!</span>
            ) : null}
          </span>
        </div>
        <button
          className={btn}
          disabled={draft.phase === 'checking' || !draft.key.trim() || !status?.canStoreKeys}
          onClick={() => void commit()}
        >
          Save and Test
        </button>
      </div>
      <p
        role="status"
        data-testid="key-status"
        className={`mt-1.5 min-h-4 text-xs ${draft.phase === 'bad' ? 'text-danger' : draft.phase === 'ok' ? 'text-ok' : 'text-muted'}`}
      >
        {draft.phase === 'typing' && draft.key && !plausible(draft.key)
          ? `Keep going: ${guide.name} keys look like ${guide.looksLike}`
          : draft.phase === 'typing'
            ? 'Looks like a key. Checking in a moment…'
            : draft.text}
      </p>
      <p className="mt-2 text-xs text-muted">
        Your key is encrypted for your Windows account on this computer.
      </p>
    </div>
  )
}

/** A floating picture for each step. */
function StepArt({ step }: { step: number }): React.JSX.Element {
  const a = ART[step]
  return (
    <div
      key={step}
      aria-hidden
      className="wiz-art relative mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl text-3xl"
    >
      <span className="wiz-art-glow absolute inset-0 rounded-2xl" />
      <span className="relative">{a === 'ai' ? <SparkleIcon width={34} height={34} /> : a}</span>
    </div>
  )
}

export default function SetupGuide({ onFinish }: { onFinish: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  useFocusTrap(dialog, onFinish)
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')
  const [vault, setVault] = useState('')
  const [name, setName] = useState('')
  const [nameSaved, setNameSaved] = useState(false)
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [celebrate, setCelebrate] = useState(0)
  const conn = useGoogleConnection()
  const { draft, setDraft, commit } = useKeyDraft(setStatus)
  // The organisation may ship a built-in Google sign-in; otherwise the private script is the way in.
  const [oauthDefault, setOauthDefault] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(false)
  useEffect(() => {
    void window.api
      .invoke('google:api-status')
      .then((r) => r.ok && setOauthDefault(r.data.defaultClient))
    void window.api.invoke('llm:status').then((r) => r.ok && setStatus(r.data))
    void window.api.invoke('settings:get').then((r) => {
      if (!r.ok) return
      setVault(r.data.vaultPath)
      const own = r.data.meAliases.find((a) => a.toLowerCase() !== 'me')
      if (own) {
        setName(own)
        setNameSaved(true)
      }
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
    setNameSaved(true)
  }

  const aiOn = !!status?.providers.some((p) => p.hasKey && p.state !== 'auth-failed')
  const checklist = [
    { label: 'Notes Folder', done: !!vault, step: 1 },
    { label: 'Your Name', done: nameSaved && !!name.trim(), step: 1 },
    { label: 'Google', done: conn?.state === 'ok' || conn?.state === 'syncing', step: 2 },
    { label: 'AI', done: aiOn, step: 3 }
  ]
  const doneCount = checklist.filter((c) => c.done).length

  const last = step === STEPS.length - 1
  const go = async (to: number): Promise<void> => {
    if (to < 0 || to >= STEPS.length || to === step) return
    if (step === 1) await saveName()
    // A key typed but not yet checked is saved on the way out, never dropped.
    if (step === 3 && draft.key.trim() && draft.phase !== 'ok') void commit()
    setDir(to > step ? 'fwd' : 'back')
    setStep(to)
    if (to === STEPS.length - 1) setCelebrate((n) => n + 1)
  }
  const next = (): void => {
    if (last) onFinish()
    else void go(step + 1)
  }

  // Keyboard: Enter for next, Left/Right to move (when not typing in a field).
  const onKey = (e: React.KeyboardEvent): void => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)
    if (e.key === 'Enter' && !typing && (e.target as HTMLElement).tagName !== 'BUTTON') next()
    if (!typing && e.key === 'ArrowRight') void go(step + 1)
    if (!typing && e.key === 'ArrowLeft') void go(step - 1)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Setup guide"
      onKeyDown={onKey}
    >
      {celebrate > 0 && <Confetti nonce={celebrate} onDone={() => undefined} />}
      <div
        ref={dialog}
        className="glass spring-in flex max-h-[92vh] w-[42rem] max-w-full flex-col overflow-hidden rounded-3xl"
      >
        {/* Progress: one bar that fills, and step dots that tick */}
        <div className="border-b border-line px-6 pt-4 pb-3">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-hover">
            <div
              className="wiz-bar absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-1">
            {STEPS.map((s, i) => (
              <button
                key={s}
                onClick={() => void go(i)}
                aria-current={i === step ? 'step' : undefined}
                className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition ${i === step ? 'bg-accent-soft font-semibold text-fg' : 'text-muted hover:text-fg'}`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] transition-colors ${i < step ? 'bg-accent text-accent-fg' : i === step ? 'border-2 border-accent' : 'border border-line'}`}
                >
                  {i < step ? <span className="pop">✓</span> : ''}
                </span>
                <span className="hidden sm:inline">{s}</span>
              </button>
            ))}
          </div>
        </div>

        {/* What is done so far: ticks as you go */}
        <div
          className="flex flex-wrap items-center gap-1.5 px-6 pt-3"
          data-testid="setup-checklist"
        >
          {checklist.map((c) => (
            <button
              key={c.label}
              onClick={() => void go(c.step)}
              data-done={c.done}
              className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-all duration-300 ${c.done ? 'border-ok/30 bg-ok/10 text-fg' : 'border-line text-muted hover:bg-hover'}`}
            >
              <span
                key={String(c.done)}
                className={`${c.done ? 'pop text-ok' : 'text-muted'} inline-block w-3 text-center`}
              >
                {c.done ? '✓' : '○'}
              </span>
              {c.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted tabular-nums">{doneCount} of 4 ready</span>
        </div>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-5">
          <div key={step} className={dir === 'fwd' ? 'wiz-in-fwd' : 'wiz-in-back'}>
            <StepArt step={step} />
            {step === 0 && (
              <div className="wiz-stagger text-center">
                <h1 className="text-2xl font-semibold tracking-tight">Welcome to Note Manager</h1>
                <p className="mt-2 text-sm text-muted">
                  Three minutes to set up. You can change everything later in Settings.
                </p>
                <ul className="mx-auto mt-5 grid max-w-xl gap-2.5 text-left text-sm sm:grid-cols-2">
                  {[
                    [
                      '📝',
                      'Notes That Stay Yours',
                      'Plain files in a folder you own. Nothing locked in.'
                    ],
                    ['📅', 'Your Calendar, Ready', 'Start a meeting note in one click, with prep.'],
                    [
                      '✅',
                      'Tasks Find Themselves',
                      '“Send the budget to Sarah by Friday” becomes your task, tagged with Sarah.'
                    ],
                    ['✨', 'A Co-Pilot', 'Nudges before meetings and answers about your notes.']
                  ].map(([icon, t, d]) => (
                    <li key={t} className="wiz-card rounded-xl border border-line bg-surface p-3">
                      <span className="text-lg">{icon}</span>
                      <strong className="mt-1 block">{t}</strong>
                      <span className="text-xs text-muted">{d}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {step === 1 && (
              <div className="wiz-stagger">
                <h2 className="text-center text-xl font-semibold">Where Your Notes Live</h2>
                <p className="mt-2 text-sm text-muted">
                  Notes are saved as files in this folder. If Google Drive backs it up (such as your
                  Desktop), your notes are backed up automatically.
                </p>
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
                  <span className="pop text-ok">✓</span>
                  <span className="min-w-0 flex-1 break-all">{vault || '…'}</span>
                </div>
                <button className={`${btn} mt-2`} onClick={() => void chooseVault()}>
                  Choose a Different Folder…
                </button>
                <label className="mt-5 block text-sm font-medium" htmlFor="setup-name">
                  What is your name?
                </label>
                <div className="relative mt-1">
                  <input
                    id="setup-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setNameSaved(false)
                    }}
                    onBlur={() => void saveName()}
                    onKeyDown={(e) => e.key === 'Enter' && void saveName()}
                    placeholder="e.g. Jacob Benjamin"
                    className="w-full rounded-lg border border-line bg-field px-3 py-1.5 pr-8 text-sm"
                  />
                  {nameSaved && name.trim() && (
                    <span className="pop absolute top-1/2 right-2.5 -translate-y-1/2 text-ok">
                      ✓
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted">
                  So tasks written for you are recognised as yours. Connecting Google fills this in
                  too.
                </p>
              </div>
            )}

            {step === 2 && (
              <div className="wiz-stagger">
                <h2 className="text-center text-xl font-semibold">Connect Google</h2>
                <p className="mt-2 text-sm text-muted">
                  Brings in your calendar, emails you may owe a reply to, Meet notes and Chat, and
                  pulls out what matters with a link back to the source. Read-only: it never sends
                  email or edits your calendar.
                </p>
                {oauthDefault && (
                  <div className="mt-4 rounded-xl border border-line bg-surface p-3">
                    <p className="text-sm font-medium">Sign In With Google</p>
                    <p className="mt-1 text-xs text-muted">
                      One click, then sign in as you normally would.
                    </p>
                    <button
                      className={`${primary} mt-2`}
                      disabled={oauthBusy}
                      onClick={() => {
                        setOauthBusy(true)
                        void window.api
                          .invoke('google:api-connect')
                          .finally(() => setOauthBusy(false))
                      }}
                    >
                      {oauthBusy ? 'Waiting for Sign-In…' : 'Sign In With Google'}
                    </button>
                  </div>
                )}
                <div className="mt-4">
                  <p className="mb-1 text-xs font-medium text-muted">
                    {oauthDefault
                      ? 'Or use your own private script'
                      : 'Set up your private script (about 5 minutes)'}
                  </p>
                  <BridgeSetup />
                </div>
              </div>
            )}

            {step === 3 && (
              <div>
                <h2 className="mb-2 text-center text-xl font-semibold">Turn On the Co-Pilot</h2>
                <KeyStep status={status} draft={draft} setDraft={setDraft} commit={commit} />
              </div>
            )}

            {step === 4 && (
              <div className="wiz-stagger">
                <h2 className="text-center text-xl font-semibold">You Are Set</h2>
                <p className="mt-2 text-center text-sm text-muted">
                  {doneCount === 4
                    ? 'Everything is connected.'
                    : `${doneCount} of 4 ready. The rest can wait: Settings has it all.`}
                </p>
                <dl className="mx-auto mt-4 grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  {[
                    ['Ctrl + N', 'Start a new note'],
                    ['Ctrl + K', 'Search everything and run any action'],
                    ['Ctrl + J', 'Open the Co-Pilot'],
                    ['Ctrl + Shift + Space', 'Add a task or note from any app']
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
                <p className="mt-4 text-center text-xs text-muted">
                  Closing the window keeps the app in the system tray so reminders still arrive.
                  Reopen this guide any time from Settings.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-line px-6 py-3">
          <button className={btn} disabled={step === 0} onClick={() => void go(step - 1)}>
            Back
          </button>
          <span className="flex-1" />
          {!last && (
            <button className="text-sm text-muted hover:text-fg" onClick={onFinish}>
              {step === 3 && !aiOn ? 'Skip AI and Finish' : 'Skip Setup'}
            </button>
          )}
          <button className={primary} onClick={next} data-testid="setup-next">
            {last ? 'Start Using Note Manager' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
