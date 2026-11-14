import * as chrono from 'chrono-node'

/**
 * Deterministic "auto-tagging" from plain sentences: no `@`, no `due:` needed. Used when a task
 * line has no explicit owner/due field. Conservative on purpose: every rule is a recognisable
 * phrasing ("Remind Sarah to...", "Joe to review..."), and an explicit field always wins.
 */

export interface PersonInput {
  name: string
  aliases?: string[]
}

export interface PersonIndex {
  /** lowercase term (full name, alias, or unambiguous first name) -> canonical name */
  lookup: Map<string, string>
  /** Terms that are first names only (looser: used for tagging, not for guessing who owns a task alone). */
  firstNames: Set<string>
}

/** First names that are also everyday words: never matched on their own. */
const COMMON_WORDS = new Set(
  (
    'will mark may bill grace hope faith joy april june august dawn rose ray pat sue rich rob art bob dean drew guy jay ' +
    'page chase cliff dale don ed hank harry hunter ivy jordan kit lane lee mac miles pete reed rex sandy sky van wade ' +
    'bear case cash chance christian eric frank gene grant heather holly jean jack jan jerry joan kate kay ken lou ' +
    'mike monty neil nick norm pam penny peter phil ron sage sean sherry stan ted tom tony victor wendy'
  )
    .split(' ')
    // names that are ALSO ordinary words in work notes; real names like Eric/Mike/Tom stay matchable
    .filter(
      (w) =>
        ![
          'eric',
          'mike',
          'tom',
          'tony',
          'peter',
          'sean',
          'neil',
          'phil',
          'ron',
          'victor',
          'wendy',
          'holly',
          'kate',
          'ken',
          'lou',
          'stan',
          'ted',
          'pete',
          'jerry',
          'jean',
          'joan',
          'pam',
          'heather',
          'sherry',
          'sage',
          'gene',
          'grant',
          'christian',
          'frank',
          'jack',
          'jan',
          'kay',
          'nick',
          'norm',
          'penny'
        ].includes(w)
    )
)

export function buildPersonIndex(people: PersonInput[], meNames: Set<string>): PersonIndex {
  const lookup = new Map<string, string>()
  const firstNames = new Set<string>()
  const isMe = (s: string): boolean =>
    meNames.has(s.toLowerCase()) ||
    s
      .toLowerCase()
      .split(/\s+/)
      .some((w) => meNames.has(w))

  const usable = people.filter((p) => p.name.trim() && !isMe(p.name))
  for (const p of usable) {
    lookup.set(p.name.toLowerCase(), p.name)
    for (const a of p.aliases ?? []) if (a.trim() && !isMe(a)) lookup.set(a.toLowerCase(), p.name)
  }
  // First names: only when exactly one person has it and it isn't an everyday word.
  const byFirst = new Map<string, Set<string>>()
  for (const p of usable) {
    const parts = p.name.trim().split(/\s+/)
    if (parts.length < 2) continue
    const f = parts[0].toLowerCase()
    if (f.length < 3 || COMMON_WORDS.has(f) || meNames.has(f)) continue
    byFirst.set(f, (byFirst.get(f) ?? new Set()).add(p.name))
  }
  for (const [f, names] of byFirst) {
    if (names.size === 1 && !lookup.has(f)) {
      lookup.set(f, [...names][0])
      firstNames.add(f)
    }
  }
  return { lookup, firstNames }
}

export interface Mention {
  name: string
  start: number
  end: number
}

const CAP_RUN = /\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*){0,2}/gu

/** Known people named in a sentence, longest match first. Names must be Capitalised in the text. */
export function findMentions(text: string, idx: PersonIndex): Mention[] {
  const out: Mention[] = []
  for (const m of text.matchAll(CAP_RUN)) {
    const words = m[0].split(/(\s+)/) // keep separators so offsets stay exact
    const tokens = words.filter((_, i) => i % 2 === 0)
    let i = 0
    let offset = m.index ?? 0
    while (i < tokens.length) {
      let matched = 0
      for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
        const phrase = tokens
          .slice(i, i + n)
          .join(' ')
          .replace(/[.'-]+$/, '')
        const canon = idx.lookup.get(phrase.toLowerCase())
        if (canon) {
          const startsAt = offset
          const len = tokens.slice(i, i + n).join(' ').length
          out.push({ name: canon, start: startsAt, end: startsAt + len })
          matched = n
          break
        }
      }
      const consumed = matched || 1
      for (let k = 0; k < consumed; k++) {
        offset += tokens[i + k].length + (words[(i + k) * 2 + 1]?.length ?? 0)
      }
      i += consumed
    }
  }
  return out
}

const DELEGATE_VERB = /(?:^|[\s,;:-])(remind|tell|ask|have|get|let|nudge|ping|chase|prompt)\s+$/i
const WAITING = /^\s*(waiting\s+(?:on|for)|pending\s+from|blocked\s+(?:on|by)|awaiting)\s+$/i
const TO_VERB = /^\s+(?:to|will|should|needs?\s+to|must|is\s+going\s+to|can)\s+\p{L}/iu
const TO_ONLY = /^\s+to\s+\p{L}/iu
const SEPARATOR = /[-–—:,;]\s*$/

/**
 * Who should DO this task, judged from the wording, or null when nothing clear says it's someone
 * else (then it stays mine). Never returns "me".
 */
export function inferOwner(description: string, idx: PersonIndex): string | null {
  for (const m of findMentions(description, idx)) {
    const before = description.slice(0, m.start)
    const after = description.slice(m.end)
    // "Remind Sarah to update the firewall" / "Ask Joe to review"
    if (DELEGATE_VERB.test(before) && TO_ONLY.test(after)) return m.name
    // "Waiting on Sarah for the firewall rules" (only at the start of the task)
    if (WAITING.test(before)) return m.name
    // "Sarah to verify the firewall" / "Joe will send the deck" (name opens the task)
    if (before.trim() === '' && TO_VERB.test(after)) return m.name
    // "Update the runbook - Joe to review"
    if (SEPARATOR.test(before) && TO_VERB.test(after)) return m.name
  }
  return null
}

const MARKER_BEFORE = /(?:\b(?:by|on|before|until|due|for|this|next)\s+|\b(?:eod|end of)\s+)$/i
const RELATIVE_START =
  /^(tomorrow|today|tonight|next\b|this\b|in\s+\d|mon|tue|wed|thu|fri|sat|sun)/i

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * A due date named in the sentence ("by Tuesday", "tomorrow", "on Nov 20"), resolved against `ref`
 * (the note's date, so "Tuesday" in a note written Friday means the coming Tuesday). Bare month
 * names and numbers are ignored: "Review May roadmap" has no due date.
 */
export function inferDue(description: string, ref: Date): string | null {
  const refNoon = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 12)
  const hit = chrono
    .parse(description, refNoon, { forwardDate: true })
    .find(
      (r) => r.start.isCertain('day') || r.start.isCertain('weekday') || r.start.isCertain('month')
    )
  if (!hit) return null
  // chrono sometimes includes the preposition in its match ("on Monday"); treat that as a marker.
  const LEAD = /^(by|on|before|until|due|for)\s+/i
  const markerBefore = MARKER_BEFORE.test(description.slice(0, hit.index)) || LEAD.test(hit.text)
  if (!markerBefore && !RELATIVE_START.test(hit.text.replace(LEAD, ''))) return null
  const d = hit.start.date()
  const days = (d.getTime() - refNoon.getTime()) / 86_400_000
  if (days < -1 || days > 120) return null
  return iso(d)
}
