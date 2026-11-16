/** The "working on it" state: a wave of dots and a shimmering placeholder where the answer will be. */
export default function Thinking({ label }: { label?: string }): React.JSX.Element {
  return (
    <div className="msg-in space-y-2" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        {label ?? 'Thinking'}
      </div>
      <div className="space-y-1.5" aria-hidden>
        <div className="shimmer h-3 w-11/12 rounded" />
        <div className="shimmer h-3 w-4/5 rounded" />
        <div className="shimmer h-3 w-2/3 rounded" />
      </div>
    </div>
  )
}
