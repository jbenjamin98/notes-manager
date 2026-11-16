import { AI_MODES, AI_PROFILES, type AiMode } from '@shared/aiProfile'
import { useAiMode } from '../aiMode'

const ICON: Record<AiMode, string> = { light: '🍃', normal: '⚖️', heavy: '🔥' }

/**
 * Light / Normal / Heavy. `compact` is the little pill in the Co-Pilot header; `cards` is the
 * explained version in Settings.
 */
export default function AiModeSwitch({
  variant
}: {
  variant: 'compact' | 'cards'
}): React.JSX.Element {
  const [mode, setMode] = useAiMode()
  const idx = AI_MODES.indexOf(mode)

  if (variant === 'compact') {
    return (
      <div
        role="radiogroup"
        aria-label="AI usage"
        className="relative grid grid-cols-3 rounded-full border border-line bg-surface p-0.5 text-xs"
      >
        <span
          aria-hidden
          className="lib-pill absolute top-0.5 bottom-0.5 left-0.5 rounded-full bg-field shadow-sm"
          style={{ width: 'calc((100% - 0.25rem) / 3)', transform: `translateX(${idx * 100}%)` }}
        />
        {AI_MODES.map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={m === mode}
            title={`${AI_PROFILES[m].label}: ${AI_PROFILES[m].summary} (${AI_PROFILES[m].estimate})`}
            onClick={() => void setMode(m)}
            className={`relative z-[1] rounded-full px-2 py-0.5 ${m === mode ? 'text-fg' : 'text-muted hover:text-fg'}`}
          >
            {AI_PROFILES[m].label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div role="radiogroup" aria-label="AI usage" className="grid gap-2 sm:grid-cols-3">
      {AI_MODES.map((m) => {
        const p = AI_PROFILES[m]
        const on = m === mode
        return (
          <button
            key={m}
            role="radio"
            aria-checked={on}
            onClick={() => void setMode(m)}
            className={`rounded-xl border p-3 text-left transition-all ${
              on
                ? 'border-[var(--accent)] bg-accent-soft shadow-sm'
                : 'border-line bg-surface hover:bg-hover'
            }`}
          >
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <span aria-hidden>{ICON[m]}</span>
              {p.label}
              {on && <span className="ml-auto text-xs font-normal text-accent">in use</span>}
            </div>
            <p className="mt-1 text-xs text-muted">{p.summary}</p>
            <p className="mt-1.5 text-xs text-muted">{p.estimate}</p>
          </button>
        )
      })}
    </div>
  )
}
