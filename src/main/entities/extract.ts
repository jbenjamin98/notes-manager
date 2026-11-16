import type { Matcher, RegCategory } from './registry'

export type EntityCategory = RegCategory | 'topic'

export interface ExtractedEntity {
  category: EntityCategory
  name: string
  /** Mentions in this note (>= 1). */
  count: number
  inRegistry: boolean
}

export interface ExtractInput {
  title: string
  /** Body text WITHOUT frontmatter. */
  body: string
  attendees: string[]
  account: string | null
}

const MENTION = /(?<![\p{L}\p{N}_@])@([\p{L}][\p{L}\p{N}._-]*)/gu
const HASHTAG = /(?<![\p{L}\p{N}_&#])#([\p{L}][\p{L}\p{N}_/-]*)/gu

const trimTail = (s: string): string => s.replace(/[._-]+$/, '')

/**
 * Deterministic, offline extraction. Sources:
 *  1. registry names/aliases, whole-word, anywhere in the note
 *  2. `@mentions` that the registry doesn't know -> discovered people
 *  3. frontmatter `attendees` (people) and `account` (customer)
 *  4. `#tags` -> topics
 * "Me" never becomes a person. A mention that resolves to a registry entry is counted once
 * (by pass 1), never again as an @mention.
 */
export function extractEntities(input: ExtractInput, m: Matcher): ExtractedEntity[] {
  const text = `${input.title}\n${input.body}`
  const out = new Map<string, ExtractedEntity>()
  const add = (category: EntityCategory, name: string, n: number, inRegistry: boolean): void => {
    const key = `${category}:${name.toLowerCase()}`
    const cur = out.get(key)
    if (cur) cur.count += n
    else out.set(key, { category, name, count: n, inRegistry })
  }
  const ensure = (category: EntityCategory, name: string, inRegistry: boolean): void => {
    const key = `${category}:${name.toLowerCase()}`
    if (!out.has(key)) add(category, name, 1, inRegistry)
  }

  for (const e of m.entries) {
    const hits = text.match(e.re)?.length ?? 0
    if (hits > 0) add(e.category, e.name, hits, true)
  }

  // Known names written without "@": discovered people, email senders, unambiguous first names.
  if (m.pool) {
    for (const hit of text.matchAll(m.pool.re)) {
      const e = m.pool.byTerm.get(hit[0].toLowerCase())
      if (e) add(e.category, e.name, 1, e.inRegistry)
    }
  }

  for (const hit of text.matchAll(MENTION)) {
    const token = trimTail(hit[1])
    const k = token.toLowerCase()
    // "@Sarah Chen": a known longer name right after the @ is that entity, not a stray "Sarah".
    const words = text
      .slice((hit.index ?? 0) + 1, (hit.index ?? 0) + 80)
      .split(/\s+/)
      .slice(0, 3)
      .map(trimTail)
    let longer: { category: EntityCategory; name: string; inRegistry: boolean } | null = null
    for (let n = Math.min(3, words.length); n >= 2 && !longer; n--) {
      const key = words.slice(0, n).join(' ').toLowerCase()
      const l = m.lookup.get(key)
      const p = m.pool?.byTerm.get(key)
      if (l) longer = { ...l, inRegistry: true }
      else if (p) longer = p
    }
    if (longer) {
      ensure(longer.category, longer.name, longer.inRegistry)
      continue
    }
    if (!token || m.me.has(k) || m.lookup.has(k)) continue
    // "@Jacob" when two people are called Jacob: tagged, but linked to nobody until it is reviewed.
    if (m.ambiguous.has(k)) continue
    const known = m.pool?.byTerm.get(k)
    if (known) {
      ensure(known.category, known.name, known.inRegistry) // "@sarah" in any case still counts once
      continue
    }
    add('person', token, 1, false)
  }

  for (const raw of input.attendees) {
    const a = raw.trim()
    if (!a) continue
    const k = a.toLowerCase()
    // "Jacob Benjamin" is me if any word of it is one of my names.
    if (m.me.has(k) || k.split(/\s+/).some((w) => m.me.has(w))) continue
    const known = m.lookup.get(k)
    if (known) ensure(known.category, known.name, true)
    else ensure('person', a, false)
  }

  if (input.account?.trim()) {
    const a = input.account.trim()
    const known = m.lookup.get(a.toLowerCase())
    if (known) ensure(known.category, known.name, true)
    else ensure('customer', a, false)
  }

  for (const hit of text.matchAll(HASHTAG)) {
    const tag = trimTail(hit[1]).toLowerCase()
    if (tag) add('topic', tag, 1, false)
  }

  return [...out.values()]
}
