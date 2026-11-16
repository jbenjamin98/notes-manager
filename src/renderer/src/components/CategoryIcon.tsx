/**
 * One icon family for every kind of thing in the app (people, companies, projects, topics...):
 * a soft gradient tile with a two-tone glyph, drawn here so it matches the theme in light and dark.
 */
export type CategoryKind =
  | 'person'
  | 'customer'
  | 'project'
  | 'system'
  | 'place'
  | 'topic'
  | 'weeks'
  | 'meetings'
  | 'tasks'
  | 'wordmap'
  | 'calendar'
  | 'inbox'
  | 'waiting'
  | 'review'

/** Gradient per kind: distinct hues, all readable with a white glyph. */
const TINT: Record<CategoryKind, [string, string]> = {
  person: ['#7c6cf6', '#b06cf0'],
  customer: ['#3b82f6', '#22b8cf'],
  project: ['#f97362', '#f4a03c'],
  system: ['#3f8f9e', '#2bb5a0'],
  place: ['#e85d9a', '#f08a6c'],
  topic: ['#8b8fa8', '#6f7590'],
  weeks: ['#5b6cf0', '#3fa2f5'],
  meetings: ['#9a6cf0', '#e266c9'],
  tasks: ['#21a67a', '#5cc96b'],
  wordmap: ['#6a63f0', '#e2668f'],
  calendar: ['#4b7bf0', '#7a5cf0'],
  inbox: ['#f08a3c', '#ef5a7a'],
  waiting: ['#d9a12a', '#ef7f3c'],
  review: ['#e0a52a', '#7c6cf6']
}

/** Each glyph: a soft filled shape (the second tone) plus a crisp outline. 24x24. */
function Glyph({ kind }: { kind: CategoryKind }): React.JSX.Element {
  const soft = { fill: 'currentColor', opacity: 0.35 }
  const line = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (kind) {
    case 'person':
      return (
        <>
          <path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5Z" {...soft} />
          <circle cx="12" cy="8" r="3.6" {...line} />
          <path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5" {...line} />
        </>
      )
    case 'customer':
      return (
        <>
          <rect x="5" y="4" width="10" height="16" rx="1.5" {...soft} />
          <path
            d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5V20M15 10h3.5a1.5 1.5 0 0 1 1.5 1.5V20M3.5 20h17M8.5 8h3M8.5 11.5h3M8.5 15h3"
            {...line}
          />
        </>
      )
    case 'project':
      return (
        <>
          <path d="M6 4v16M6 5h11l-2.5 4L17 13H6" {...soft} />
          <path d="M6 21V4M6 5h11l-2.5 4L17 13H6" {...line} />
        </>
      )
    case 'system':
      return (
        <>
          <rect x="3.5" y="4.5" width="17" height="11" rx="2" {...soft} />
          <rect x="3.5" y="4.5" width="17" height="11" rx="2" {...line} />
          <path d="M9 19.5h6M12 15.5v4M7.5 9l2 1.5-2 1.5M12 12h3" {...line} />
        </>
      )
    case 'place':
      return (
        <>
          <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" {...soft} />
          <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" {...line} />
          <circle cx="12" cy="10" r="2.3" {...line} />
        </>
      )
    case 'topic':
      return (
        <>
          <path d="M3.5 12.2V5a1.5 1.5 0 0 1 1.5-1.5h7.2l8.3 8.3-8.7 8.7Z" {...soft} />
          <path d="M3.5 12.2V5a1.5 1.5 0 0 1 1.5-1.5h7.2l8.3 8.3-8.7 8.7Z" {...line} />
          <circle cx="8" cy="8" r="1.4" {...line} />
        </>
      )
    case 'weeks':
    case 'calendar':
      return (
        <>
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" {...soft} />
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" {...line} />
          <path d="M3.5 9.5h17M8 3v4M16 3v4" {...line} />
          {kind === 'weeks' ? (
            <path d="M7 13.5h10M7 16.5h6" {...line} />
          ) : (
            <circle cx="12" cy="14.5" r="1.6" fill="currentColor" />
          )}
        </>
      )
    case 'meetings':
      return (
        <>
          <path d="M3 18c0-2.8 2.2-4.6 5-4.6s5 1.8 5 4.6Z" {...soft} />
          <circle cx="8" cy="8.5" r="2.8" {...line} />
          <path d="M3 18c0-2.8 2.2-4.6 5-4.6s5 1.8 5 4.6" {...line} />
          <circle cx="16.5" cy="9" r="2.3" {...line} />
          <path d="M14.5 13.6c3.6-.6 6.5 1.2 6.5 4.4" {...line} />
        </>
      )
    case 'tasks':
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="4" {...soft} />
          <rect x="4" y="4" width="16" height="16" rx="4" {...line} />
          <path d="m8.3 12.2 2.6 2.6 5-5.4" {...line} />
        </>
      )
    case 'wordmap':
      return (
        <>
          <circle cx="12" cy="12" r="3.2" {...soft} />
          <path d="M12 12 6 6.5M12 12l6.5-4M12 12l-5 6M12 12l6.5 5.5" {...line} />
          <circle cx="12" cy="12" r="3.2" {...line} />
          <circle cx="5.5" cy="6" r="1.8" {...line} />
          <circle cx="19" cy="7.5" r="1.8" {...line} />
          <circle cx="6.5" cy="18.5" r="1.8" {...line} />
          <circle cx="19" cy="18" r="1.8" {...line} />
        </>
      )
    case 'inbox':
      return (
        <>
          <path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" {...soft} />
          <path
            d="M3.5 13.5 6 5.5A1.5 1.5 0 0 1 7.4 4.5h9.2A1.5 1.5 0 0 1 18 5.5l2.5 8V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"
            {...line}
          />
          <path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5" {...line} />
        </>
      )
    case 'waiting':
      return (
        <>
          <path d="M7 4h10c0 4-5 5.5-5 8 0-2.5-5-4-5-8Z" {...soft} />
          <path
            d="M6.5 3.5h11M6.5 20.5h11M7 3.5c0 5 5 6 5 8.5s-5 3.5-5 8.5M17 3.5c0 5-5 6-5 8.5s5 3.5 5 8.5"
            {...line}
          />
        </>
      )
    case 'review':
      return (
        <>
          <circle cx="9" cy="9" r="3" {...soft} />
          <circle cx="9" cy="9" r="3" {...line} />
          <path d="M3.5 19c0-3 2.4-5 5.5-5 1.4 0 2.6.4 3.6 1.1" {...line} />
          <path d="m14.5 17.5 2 2 4-4.5" {...line} />
        </>
      )
  }
}

export default function CategoryIcon({
  kind,
  size = 40,
  className = ''
}: {
  kind: CategoryKind
  size?: number
  className?: string
}): React.JSX.Element {
  const [a, b] = TINT[kind]
  return (
    <span
      aria-hidden
      className={`cat-icon inline-flex shrink-0 items-center justify-center text-white ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.32,
        background: `linear-gradient(135deg, ${a}, ${b})`,
        boxShadow: `0 ${size * 0.12}px ${size * 0.35}px -${size * 0.12}px ${b}99, inset 0 1px 0 rgba(255,255,255,0.35)`
      }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.56} height={size * 0.56}>
        <Glyph kind={kind} />
      </svg>
    </span>
  )
}
