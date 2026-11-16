import type { Db } from '../db'
import type { RegCategory, Registry } from './registry'
import { listOf } from './registry'
import { parseFrontmatter, splitLines } from '../vault/parse'
import { readMentions } from '../vault/edit'

/**
 * Review Names: when "Jacob" could be Jacob Anderson or Jacob Brooks, the app does not guess. It
 * lists every note that says just "Jacob" with the sentence around it, and you assign each one
 * (or all like it) to a person, or to someone new. The answer is stored in the note itself
 * (frontmatter `mentions`), so it syncs and survives a rebuild.
 */
export interface ReviewCandidate {
  name: string
  notes: number
  /** person, customer, project, system or place. */
  category: string
}

export interface ReviewMention {
  path: string
  title: string
  date: string
  /** The sentence (or so) around the first unresolved mention. */
  snippet: string
  count: number
}

export interface ReviewGroup {
  short: string
  candidates: ReviewCandidate[]
  mentions: ReviewMention[]
}

/** First words of company, system and place names that many names start with. */
const GENERIC_FIRST = new Set(
  (
    'the new old north south east west central first global united national general american international ' +
    'royal grand great big little data digital cloud tech smart open home city bank'
  ).split(' ')
)

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Short names that could mean more than one person: shared first names and names marked ambiguous. */
export function ambiguousNames(
  db: Db,
  reg: Registry
): Map<string, { name: string; notes: number; category: string }[]> {
  type Cand = { name: string; notes: number; category: string }
  const rows = db
    .prepare(
      `SELECT e.name, e.category, count(ne.note_id) AS notes FROM entities e
         LEFT JOIN note_entities ne ON ne.entity_id = e.id
        WHERE e.category IN ('person','customer','project','system','place') GROUP BY e.id`
    )
    .all() as unknown as Cand[]
  const byShort = new Map<string, Map<string, Cand>>()
  const add = (short: string, p: Cand): void => {
    const k = short.trim()
    if (k.length < 2 || k.toLowerCase() === p.name.toLowerCase()) return
    const m = byShort.get(k) ?? new Map()
    m.set(p.name.toLowerCase(), p)
    byShort.set(k, m)
  }
  // "Jacob Brooks" and "Jacob Anderson" share "Jacob"; so do "Acme Corp" and "Acme Labs", or a
  // company and a system that both start with "Acme". Every kind of name, not only people.
  for (const p of rows) {
    const parts = p.name.split(/\s+/)
    // "The Gap" and "The Bank" do not make "The" a name worth sorting out.
    const plain = p.category !== 'person' && GENERIC_FIRST.has(parts[0].toLowerCase())
    if (parts.length >= 2 && !plain && (p.category === 'person' || parts[0].length >= 3))
      add(parts[0], p)
    const entry = listOf(reg, p.category as RegCategory).find(
      (e) => e.name.toLowerCase() === p.name.toLowerCase()
    )
    for (const a of entry?.aliases ?? []) if (!a.includes(' ')) add(a, p)
  }
  const out = new Map<string, Cand[]>()
  const marked = new Set(reg.ambiguous.map((a) => a.toLowerCase()))
  for (const [short, m] of byShort)
    if (m.size >= 2 || marked.has(short.toLowerCase()))
      out.set(
        short,
        [...m.values()].sort((a, b) => b.notes - a.notes)
      )
  // Names marked ambiguous that match nobody yet still get a queue (assign to someone new).
  for (const a of reg.ambiguous)
    if (![...out.keys()].some((k) => k.toLowerCase() === a.toLowerCase())) out.set(a, [])
  return out
}

/** Where a bare short name appears (not followed by a surname), with its context. */
export function bareMentions(body: string, short: string): { count: number; snippet: string } {
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escRe(short)}(?![\\p{L}\\p{N}_]|\\s+\\p{Lu}\\p{Ll})`,
    'gu'
  )
  let count = 0
  let first = -1
  for (const m of body.matchAll(re)) {
    count++
    if (first < 0) first = m.index ?? 0
  }
  if (count === 0) return { count, snippet: '' }
  const from = Math.max(0, body.lastIndexOf('\n', first) + 1, first - 90)
  const nl = body.indexOf('\n', first)
  const to = Math.min(nl < 0 ? body.length : nl, first + short.length + 110)
  const snippet =
    (from > 0 && body[from - 1] !== '\n' ? '…' : '') +
    body.slice(from, to).trim() +
    (to < body.length && body[to] !== '\n' ? '…' : '')
  return { count, snippet: snippet.replace(/^[-*]\s+(\[.\]\s+)?/, '') }
}

/**
 * The review queue. `readFrontmatter` returns a note's raw text, so already-assigned notes
 * (frontmatter `mentions`) are left out.
 */
export async function reviewQueue(
  db: Db,
  reg: Registry,
  readText: (path: string) => Promise<string>
): Promise<ReviewGroup[]> {
  const groups: ReviewGroup[] = []
  for (const [short, candidates] of ambiguousNames(db, reg)) {
    const rows = db
      .prepare(
        `SELECT file_path AS path, title, date, body_text AS body FROM notes
          WHERE type <> 'inbox' AND instr(body_text, ?) > 0 ORDER BY date DESC LIMIT 300`
      )
      .all(short) as { path: string; title: string; date: string; body: string }[]
    const mentions: ReviewMention[] = []
    for (const r of rows) {
      const { count, snippet } = bareMentions(r.body, short)
      if (!count) continue
      let assigned: boolean
      try {
        const fm = parseFrontmatter(splitLines(await readText(r.path)))
        assigned =
          !!fm &&
          Object.keys(readMentions(fm.data)).some((k) => k.toLowerCase() === short.toLowerCase())
      } catch {
        assigned = false
      }
      if (!assigned) mentions.push({ path: r.path, title: r.title, date: r.date, snippet, count })
    }
    if (mentions.length) groups.push({ short, candidates, mentions })
  }
  return groups.sort((a, b) => b.mentions.length - a.mentions.length)
}
