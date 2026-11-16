import { useCallback, useEffect, useState } from 'react'
import type { LlmStatus } from '@shared/contract'
import { relativeTime } from '../format'
import { KEY_GUIDES } from '../keyGuide'
import { KeySteps } from './SetupGuide'
import AiModeSwitch from './AiModeSwitch'

type P = LlmStatus['providers'][number]

const btn =
  'rounded-md border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover disabled:opacity-50'
const small =
  'rounded-md border border-line bg-field px-2 py-1 text-xs font-medium hover:bg-hover disabled:opacity-40'

const STATE_TEXT: Record<P['state'], string> = {
  ready: 'Ready',
  cooldown: 'Cooling down. It resumes by itself.',
  'auth-failed': 'Key rejected. Paste a new one.',
  'no-key': 'No key yet',
  disabled: 'Switched off'
}

const n = (v: number): string => v.toLocaleString()

function Usage({ p }: { p: P }): React.JSX.Element {
  const l = p.limits
  return (
    <div className="mt-2 rounded-lg bg-surface px-3 py-2 text-xs text-muted">
      <p>
        <span className="text-fg">Used by this app today:</span> {n(p.usage.today)} request
        {p.usage.today === 1 ? '' : 's'}
        {p.usage.failedToday > 0 && ` (${p.usage.failedToday} failed)`}
        {p.usage.tokensToday > 0 && `, about ${n(p.usage.tokensToday)} tokens`}
      </p>
      {l ? (
        <p>
          <span className="text-fg">{p.label} reports:</span>{' '}
          {l.remainingRequests !== null &&
            `${n(l.remainingRequests)}${l.limitRequests !== null ? ` of ${n(l.limitRequests)}` : ''} requests left`}
          {l.remainingRequests !== null && l.remainingTokens !== null && ', '}
          {l.remainingTokens !== null &&
            `${n(l.remainingTokens)}${l.limitTokens !== null ? ` of ${n(l.limitTokens)}` : ''} tokens left`}{' '}
          in its current window ({relativeTime(new Date(l.seenAt).toISOString())}).
        </p>
      ) : (
        <p>
          {p.id === 'gemini'
            ? 'Google does not report remaining quota for API keys, so only this app’s own count is shown. Your quota is on aistudio.google.com.'
            : p.hasKey
              ? 'Remaining limits appear here after the first request.'
              : 'Remaining limits appear here once you add a key and use it.'}
        </p>
      )}
    </div>
  )
}

