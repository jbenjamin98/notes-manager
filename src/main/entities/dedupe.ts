import type { Registry } from './registry'
import { isNotSame } from './registry'

/**
 * Finds names that probably mean the same thing ("Joe C", "Joe Cardone", "Joe"; "NextMRO" and
 * "Navy NextMRO"). Deterministic and conservative: it only SUGGESTS, and never joins names the user
 * has marked as different. A bare first name is flagged as "maybe", because it may be a different Joe.
 */
export interface DedupeEntity {
  category: string
  name: string
  aliases: string[]
  notes: number
}

export interface DupeSuggestion {
  category: string
  /** Suggested canonical name first. */
  names: string[]
  reason: string
  /** 0..1, how sure the rules are. */
  score: number
  /** True when one name is only a first name: could be a different person. */
  ambiguous: boolean
}

const clean = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const CORP = new Set([
  'inc',
  'llc',
  'ltd',
  'corp',
  'corporation',
  'company',
  'co',
  'the',
  'group',
  'team',
  'project'
])
const tokens = (s: string): string[] =>
  clean(s)
    .split(' ')
    .filter((t) => t && !CORP.has(t))

function personScore(
  a: string,
  b: string
): { score: number; reason: string; ambiguous: boolean } | null {
  const A = tokens(a)
  const B = tokens(b)
  if (A.length === 0 || B.length === 0) return null
  if (A.join(' ') === B.join(' '))
    return { score: 1, reason: 'Same name, different spelling', ambiguous: false }
  const [short, long] = A.length <= B.length ? [A, B] : [B, A]
  if (short[0] !== long[0] && !(short[0].length === 1 && long[0].startsWith(short[0]))) {
    // Different first names: only "Jon" / "Jonathan" style prefixes.
    if (!(short[0].length >= 3 && long[0].startsWith(short[0]))) return null
  }
  if (short.length === 1)
    return {
      score: 0.55,
      reason: `"${a.length <= b.length ? a : b}" could be the same person, or another one with that first name`,
      ambiguous: true
    }
  // First name matches and the last name is an initial or the same word.
  const [sl, ll] = [short[short.length - 1], long[long.length - 1]].sort(
    (p, q) => p.length - q.length
  )
  if (sl === ll) return { score: 0.9, reason: 'Same first and last name', ambiguous: false }
  if (sl.length === 1 && ll.startsWith(sl))
    return {
      score: 0.8,
      reason: 'Matches once the last name is shortened to an initial',
      ambiguous: false
    }
  return null
}

function thingScore(
  a: string,
  b: string
): { score: number; reason: string; ambiguous: boolean } | null {
  const A = tokens(a)
  const B = tokens(b)
  if (A.length === 0 || B.length === 0) return null
  if (A.join(' ') === B.join(' '))
    return { score: 1, reason: 'Same name, different spelling', ambiguous: false }
  const [short, long] = A.length <= B.length ? [A, B] : [B, A]
  if (short.every((t) => long.includes(t)) && short.join('').length >= 4)
    return { score: 0.7, reason: 'One name contains the other', ambiguous: false }
  const squash = (x: string[]): string => x.join('')
  if (squash(A) === squash(B))
    return { score: 0.95, reason: 'Same letters, different spacing', ambiguous: false }
  return null
}

export function suggestDuplicates(entities: DedupeEntity[], reg: Registry): DupeSuggestion[] {
  const out: DupeSuggestion[] = []
  const byCat = new Map<string, DedupeEntity[]>()
  for (const e of entities) byCat.set(e.category, [...(byCat.get(e.category) ?? []), e])
  for (const [category, list] of byCat) {
    if (category === 'topic' || category === 'event') continue
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i]
        const y = list[j]
        if (isNotSame(reg, x.name, y.name)) continue
        const terms = (e: DedupeEntity): string[] => [e.name, ...e.aliases]
        // An alias already points at the other entry: that is a conflict worth merging.
        const aliasHit =
          terms(x).some((t) => clean(t) === clean(y.name)) ||
          terms(y).some((t) => clean(t) === clean(x.name))
        let best = aliasHit
          ? {
              score: 0.95,
              reason: 'One is already listed as a nickname of the other',
              ambiguous: false
            }
          : null
        for (const a of terms(x))
          for (const b of terms(y)) {
            const r = category === 'person' ? personScore(a, b) : thingScore(a, b)
            if (r && (!best || r.score > best.score)) best = r
          }
        if (!best) continue
        const [main, other] =
          x.notes >= y.notes && x.name.length >= y.name.length
            ? [x, y]
            : x.name.length > y.name.length
              ? [x, y]
              : [y, x]
        out.push({ category, names: [main.name, other.name], ...best })
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 40)
}
