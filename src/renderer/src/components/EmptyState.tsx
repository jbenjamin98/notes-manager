/**
 * One look for "nothing here yet", "not connected" and "something went wrong": what happened, what
 * to do next, and a button that does it.
 */
import { SparkleIcon } from './Icons'

const SPARKLE = '✨'

export default function EmptyState({
  icon = SPARKLE,
  title,
  body,
  action,
  secondary,
  tone = 'neutral',
  className = ''
}: {
  icon?: string
  title: string
  body?: string
  action?: { label: string; onClick: () => void }
  secondary?: { label: string; onClick: () => void }
  tone?: 'neutral' | 'error'
  className?: string
}): React.JSX.Element {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mx-auto flex max-w-md flex-col items-center gap-2 rounded-2xl border border-line bg-surface px-6 py-6 text-center ${className}`}
    >
      <span aria-hidden className="text-2xl">
        {icon === SPARKLE ? <SparkleIcon width={28} height={28} /> : icon}
      </span>
      <h2 className={`text-sm font-semibold ${tone === 'error' ? 'text-danger' : ''}`}>{title}</h2>
      {body && <p className="text-xs leading-relaxed text-muted">{body}</p>}
      {(action || secondary) && (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          {action && (
            <button
              onClick={action.onClick}
              className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              {action.label}
            </button>
          )}
          {secondary && (
            <button
              onClick={secondary.onClick}
              className="rounded-full border border-line bg-field px-4 py-1.5 text-xs font-medium hover:bg-hover"
            >
              {secondary.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
