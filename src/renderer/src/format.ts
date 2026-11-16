import { todayIn, wallClock } from '@shared/tz'

/** The zone from Settings; "today" and the clock follow it, not the computer. */
let zone: string | undefined
export const setAppTimezone = (z?: string): void => {
  zone = z
}
export const wall = (d: Date = new Date()): Date => wallClock(d, zone)
const localIso = (d: Date): string => d.toLocaleDateString('en-CA')

/** Today (or the given instant's date) in the Settings time zone. */
export const todayIso = (d = new Date()): string => todayIn(zone, d)

const parse = (iso: string): Date => new Date(`${iso}T12:00:00`)

export function addDays(iso: string, n: number): string {
  const d = parse(iso)
  d.setDate(d.getDate() + n)
  return localIso(d)
}

/** "9:30 AM" from "09:30". */
export function fmtTime(hhmm: string | null): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, '0')} ${ap}`
}

/** "Today", "Tomorrow", otherwise "Mon, Nov 16". */
export function dayLabel(iso: string, now = new Date()): string {
  const t = todayIso(now)
  if (iso === t) return 'Today'
  if (iso === addDays(t, 1)) return 'Tomorrow'
  if (iso === addDays(t, -1)) return 'Yesterday'
  return parse(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

export function shortDate(iso: string): string {
  return parse(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Bucket for the notes list. */
export function noteBucket(iso: string, now = new Date()): string {
  const t = todayIso(now)
  if (iso >= t) return 'Today'
  if (iso === addDays(t, -1)) return 'Yesterday'
  if (iso >= addDays(t, -7)) return 'Previous 7 days'
  if (iso >= addDays(t, -30)) return 'Previous 30 days'
  return parse(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

/** "3h ago", "2 days ago" from a naive local ISO timestamp (Gmail times). */
export function ageLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}
