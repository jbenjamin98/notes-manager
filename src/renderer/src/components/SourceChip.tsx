import { openInsightSource } from '../openSource'

/**
 * "↗ Chat · Priya · Nov 14": where an insight or a task came from. Click to open the original
 * (the meeting note, the email, the chat).
 */
export default function SourceChip({
  id,
  label,
  onOpenNote,
  className = ''
}: {
  id: string
  label: string
  onOpenNote?: (path: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        void openInsightSource(id, onOpenNote)
      }}
      title="Open where this came from"
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border border-line bg-field/70 px-2 py-0.5 text-xs text-muted transition hover:border-[var(--accent)] hover:text-fg ${className}`}
    >
      <span aria-hidden>↗</span>
      <span className="truncate">{label}</span>
    </button>
  )
}
