import { useRef } from 'react'
import { useFocusTrap } from '../useFocusTrap'

/**
 * The one dialog shell: a dimmed backdrop, a glass panel, the dialog role and name, focus kept
 * inside, Esc to close, and a click outside to close. Every pop-up uses this so they look, stack
 * and behave the same. `className` sets the panel's size and padding.
 */
export default function Modal({
  label,
  onClose,
  align = 'center',
  className = '',
  style,
  children
}: {
  /** The dialog's accessible name. */
  label: string
  onClose: () => void
  align?: 'center' | 'top'
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel, onClose)
  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-black/35 p-4 ${
        align === 'top' ? 'items-start pt-[10vh]' : 'items-center'
      }`}
      onMouseDown={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`glass spring-in max-w-full rounded-3xl ${className}`}
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
