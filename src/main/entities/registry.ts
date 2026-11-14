import { z } from 'zod'

/**
 * `system/entities.json`: the CURATED registry (canonical names + aliases). It is user-authored
 * config that must survive a lost index and sync across machines. Everything derived (mention
 * counts, auto-discovered people/topics) lives only in SQLite.
 */
export type RegCategory = 'person' | 'customer' | 'system'

const Entry = z.object({
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).default([])
})
export type RegEntry = z.infer<typeof Entry>

const RegistrySchema = z.object({
  version: z.literal(1).default(1),
  me: z.object({ aliases: z.array(z.string().trim().min(1)).default([]) }).default({ aliases: [] }),
  people: z.array(Entry).default([]),
  accounts: z.array(Entry).default([]),
  systems: z.array(Entry).default([])
})
export type Registry = z.infer<typeof RegistrySchema>

export const REGISTRY_REL = 'system/entities.json'

export const emptyRegistry = (): Registry => RegistrySchema.parse({})

const KEY: Record<RegCategory, 'people' | 'accounts' | 'systems'> = {
  person: 'people',
  customer: 'accounts',
  system: 'systems'
}

export const listOf = (reg: Registry, c: RegCategory): RegEntry[] => reg[KEY[c]]

/** Tolerant parse: a hand-edited or half-synced file never crashes the app. */
export function parseRegistry(text: string): Registry {
  try {
    return normalizeRegistry(RegistrySchema.parse(JSON.parse(text)))
  } catch {
    return emptyRegistry()
  }
}

const uniqCI = (xs: string[]): string[] => {
  const seen = new Set<string>()
  return xs.filter((x) => {
    const k = x.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Dedupe, drop aliases equal to the name, sort: stable output keeps Drive diffs/conflicts minimal. */
export function normalizeRegistry(reg: Registry): Registry {
  const clean = (list: RegEntry[]): RegEntry[] => {
    const byName = new Map<string, RegEntry>()
    for (const e of list) {
      const k = e.name.toLowerCase()
      const prev = byName.get(k)
      byName.set(k, {
        name: prev?.name ?? e.name,
        aliases: [...(prev?.aliases ?? []), ...e.aliases]
      })
    }
    return [...byName.values()]
      .map((e) => ({
        name: e.name,
        aliases: uniqCI(e.aliases)
          .filter((a) => a.toLowerCase() !== e.name.toLowerCase())
          .sort((a, b) => a.localeCompare(b))
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
  return {
    version: 1,
    me: { aliases: uniqCI(reg.me.aliases).sort((a, b) => a.localeCompare(b)) },
    people: clean(reg.people),
    accounts: clean(reg.accounts),
    systems: clean(reg.systems)
  }
}

export const serializeRegistry = (reg: Registry): string =>
  JSON.stringify(normalizeRegistry(reg), null, 2) + '\n'

/** Insert or replace one entry (rename via `originalName`). Returns a new registry. */
export function upsertEntry(
  reg: Registry,
  category: RegCategory,
  name: string,
  aliases: string[],
  originalName?: string
): Registry {
  const key = KEY[category]
  const orig = (originalName ?? name).toLowerCase()
  const rest = reg[key].filter(
    (e) => e.name.toLowerCase() !== orig && e.name.toLowerCase() !== name.toLowerCase()
  )
  return normalizeRegistry({ ...reg, [key]: [...rest, { name: name.trim(), aliases }] })
}

export function removeEntry(reg: Registry, category: RegCategory, name: string): Registry {
  const key = KEY[category]
  return normalizeRegistry({
    ...reg,
    [key]: reg[key].filter((e) => e.name.toLowerCase() !== name.toLowerCase())
  })
}

// ---------------------------------------------------------------- matching

export interface MatchEntry {
  category: RegCategory
  name: string
  re: RegExp
}

/** A name we know about that is NOT in the curated registry (discovered people, email senders, first names). */
export interface PoolSeed {
  category: RegCategory
  name: string
  /** Exact-case terms that tag it in text (full name, unambiguous first name...). */
  terms: string[]
  inRegistry: boolean
}

export interface Pool {
  /** One combined, case-sensitive pattern over every term (fast even with thousands of names). */
  re: RegExp
  /** Exact-case terms, as they should appear in text. */
  terms: string[]
  byTerm: Map<string, { category: RegCategory; name: string; inRegistry: boolean }>
}

export interface Matcher {
  /** Names found without "@" in plain text. Null when there is nothing to match. */
  pool: Pool | null
  entries: MatchEntry[]
  /** lowercased name/alias -> canonical entry */
  lookup: Map<string, { category: RegCategory; name: string }>
  /** lowercased names that mean "me" (never become a person) */
  me: Set<string>
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function buildMatcher(reg: Registry, meAliases: string[], seeds: PoolSeed[] = []): Matcher {
  const entries: MatchEntry[] = []
  const lookup = new Map<string, { category: RegCategory; name: string }>()
  for (const category of ['person', 'customer', 'system'] as RegCategory[]) {
    for (const e of listOf(reg, category)) {
      const terms = [e.name, ...e.aliases].sort((a, b) => b.length - a.length)
      for (const t of terms) lookup.set(t.toLowerCase(), { category, name: e.name })
      entries.push({
        category,
        name: e.name,
        // Whole-word, Unicode-aware, case-insensitive.
        re: new RegExp(
          `(?<![\\p{L}\\p{N}_])(?:${terms.map(esc).join('|')})(?![\\p{L}\\p{N}_])`,
          'giu'
        )
      })
    }
  }
  const me = new Set(['me', ...meAliases, ...reg.me.aliases].map((s) => s.toLowerCase()))

  const byTerm = new Map<string, { category: RegCategory; name: string; inRegistry: boolean }>()
  for (const s of seeds) {
    for (const t of s.terms) {
      const k = t.toLowerCase()
      if (!t.trim() || me.has(k) || lookup.has(k) || byTerm.has(k)) continue
      byTerm.set(k, { category: s.category, name: s.name, inRegistry: s.inRegistry })
    }
  }
  const terms = [...byTerm.keys()]
  let pool: Pool | null = null
  if (terms.length > 0) {
    // Exact-case terms (names are Capitalised in prose; this keeps "will"/"mark" out), longest first.
    const exact = new Map<string, string>()
    for (const s of seeds) for (const t of s.terms) if (byTerm.has(t.toLowerCase())) exact.set(t, t)
    const alt = [...exact.keys()]
      .sort((a, b) => b.length - a.length)
      .map(esc)
      .join('|')
    pool = {
      re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`, 'gu'),
      terms: [...exact.keys()],
      byTerm
    }
  }
  return { pool, entries, lookup, me }
}
