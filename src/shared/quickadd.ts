import * as chrono from 'chrono-node'

/**
 * Deterministic quick-add parsing (no LLM). Shared by the renderer (live preview
 * chips while typing) and the main process (authoritative parse on submit).
 *
 *   "Send deck to Joe tomorrow @Joe !high ~30m"
 *   -> { description: "Send deck to Joe", owner: "Joe", due: <tomorrow>, priority: "High", estMinutes: 30 }
 */
export interface QuickTask {
  description: string
  owner: string
  due: string | null
  priority: 'High' | 'Medium' | 'Low' | null
  estMinutes: number | null
  /** The user typed an @owner. When false and the owner is "Me", nothing is written so the wording can decide. */
  ownerExplicit?: boolean
}

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const PRIORITY: Record<string, 'High' | 'Medium' | 'Low'> = {
  high: 'High',
  h: 'High',
  medium: 'Medium',
  med: 'Medium',
  m: 'Medium',
  low: 'Low',
  l: 'Low'
}

export function parseQuickAdd(input: string, now: Date = new Date()): QuickTask {
  let text = ` ${input} `
  let owner = 'Me'
  let ownerExplicit = false
  let priority: QuickTask['priority'] = null
  let estMinutes: number | null = null
  let due: string | null = null

  const take = (re: RegExp, fn: (m: RegExpExecArray) => void): void => {
    const m = re.exec(text)
    if (m) {
      fn(m)
      text = text.replace(m[0], ' ')
    }
  }

  take(/\s@([\w.-]+)(?=\s)/, (m) => {
    owner = m[1]
    ownerExplicit = true
  })
  take(/\s!(high|medium|med|low|h|m|l)(?=\s)/i, (m) => (priority = PRIORITY[m[1].toLowerCase()]))
  take(/\s~(?:(\d+)h)?(?:(\d+)m)?(?=\s)/i, (m) => {
    const mins = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)
    if (mins > 0) estMinutes = mins
  })
  take(/\sdue:(\d{4}-\d{2}-\d{2})(?=\s)/i, (m) => (due = m[1]))

  if (!due) {
    // Only trust results that name a day ("tomorrow", "Tuesday", "Nov 20"), not bare times or numbers.
    const hit = chrono
      .parse(text, now, { forwardDate: true })
      .find(
        (r) =>
          r.start.isCertain('day') || r.start.isCertain('weekday') || r.start.isCertain('month')
      )
    if (hit) {
      due = iso(hit.start.date())
      text = text.slice(0, hit.index) + ' ' + text.slice(hit.index + hit.text.length)
    }
  }

  const description = text
    .replace(/\s+(by|on|due|before|until|for)\s*$/i, ' ') // dangling "by" left behind by the date
    .replace(/\|/g, '/') // pipes would break the inline task syntax
    .replace(/\s+/g, ' ')
    .trim()

  return { description, owner, due, priority, estMinutes, ownerExplicit }
}

const fmtEst = (m: number): string =>
  `${m >= 60 ? `${Math.floor(m / 60)}h` : ''}${m % 60 ? `${m % 60}m` : ''}`

/** The inline task line (without the ^id, which the indexer assigns). */
export function formatTaskLine(t: QuickTask): string {
  const parts = [`- [ ] ${t.description}`]
  if (t.ownerExplicit || t.owner !== 'Me') parts.push(`@${t.owner}`)
  if (t.due) parts.push(`due:${t.due}`)
  if (t.priority) parts.push(`priority:${t.priority}`)
  if (t.estMinutes) parts.push(`est:${fmtEst(t.estMinutes)}`)
  return parts.join(' | ')
}
