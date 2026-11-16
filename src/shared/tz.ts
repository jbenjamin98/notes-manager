/**
 * Everything time-of-day in the app (work hours, "today", nudge times) follows the time zone in
 * Settings, not the computer's clock, because Google Calendar shows times in the user's own zone.
 * `wallClock` returns a Date whose LOCAL fields equal the wall-clock time in `tz`.
 */
export function wallClock(d: Date, tz?: string): Date {
  if (!tz) return d
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(d)
    const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value)
    return new Date(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  } catch {
    return d // unknown zone name: fall back to the computer's clock
  }
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** Today's date (YYYY-MM-DD) in `tz`. */
export function todayIn(tz?: string, d: Date = new Date()): string {
  const w = wallClock(d, tz)
  return `${w.getFullYear()}-${p2(w.getMonth() + 1)}-${p2(w.getDate())}`
}

/** The reverse of wallClock: the real instant at which the wall clock in `tz` reads `wall`'s local fields. */
export function instantFromWall(wall: Date, tz?: string): Date {
  if (!tz) return wall
  const utc = (d: Date): number =>
    Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds()
    )
  const target = utc(wall)
  let guess = target
  for (let i = 0; i < 3; i++) guess += target - utc(wallClock(new Date(guess), tz))
  return new Date(guess)
}
