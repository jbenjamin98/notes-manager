/**
 * Pure parsing of Google Calendar agenda chips. The scraper hands us, for every
 * event chip, its `data-eventid`, its day's `data-datekey` and the chip's text
 * lines; everything else is decided here so it can be tested without a browser.
 */

export interface RawChip {
  id: string
  datekey: number
  lines: string[]
}

export type EventKind = 'meeting' | 'working_location' | 'task' | 'allday'
export type RsvpStatus = 'accepted' | 'declined' | 'tentative' | 'needs_action'

export interface CalEvent {
  id: string
  /** YYYY-MM-DD in the calendar's own timezone. */
  date: string
  /** HH:mm (24h), null for all-day. */
  startTime: string | null
  endTime: string | null
  allDay: boolean
  title: string
  status: RsvpStatus | null
  kind: EventKind
}

/** Google encodes a day as ((year-1970) << 9) | (month << 5) | day, month 1-12. */
export function decodeDatekey(k: number): string | null {
  const day = k & 31
  const month = (k >> 5) & 15
  const year = (k >> 9) + 1970
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const norm = (s: string): string => s.replace(/[\u00a0\u202f\u2009]/g, ' ').trim()

function to24(h: number, m: number, mer: 'am' | 'pm'): number {
  const hh = h % 12
  return (mer === 'pm' ? hh + 12 : hh) * 60 + m
}
const fmt = (mins: number): string =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`

const RANGE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[–—-]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i
const SINGLE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i

/** "9 – 10am", "11:30am – 12pm", "12:45 – 1pm", "8am". Null if the line isn't a time. */
export function parseTimeLine(raw: string): { start: string; end: string } | null {
  const line = norm(raw)
  const r = RANGE.exec(line)
  if (r) {
    const endMer = r[6].toLowerCase() as 'am' | 'pm'
    const end = to24(Number(r[4]), Number(r[5] ?? 0), endMer)
    let start: number
    if (r[3]) {
      start = to24(Number(r[1]), Number(r[2] ?? 0), r[3].toLowerCase() as 'am' | 'pm')
    } else {
      // Start shares the end's am/pm unless that would put it after the end ("11 – 1pm").
      start = to24(Number(r[1]), Number(r[2] ?? 0), endMer)
      if (start > end) start = to24(Number(r[1]), Number(r[2] ?? 0), endMer === 'pm' ? 'am' : 'pm')
    }
    return { start: fmt(start), end: fmt(end) }
  }
  const s = SINGLE.exec(line)
  if (s) {
    const t = fmt(to24(Number(s[1]), Number(s[2] ?? 0), s[3].toLowerCase() as 'am' | 'pm'))
    return { start: t, end: t }
  }
  return null
}

const STATUS_RE = /,\s*(Accepted|Declined|Tentative|Needs action|Maybe|Yes|No)\s*$/i

function parseStatus(line: string): RsvpStatus | null {
  const m = STATUS_RE.exec(norm(line))
  if (!m) return null
  const s = m[1].toLowerCase()
  if (s === 'accepted' || s === 'yes') return 'accepted'
  if (s === 'declined' || s === 'no') return 'declined'
  if (s === 'tentative' || s === 'maybe') return 'tentative'
  return 'needs_action'
}

const LOCATION_TITLE = /^(office|home|remote|wfh|working (from|location)|out of office)/i

/** Chip text lines -> event. Returns null when the chip can't be understood. */
export function parseChip(chip: RawChip): CalEvent | null {
  const date = decodeDatekey(chip.datekey)
  const lines = chip.lines.map(norm).filter(Boolean)
  if (!date || !chip.id || lines.length < 2) return null

  const allDay = /^all day$/i.test(lines[0])
  const time = allDay ? null : parseTimeLine(lines[0])
  if (!allDay && !time) return null

  const last = lines[lines.length - 1]
  const status = lines.length >= 3 ? parseStatus(last) : null
  const title = lines[1]

  let kind: EventKind = 'meeting'
  if (/^Calendar:\s*Tasks/i.test(last)) kind = 'task'
  else if (allDay) kind = LOCATION_TITLE.test(title) ? 'working_location' : 'allday'

  return {
    id: chip.id,
    date,
    startTime: time?.start ?? null,
    endTime: time?.end ?? null,
    allDay,
    title,
    status,
    kind
  }
}

/** Parse all chips, dropping unparseable ones and de-duplicating (Calendar renders each event twice). */
export function parseChips(chips: RawChip[]): CalEvent[] {
  const seen = new Set<string>()
  const out: CalEvent[] = []
  for (const c of chips) {
    const key = `${c.id}|${c.datekey}`
    if (seen.has(key)) continue
    seen.add(key)
    const e = parseChip(c)
    if (e) out.push(e)
  }
  return out
}

/**
 * The calendar owner's display name, learned from the RSVP line every chip ends with
 * ("Jacob Benjamin, Accepted"). Needs a few sightings so a stray organizer can't win.
 */
export function ownerNameFromChips(chips: RawChip[]): string | null {
  const counts = new Map<string, number>()
  for (const c of chips) {
    const lines = c.lines.map(norm).filter(Boolean)
    if (lines.length < 3) continue
    const m = /^(.+?),\s*(Accepted|Declined|Tentative|Needs action|Maybe|Yes|No)\s*$/i.exec(
      lines[lines.length - 1]
    )
    const name = m?.[1].trim()
    if (!name || /^calendar:/i.test(name) || name.split(/\s+/).length > 4) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return top && top[1] >= 3 ? top[0] : null
}