function Models({ p, onChange }: { p: P; onChange: (s: LlmStatus) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [extract, setExtract] = useState(p.models.extract)
  const [chat, setChat] = useState(p.models.chat)
  const save = async (reset: boolean): Promise<void> => {
    const r = await window.api.invoke('llm:configure', {
      provider: p.id,
      models: reset ? { extract: '', chat: '' } : { extract, chat }
    })
    if (r.ok) {
      onChange(r.data)
      const me = r.data.providers.find((x) => x.id === p.id)
      if (me) {
        setExtract(me.models.extract)
        setChat(me.models.chat)
      }
    }
  }
  return (
    <div className="mt-2 text-xs">
      <button className="text-muted underline" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide model names' : `Models: ${p.models.chat}${p.modelsCustom ? ' (custom)' : ''}`}
      </button>
      {open && (
        <div className="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
          <label htmlFor={`${p.id}-chat`}>Questions</label>
          <input
            id={`${p.id}-chat`}
            value={chat}
            onChange={(e) => setChat(e.target.value)}
            className="rounded-md border border-line bg-field px-2 py-1"
          />
          <label htmlFor={`${p.id}-ext`}>Quick parsing</label>
          <input
            id={`${p.id}-ext`}
            value={extract}
            onChange={(e) => setExtract(e.target.value)}
            className="rounded-md border border-line bg-field px-2 py-1"
          />
          <span />
          <span className="flex gap-2">
            <button className={small} onClick={() => void save(false)}>
              Save names
            </button>
            <button className={small} onClick={() => void save(true)}>
              Use defaults
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

function ProviderCard({
  p,
  index,
  count,
  canStore,
  onChange
}: {
  p: P
  index: number
  count: number
  canStore: boolean
  onChange: (s: LlmStatus) => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const configure = async (patch: { enabled?: boolean; move?: 'up' | 'down' }): Promise<void> => {
    const r = await window.api.invoke('llm:configure', { provider: p.id, ...patch })
    if (r.ok) onChange(r.data)
  }
  const save = async (value: string): Promise<void> => {
    setBusy(true)
    const r = await window.api.invoke('llm:set-key', { provider: p.id, key: value })
    setBusy(false)
    if (!r.ok) return setMsg({ ok: false, text: r.error.message })
    setKey('')
    setMsg(value ? { ok: true, text: 'Saved. Press Test to check it.' } : null)
    onChange(r.data)
  }
  const test = async (): Promise<void> => {
    setBusy(true)
    setMsg({ ok: true, text: 'Testing…' })
    const r = await window.api.invoke('llm:test', { provider: p.id })
    setBusy(false)
    setMsg(r.ok ? { ok: r.data.ok, text: r.data.message } : { ok: false, text: r.error.message })
    const s = await window.api.invoke('llm:status')
    if (s.ok) onChange(s.data)
  }

  return (
    <li className="rounded-xl border border-line p-3" data-testid={`provider-${p.id}`}>
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => void configure({ enabled: e.target.checked })}
            className="h-4 w-4 accent-[var(--accent)]"
            aria-label={`Use ${p.label}`}
          />
          <span className="truncate">{p.label}</span>
          {p.paid && (
            <span className="rounded-full border border-line px-1.5 text-xs font-normal text-muted">
              paid
            </span>
          )}
        </label>
        <span
          className={`text-xs ${p.state === 'ready' ? 'text-ok' : p.state === 'auth-failed' ? 'text-danger' : 'text-muted'}`}
        >
          {STATE_TEXT[p.state]}
        </span>
        <button
          className={small}
          disabled={index === 0}
          onClick={() => void configure({ move: 'up' })}
          aria-label={`Try ${p.label} earlier`}
          title="Try earlier"
        >
          ↑
        </button>
        <button
          className={small}
          disabled={index === count - 1}
          onClick={() => void configure({ move: 'down' })}
          aria-label={`Try ${p.label} later`}
          title="Try later"
        >
          ↓
        </button>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        {p.blurb}{' '}
        <button
          className="underline"
          onClick={() => void window.api.invoke('app:open-external', { url: p.keyUrl })}
        >
          Get a key
        </button>
      </p>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted">How to get a key</summary>
        <div className="mt-1.5">
          <KeySteps g={KEY_GUIDES.find((g) => g.id === p.id)!} keyUrl={p.keyUrl} />
        </div>
      </details>
      <div className="mt-2 flex gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          disabled={!canStore}
          onChange={(e) => setKey(e.target.value)}
          placeholder={p.hasKey ? 'Saved. Paste a new key to replace it' : 'Paste your API key'}
          aria-label={`${p.label} API key`}
          className="min-w-0 flex-1 rounded-lg border border-line bg-field px-2 py-1 text-sm"
        />
        <button className={btn} disabled={busy || !key.trim()} onClick={() => void save(key)}>
          Save
        </button>
        <button className={btn} disabled={busy || !p.hasKey} onClick={() => void test()}>
          Test
        </button>
        {p.hasKey && (
          <button className={btn} disabled={busy} onClick={() => void save('')}>
            Remove
          </button>
        )}
      </div>
      {msg && <p className={`mt-1 text-xs ${msg.ok ? 'text-muted' : 'text-danger'}`}>{msg.text}</p>}
      {p.lastError && p.state !== 'ready' && p.state !== 'disabled' && (
        <p className="mt-1 text-xs text-muted">Last problem: {p.lastError}</p>
      )}
      {p.hasKey && <Usage p={p} />}
      <Models key={p.models.chat + p.models.extract} p={p} onChange={onChange} />
    </li>
  )
}

const USAGE_LABEL = (f: string): string =>
  f === 'ask'
    ? 'Questions'
    : f === 'capture'
      ? 'Brain-dumps'
      : f === 'names'
        ? 'Name cleanup'
        : f.startsWith('action:')
          ? f.slice(7).replace(/-/g, ' ')
          : 'Other'

export default function AiSettings(): React.JSX.Element {
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [llm, setLlm] = useState<{
    enabled: boolean
    models: Record<string, Record<string, string>>
    disabled: string[]
    order: string[]
    dailyTokenBudget?: number
  } | null>(null)

  const load = useCallback(() => {
    void window.api.invoke('llm:status').then((r) => r.ok && setStatus(r.data))
  }, [])
  useEffect(() => {
    load()
    void window.api.invoke('settings:get').then((r) => r.ok && setLlm(r.data.llm))
    // Usage counts change as you work: refresh while Settings is open.
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  const setBudget = async (n: number): Promise<void> => {
    if (!llm) return
    const next = { ...llm, dailyTokenBudget: Math.max(0, n) }
    setLlm(next)
    await window.api.invoke('settings:update', { llm: next as never })
    load()
  }

  const toggle = async (enabled: boolean): Promise<void> => {
    if (!llm) return
    const next = { ...llm, enabled }
    setLlm(next)
    await window.api.invoke('settings:update', { llm: next })
    load()
  }

  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={llm?.enabled ?? true}
          onChange={(e) => void toggle(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Turn on the Co-Pilot
      </label>
      <p className="mt-1 text-xs text-muted">
        Bring your <strong>own</strong> API key for any of these. The Co-Pilot tries the switched-on
        ones from top to bottom and moves to the next if one is busy or fails. Without any key it
        still searches your notes and parses tasks on this computer.
      </p>
      {status && llm?.enabled !== false && (
        <>
          <h3 className="mt-4 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
            How Much AI to Use
          </h3>
          <AiModeSwitch variant="cards" />
          <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            Daily budget
            <input
              type="number"
              min={0}
              step={10000}
              value={llm?.dailyTokenBudget ?? 60000}
              onChange={(e) => void setBudget(Number(e.target.value) || 0)}
              aria-label="Daily token budget"
              className="w-28 rounded-lg border border-line bg-field px-2 py-1 text-sm"
            />
            tokens
            <span className="text-xs text-muted">
              (0 = no limit). {status.budget.used.toLocaleString()} used today. When it is reached,
              the Co-Pilot works on your computer until tomorrow.
            </span>
          </label>
          {status.usage.length > 0 && (
            <div className="mt-2 text-xs text-muted" data-testid="ai-usage">
              Today:{' '}
              {status.usage
                .map((u) => `${USAGE_LABEL(u.feature)} ${u.tokens.toLocaleString()}`)
                .join(' · ')}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">
            Token counts are rough guides. Each provider card below shows what this app actually
            used today. You can also switch from the Co-Pilot panel at any time.
          </p>
          {!status.canStoreKeys && (
            <p className="mt-2 text-xs text-danger">
              This computer cannot encrypt secrets, so keys cannot be saved.
            </p>
          )}
          <ul className="mt-3 space-y-3">
            {status.providers.map((p, i) => (
              <ProviderCard
                key={p.id}
                p={p}
                index={i}
                count={status.providers.length}
                canStore={status.canStoreKeys}
                onChange={setStatus}
              />
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Keys are encrypted for your Windows account on this computer only and never shown again.
            “Paid” providers bill your own account for every request this app makes; the free ones
            have daily limits.
          </p>
          <p className="mt-1 text-xs text-muted">
            A chat subscription such as Gemini Advanced / Google AI Pro, ChatGPT Plus or Claude Pro
            does not include an API key, so it cannot be used here. Create a key on the provider’s
            developer site instead.
          </p>
        </>
      )}
      <div className="mt-3 rounded-lg border border-line bg-surface p-3 text-xs text-muted">
        <p className="mb-1 font-semibold text-fg">What leaves this computer</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            Only what you type to the Co-Pilot, plus short snippets of your own notes when you ask a
            question, sent to the provider that answers.
          </li>
          <li>
            There are no content filters: what you ask about, and the notes it matches, are sent as
            they are.
          </li>
          <li>Free tiers may use submitted text to improve the provider’s products.</li>
        </ul>
      </div>
    </>
  )
}
