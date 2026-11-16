import { useId, type SVGProps } from 'react'

const base = (p: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> => ({
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  ...p
})

export const HomeIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...p}
  >
    <path d="M3.5 11 12 4l8.5 7" />
    <path d="M5.5 9.8V20h13V9.8" />
    <path d="M10 20v-5.5h4V20" />
  </svg>
)
export const PlusIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
export const RefreshIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 4v5h-5" />
  </svg>
)
export const GearIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
)
export const ChevronIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)
export const CalendarIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M16 3v4M8 3v4M3 11h18" />
  </svg>
)
export const NoteIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6M8 13h8M8 17h5" />
  </svg>
)
export const ArrowLeftIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
)
export const CheckCircleIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.5 2.5 2.5 4.5-5" />
  </svg>
)
export const GraphIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <circle cx="9" cy="18" r="2.5" />
    <path d="m8.2 7 7.6.7M7 8.3l1.3 7.2M16.6 10l-6 6.4" />
  </svg>
)

export const BellIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg {...base(p)}>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
)

/**
 * The AI sparkle: the same four-pointed star as the app icon, filled with a gradient that follows
 * the theme (soft gold on dark, warm amber to coral on light) so it stays visible on both.
 */
export const SparkleIcon = (p: SVGProps<SVGSVGElement>): React.JSX.Element => {
  const id = useId().replace(/:/g, '')
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden {...p}>
      <defs>
        <linearGradient id={`sp${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--spark-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--spark-b)' }} />
        </linearGradient>
      </defs>
      <g fill={`url(#sp${id})`}>
        <path d="M10 2.5Q10 11 18.5 11Q10 11 10 19.5Q10 11 1.5 11Q10 11 10 2.5Z" />
        <path d="M19.2 1.6Q19.2 5.2 22.8 5.2Q19.2 5.2 19.2 8.8Q19.2 5.2 15.6 5.2Q19.2 5.2 19.2 1.6Z" />
        <path d="M18.4 15.2Q18.4 18 21.2 18Q18.4 18 18.4 20.8Q18.4 18 15.6 18Q18.4 18 18.4 15.2Z" />
      </g>
    </svg>
  )
}
