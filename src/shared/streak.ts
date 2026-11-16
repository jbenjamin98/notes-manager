const p2 = (n: number): string => String(n).padStart(2, '0')
const iso = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const back = (day: string, n: number): string => {
  const [y, m, d] = day.split('-').map(Number)
  return iso(new Date(y, m - 1, d - n))
}

/**
 * Consecutive days with at least one of MY tasks finished, counting back from today (or from
 * yesterday if nothing is finished yet today, so the streak survives until the day is over).
 */
export function streakOf(
  tasks: { status: string; completedAt: string | null; isMine: boolean }[],
  today: string
): number {
  const days = new Set(
    tasks
      .filter((t) => t.status === 'completed' && t.completedAt && t.isMine)
      .map((t) => iso(new Date(t.completedAt!)))
  )
  let d = days.has(today) ? today : back(today, 1)
  let n = 0
  while (days.has(d)) {
    n++
    d = back(d, 1)
  }
  return n
}
