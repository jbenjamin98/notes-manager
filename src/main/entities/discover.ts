import type { Db } from '../db'
import {
  findNewNames,
  TOPIC_STOP,
  type CompiledTagVocab,
  type Suggested
} from '../../shared/autotag'
import { GAZETTEER } from '../../shared/gazetteer'

export interface Discovered {
  text: string
  kind: Suggested['kind']
  /** In how many notes it appears. */
  notes: number
  /** A sentence it appears in. */
  example: string
}

const NAME_RE =
  /(?<![\p{L}\p{N}@#_])\p{Lu}[\p{L}'’-]{2,}(?:\s+\p{Lu}[\p{L}'’-]{2,})?(?![\p{L}\p{N}_])/gu
const WORD_RE = /(?<![\p{L}\p{N}@#_])\p{Ll}[\p{L}-]{5,}(?![\p{L}\p{N}_])/gu
const SENTENCE_START = /(^|[.!?:]\s+|\n\s*(?:[-*#>]+\s+(?:\[.\]\s+)?)?)$/

/** Everyday capitalised words that are not names. */
const COMMON_CAPS = new Set(
  (
    'the this that these those there then they them their with without when where which while what who why how ' +
    'and but for from into onto over under about after before because since until also just still only even very ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august ' +
    'september october november december today tomorrow yesterday note notes action items decisions insights ' +
    'context objective open questions parking lot key follow next steps summary agenda'
  ).split(' ')
)

const sentenceAround = (body: string, at: number, len: number): string => {
  const a = Math.max(0, body.lastIndexOf('\n', at) + 1, at - 70)
  const nl = body.indexOf('\n', at)
  const b = Math.min(nl < 0 ? body.length : nl, at + len + 70)
  return body.slice(a, b).trim()
}

/**
 * Names and topics that keep coming up in your notes but are not tagged yet, found by counting
 * (no model): capitalised words in the middle of sentences that appear in three or more notes,
 * and uncommon words that appear in several. A suggestion is a candidate for you to accept or
 * dismiss, never written into a note by itself.
 */
interface NameStat {
  notes: number
  example: string
  /** What each mention's own wording says it is: with Acme (company or person), in Denver (place). */
  votes: Record<string, number>
}

/** One pass over recent notes: how often each capitalised name and uncommon word appears, and what the wording around each name says it is. */
function scan(
  db: Db,
  known: CompiledTagVocab,
  me: ReadonlySet<string>
): { names: Map<string, NameStat>; words: Map<string, number>; total: number } {
  const rows = db
    .prepare(
      `SELECT body_text AS body FROM notes WHERE type <> 'inbox' ORDER BY date DESC LIMIT 600`
    )
    .all() as unknown as { body: string }[]
  const names = new Map<string, NameStat>()
  const words = new Map<string, number>()
  for (const r of rows) {
    const seenName = new Set<string>()
    const seenWord = new Set<string>()
    for (const m of r.body.matchAll(NAME_RE)) {
      const at = m.index ?? 0
      if (SENTENCE_START.test(r.body.slice(Math.max(0, at - 6), at))) continue
      const first = m[0].split(/\s+/)[0].toLowerCase()
      if (COMMON_CAPS.has(first) || TOPIC_STOP.has(first)) continue
      // "Sarah Chen" counts as itself; a trailing everyday word is not part of the name.
      let text = m[0]
      const parts = text.split(/\s+/)
      if (parts.length > 1 && COMMON_CAPS.has(parts[1].toLowerCase())) text = parts[0]
      const sentence = sentenceAround(r.body, at, text.length)
      const cue =
        GAZETTEER.get(text) ?? findNewNames(sentence, known, me).find((n) => n.text === text)?.kind
      const cur = names.get(text) ?? { notes: 0, example: sentence, votes: {} }
      names.set(text, cur)
      // Every mention votes for the kind its own wording points to.
      if (cue) cur.votes[cue] = (cur.votes[cue] ?? 0) + 1
      if (seenName.has(text)) continue
      seenName.add(text)
      cur.notes++
    }
    for (const m of r.body.matchAll(WORD_RE)) {
      const w = m[0].toLowerCase()
      if (TOPIC_STOP.has(w) || seenWord.has(w)) continue
      seenWord.add(w)
      words.set(w, (words.get(w) ?? 0) + 1)
    }
  }

  return { names, words, total: rows.length }
}

/**
 * What kind each name is, decided by all of its mentions together rather than one line: the kind
 * most of the wording around it points to ("with Acme", "Acme contract", "client Acme"), once at
 * least two mentions agree on it.
 */
export function votedKinds(
  db: Db,
  known: CompiledTagVocab,
  me: ReadonlySet<string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [text, v] of scan(db, known, me).names) {
    const ranked = Object.entries(v.votes).sort((a, b) => b[1] - a[1])
    if (ranked[0] && ranked[0][1] >= 2 && ranked[0][1] > (ranked[1]?.[1] ?? 0))
      out[text.toLowerCase()] = ranked[0][0]
  }
  return out
}

export function discoverTags(
  db: Db,
  known: CompiledTagVocab,
  opts: {
    me: ReadonlySet<string>
    ignore: ReadonlySet<string>
    kinds?: Readonly<Record<string, string>>
  }
): Discovered[] {
  const { names, words, total } = scan(db, known, opts.me)
  const out: Discovered[] = []
  const skip = (text: string): boolean => {
    const k = text.toLowerCase()
    const first = k.split(/\s+/)[0]
    return (
      opts.ignore.has(k) ||
      opts.me.has(k) ||
      opts.me.has(first) ||
      known.byTerm.has(text) ||
      known.byTerm.has(k) ||
      known.byTerm.has(first)
    )
  }
  for (const [text, v] of names) {
    if (v.notes < 3 || skip(text)) continue
    const remembered = opts.kinds?.[text.toLowerCase()]
    const ranked = Object.entries(v.votes).sort((a, b) => b[1] - a[1])
    const kind = (
      ['person', 'customer', 'project', 'system', 'place'].includes(remembered ?? '')
        ? remembered
        : (ranked[0]?.[0] ?? 'person')
    ) as Suggested['kind']
    out.push({ text, kind, notes: v.notes, example: v.example })
  }
  // Uncommon words used in several notes (but not in most of them) are likely topics.
  if (total >= 6) {
    const topics: Discovered[] = []
    for (const [w, n] of words) {
      if (n < 4 || n > total * 0.6 || skip(w)) continue
      topics.push({ text: w, kind: 'topic', notes: n, example: '' })
    }
    topics.sort((a, b) => b.notes - a.notes)
    out.push(...topics.slice(0, 15))
  }
  return out.sort((a, b) => b.notes - a.notes).slice(0, 40)
}
