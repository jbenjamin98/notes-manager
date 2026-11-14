import { useEffect, useMemo, useRef, useState } from 'react'
import { parseQuickAdd } from '@shared/quickadd'
import { shortDate } from '../format'

const chip = 'rounded-full bg-accent-soft px-2 py-0.5 text-xs'

/** The tiny global quick-capture window (Ctrl+Shift+Space). Same parser as the Tasks page. */
export default function CaptureWindow(): React.JSX.Element {
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const parsed = useMemo(() => (text.trim() ? parseQuickAdd(text) : null), [text])

  useEffect(() => {
    input.current?.focus()
    return window.api.on('capture:shown', () => {
      setText('')
      setState('idle')
      setError(null)
      input.current?.focus()
    })
  }, [])

  const submit = async (): Promise<void> => {
    if (!parsed?.description || state === 'busy') return
    setState('busy')
    const r = await window.api.invoke('tasks:quick-add', { text })
    if (!r.ok) {
      setState('idle')
      return setError(r.error.message)
    }
    setState('done')
    setTimeout(() => void window.api.invoke('capture:hide'), 700)
  }

  return (
    <div className="flex h-screen flex-col justify-center gap-2 bg-[var(--app)] px-5 text-fg">
      <input
        ref={input}
        value={text}
        disabled={state !== 'idle'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') void window.api.invoke('capture:hide')
        }}
        placeholder="Add a task…  e.g. Send deck to Joe tomorrow @Joe !high"
        aria-label="Quick task"
        className="w-full rounded-xl border border-line bg-field px-4 py-3 text-base shadow-sm outline-none focus:border-[var(--accent)]"
      />
      <div className="flex min-h-6 flex-wrap items-center gap-1.5 text-xs text-muted">
        {state === 'done' ? (
          <span className="text-ok">Added to your inbox ✓</span>
        ) : error ? (
          <span className="text-danger">{error}</span>
        ) : parsed?.description ? (
          <>
            {parsed.owner !== 'Me' && <span className={chip}>@{parsed.owner}</span>}
            {parsed.due && <span className={chip}>Due {shortDate(parsed.due)}</span>}
            {parsed.priority && <span className={chip}>{parsed.priority} priority</span>}
            {parsed.estMinutes && <span className={chip}>{parsed.estMinutes} min</span>}
            <span>Enter to add · Esc to cancel</span>
          </>
        ) : (
          <span>Names and dates in plain words are picked up. Esc to cancel.</span>
        )}
      </div>
    </div>
  )
}
