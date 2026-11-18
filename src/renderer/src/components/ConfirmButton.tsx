import { useEffect, useState } from 'react'

/**
 * A destructive button that needs two clicks: the first arms it ("Click again to delete"), the
 * second does it. It disarms when focus leaves, after a few seconds, or on Esc, so one stray click
 * never deletes anything. One implementation for every delete/remove/clear in the app.
 */
export default function ConfirmButton({
  label,
  confirmLabel = 'Click again to delete',
  onConfirm,
  className = '',
  armedClassName = 'bg-danger/15 font-medium text-danger',
  title,
  testId,
  disabled
}: {
  label: string
  confirmLabel?: string
  onConfirm: () => void
  /** Look while idle. */
  className?: string
  /** Look while armed (added to `className`). */
  armedClassName?: string
  title?: string
  testId?: string
  disabled?: boolean
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 6000)
    return () => clearTimeout(t)
  }, [armed])

  return (
    <button
      type="button"
      data-testid={testId}
      data-armed={armed}
      title={title}
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true)
        setArmed(false)
        onConfirm()
      }}
      onBlur={() => setArmed(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation()
          setArmed(false)
        }
      }}
      className={`${className} ${armed ? armedClassName : ''}`}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}
