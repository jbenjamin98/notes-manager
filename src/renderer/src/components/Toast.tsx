import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToastData {
  id: number
  msg: string
  undo?: () => void
}

const ERROR_WORDS =
  /\b(couldn.?t|can.?t|cannot|could not|failed|failure|error|went wrong|unable|not found|denied|invalid|expired)\b/i

/**
 * One message at a time, at the bottom centre. It pauses while the pointer or keyboard focus is on
 * it (so Undo can be reached), clears its own timer, and is announced to screen readers through a
 * live region that is always on the page. Errors read differently from confirmations.
 */
export default function Toast({
  toast,
  onDismiss
}: {
  toast: ToastData | null
  onDismiss: () => void
}): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ms = toast ? (toast.undo ? 8000 : 5000) : 0

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])

  useEffect(() => {
    clear()
    if (!toast || paused) return
    timer.current = setTimeout(onDismiss, ms)
    return clear
  }, [toast, paused, ms, onDismiss, clear])

  const error = !!toast && ERROR_WORDS.test(toast.msg)
  return (
    <div
      className="pointer-events-none fixed bottom-4 left-1/2 z-[60] -translate-x-1/2"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}>
        {toast && (
          <div
            key={toast.id}
            className={`toast-in pointer-events-auto flex max-w-[90vw] items-center gap-3 rounded-lg px-4 py-2 text-sm shadow-lg ${
              error ? 'bg-danger text-[var(--app)]' : 'bg-fg text-[var(--app)]'
            }`}
          >
            <span className="min-w-0">{toast.msg}</span>
            {toast.undo && (
              <button
                className="shrink-0 font-semibold underline underline-offset-2"
                onClick={() => {
                  toast.undo?.()
                  onDismiss()
                }}
              >
                Undo
              </button>
            )}
            <button
              aria-label="Dismiss"
              className="shrink-0 rounded px-1 opacity-70 hover:opacity-100"
              onClick={onDismiss}
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
