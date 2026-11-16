import type { Db } from '../db'
import type { EntityCategory, ExtractedEntity } from './extract'
import { listOf, REG_CATEGORIES, type RegCategory, type Registry } from './registry'

/** SQL fragment excluding Google Drive conflict copies from analytics (they'd double-count). */
const NOT_CONFLICT = `n.file_path NOT LIKE '% (%).md' AND lower(n.file_path) NOT LIKE '%conflict%'`

export const entityId = (category: string, name: string): string =>
  `${category}:${name.toLowerCase()}`

/** Find-or-create by case-insensitive name. A registry entry always wins over a discovered one. */
export function upsertEntityRow(
  db: Db,
  category: EntityCategory,
  name: string,
  inRegistry: boolean
): string {
  const row = db
    .prepare('SELECT id, in_registry AS inReg FROM entities WHERE lower(name) = lower(?)')
    .get(name) as { id: string; inReg: number } | undefined
  if (row) {
    if (inRegistry && !row.inReg) {
      db.prepare('UPDATE entities SET category = ?, name = ?, in_registry = 1 WHERE id = ?').run(
        category,
        name,
        row.id
      )
    }
    return row.id
  }
  const id = entityId(category, name)
  db.prepare('INSERT INTO entities (id, name, category, in_registry) VALUES (?,?,?,?)').run(
    id,
    name,
    category,
    inRegistry ? 1 : 0
  )
  return id
}

export function replaceNoteEntities(db: Db, noteId: string, entities: ExtractedEntity[]): void {
  db.prepare('DELETE FROM note_entities WHERE note_id = ?').run(noteId)
  const ins = db.prepare(
    "INSERT OR REPLACE INTO note_entities (note_id, entity_id, mention_count, source) VALUES (?,?,?, 'deterministic')"
  )
  for (const e of entities) {
    ins.run(noteId, upsertEntityRow(db, e.category, e.name, e.inRegistry), e.count)
  }
  pruneOrphans(db)
}

/** Discovered entities with no notes disappear; registry entries stay even with zero mentions. */
export function pruneOrphans(db: Db): void {
  db.exec(
    `DELETE FROM entities WHERE in_registry = 0 AND id NOT IN (SELECT DISTINCT entity_id FROM note_entities)`
  )
}

/** Mirror the registry into `entities` (so zero-mention systems still list) and clear stale flags. */
export function syncRegistryRows(db: Db, reg: Registry): void {
  db.exec('BEGIN')
  try {
    db.exec('UPDATE entities SET in_registry = 0')
    for (const c of REG_CATEGORIES) {
      for (const e of listOf(reg, c)) upsertEntityRow(db, c, e.name, true)
    }
    pruneOrphans(db)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// ------------------------------------------------------------------- queries

export interface EntitySummary {
  id: string
  name: string
  category: EntityCategory
  inRegistry: boolean
  notes: number
  mentions: number
  lastDate: string | null
}

export function listEntities(db: Db): EntitySummary[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.category, e.in_registry AS inRegistry,
              count(n.id) AS notes, coalesce(sum(ne.mention_count), 0) AS mentions, max(n.date) AS lastDate
         FROM entities e
         LEFT JOIN note_entities ne ON ne.entity_id = e.id
         LEFT JOIN notes n ON n.id = ne.note_id AND ${NOT_CONFLICT}
        GROUP BY e.id
        ORDER BY notes DESC, e.name COLLATE NOCASE`
    )
    .all() as unknown as (Omit<EntitySummary, 'inRegistry'> & { inRegistry: number })[]
  return rows.map((r) => ({ ...r, inRegistry: !!r.inRegistry }))
}

export interface DossierNote {
  path: string
  title: string
  date: string
  account: string | null
  mentions: number
  snippet: string
}

export interface WeekBucket {
  weekStart: string
  notes: number
}

export interface Dossier {
  id: string
  name: string
  category: EntityCategory
  inRegistry: boolean
  aliases: string[]
  notes: DossierNote[]
  weeks: WeekBucket[]
  totalNotes: number
  totalMentions: number
}

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Monday of the week containing `d`. */
export function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

export function weeklyBuckets(dates: string[], now: Date, weeks = 12): WeekBucket[] {
  const start = weekStart(now)
  const buckets: WeekBucket[] = []
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(start)
    d.setDate(d.getDate() - i * 7)
    buckets.push({ weekStart: iso(d), notes: 0 })
  }
  for (const date of dates) {
    const w = iso(weekStart(new Date(`${date}T12:00:00`)))
    const b = buckets.find((x) => x.weekStart === w)
    if (b) b.notes++
  }
  return buckets
}

function snippetFor(body: string, terms: string[]): string {
  const lowered = terms.map((t) => t.toLowerCase())
  for (const line of body.split('\n')) {
    const l = line.toLowerCase()
    if (lowered.some((t) => l.includes(t))) {
      const clean = line
        .replace(/\s\^[A-Za-z0-9]{4,12}\s*$/, '')
        .replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '')
        .trim()
      return clean.length > 160 ? clean.slice(0, 157) + '…' : clean
    }
  }
  return ''
}

export function entityDossier(db: Db, id: string, reg: Registry, now = new Date()): Dossier | null {
  const e = db
    .prepare('SELECT id, name, category, in_registry AS inRegistry FROM entities WHERE id = ?')
    .get(id) as
    { id: string; name: string; category: EntityCategory; inRegistry: number } | undefined
  if (!e) return null
  const regCat = e.category === 'topic' ? null : (e.category as RegCategory)
  const aliases = regCat
    ? (listOf(reg, regCat).find((x) => x.name.toLowerCase() === e.name.toLowerCase())?.aliases ??
      [])
    : []
  const rows = db
    .prepare(
      `SELECT n.file_path AS path, n.title, n.date, n.account, ne.mention_count AS mentions, n.body_text AS body
         FROM note_entities ne JOIN notes n ON n.id = ne.note_id
        WHERE ne.entity_id = ? AND ${NOT_CONFLICT}
        ORDER BY n.date DESC, n.updated_at DESC`
    )
    .all(id) as unknown as (Omit<DossierNote, 'snippet'> & { body: string | null })[]
  const terms = [e.name, ...aliases]
  const notes: DossierNote[] = rows.slice(0, 200).map(({ body, ...r }) => ({
    ...r,
    snippet: snippetFor(body ?? '', terms)
  }))
  return {
    id: e.id,
    name: e.name,
    category: e.category,
    inRegistry: !!e.inRegistry,
    aliases,
    notes,
    weeks: weeklyBuckets(
      rows.map((r) => r.date),
      now
    ),
    totalNotes: rows.length,
    totalMentions: rows.reduce((s, r) => s + r.mentions, 0)
  }
}

// ------------------------------------------------------------------ insights

const STOP = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between ' +
    'both but by can could did do does doing down during each few for from further get got had has have having he her ' +
    'here hers him his how i if in into is it its just like make me more most my no nor not now of off on once only ' +
    'or other our out over own same she should so some such than that the their theirs them then there these they this ' +
    'those through to too under until up us very was we were what when where which while who whom why will with would ' +
    'you your yours need needs will going gone one two three yes yeah okay ok per via etc ' +
    // template + task-syntax noise
    'context objective key decisions insights open questions parking lot action items item task tasks due priority ' +
    'high medium low est note notes meeting meetings todo done ' +
    // filler that carries no topic: chatter, time words, generic meeting verbs
    'think thing things want wanted lets let see seen look looks looking said say says saying know knows knew ' +
    'work working works worked use used using way ways time times today tomorrow yesterday tonight week weeks day days ' +
    'month months year years daily weekly monthly really actually maybe still back next last new old good great sure ' +
    'fine well right left able etc team call calls update updates updated follow followup discuss discussed ' +
    'discussion talk talked talking review reviewed sync check checked please thanks thank hello thing stuff lot ' +
    'bit little much many every everything anything something someone anyone everyone nothing around going went come ' +
    'came take took taken give gave given put keep kept ask asked asking tell told send sent sending bring brought ' +
    'start started starting end ended finish finished plan planned planning share shared sharing ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april june july august ' +
    'september october november december first second third another both either neither however though although ' +
    'because since while whether might must shall may cannot dont doesnt didnt isnt wasnt arent werent wont ' +
    'being able got getting make makes made making'
  ).split(' ')
)

export interface InsightWord {
  word: string
  count: number
  notes: number
}
export interface InsightNode {
  id: string
  name: string
  category: EntityCategory
  notes: number
}
export interface InsightEdge {
  a: string
  b: string
  weight: number
}
export interface Insights {
  days: number | null
  notes: number
  words: InsightWord[]
  nodes: InsightNode[]
  edges: InsightEdge[]
}

export function tokenize(body: string): string[] {
  const cleaned = body
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\^t[a-z0-9]{6}\b/g, ' ') // task ids
    .replace(/(?<![\p{L}\p{N}_])[@#][\p{L}\p{N}._/-]+/gu, ' ') // people/tags are shown in the graph
    .replace(/\b(due|priority|est):\S+/gi, ' ')
  return (cleaned.toLowerCase().match(/[\p{L}][\p{L}'-]{2,}/gu) ?? [])
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w))
}

/** Fold simple plurals into their singular ("rules" into "rule") when both appear. */
export function foldPlurals(m: Map<string, { count: number; notes: number }>): void {
  for (const w of [...m.keys()]) {
    if (!w.endsWith('s') || w.length < 5) continue
    const base = w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.slice(0, -1)
    const one = m.get(base)
    const many = m.get(w)
    if (one && many) {
      one.count += many.count
      one.notes = Math.max(one.notes, many.notes)
      m.delete(w)
    }
  }
}

export function analyze(
  db: Db,
  days: number | null,
  now = new Date(),
  maxWords = 60,
  maxNodes = 40
): Insights {
  const from =
    days === null
      ? '0000-00-00'
      : iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days))
  const notes = db
    .prepare(`SELECT n.id, n.body_text AS body FROM notes n WHERE n.date >= ? AND ${NOT_CONFLICT}`)
    .all(from) as unknown as { id: string; body: string | null }[]

  // Words: each note contributes at most 3 per word so one long note can't dominate.
  const wc = new Map<string, { count: number; notes: number }>()
  for (const n of notes) {
    const local = new Map<string, number>()
    for (const w of tokenize(n.body ?? '')) local.set(w, (local.get(w) ?? 0) + 1)
    for (const [w, c] of local) {
      const cur = wc.get(w) ?? { count: 0, notes: 0 }
      cur.count += Math.min(c, 3)
      cur.notes += 1
      wc.set(w, cur)
    }
  }
  foldPlurals(wc)
  // People's names are shown in the network; they are not topics. Skip every part of a known person's name.
  const nameParts = new Set<string>()
  for (const r of db
    .prepare("SELECT name FROM entities WHERE category = 'person'")
    .all() as unknown as { name: string }[])
    for (const p of r.name.toLowerCase().split(/\s+/)) if (p.length >= 3) nameParts.add(p)
  const N = notes.length
  const words = [...wc.entries()]
    .map(([word, v]) => ({ word, ...v }))
    .filter((w) => !nameParts.has(w.word))
    .filter((w) => w.notes >= 2 || N < 6) // a word in a single note is noise once there is history
    // Boilerplate: a word in most notes says nothing about any one of them.
    .filter((w) => N < 8 || w.notes / N <= 0.6)
    // Rank by distinctiveness (frequent here, rare elsewhere), not raw frequency.
    .map((w) => ({ ...w, score: w.count * Math.log(1 + N / w.notes) }))
    .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word))
    .slice(0, maxWords)
    .map(({ word, count, notes: n }) => ({ word, count, notes: n }))

  // Graph: entities that co-occur in the same note.
  const links = db
    .prepare(
      `SELECT ne.note_id AS noteId, e.id, e.name, e.category
         FROM note_entities ne JOIN notes n ON n.id = ne.note_id JOIN entities e ON e.id = ne.entity_id
        WHERE n.date >= ? AND ${NOT_CONFLICT}`
    )
    .all(from) as unknown as {
    noteId: string
    id: string
    name: string
    category: EntityCategory
  }[]
  const byNote = new Map<string, typeof links>()
  const stats = new Map<string, InsightNode>()
  for (const l of links) {
    byNote.set(l.noteId, [...(byNote.get(l.noteId) ?? []), l])
    const s = stats.get(l.id) ?? { id: l.id, name: l.name, category: l.category, notes: 0 }
    s.notes++
    stats.set(l.id, s)
  }
  const nodes = [...stats.values()]
    .sort((a, b) => b.notes - a.notes || a.name.localeCompare(b.name))
    .slice(0, maxNodes)
  const keep = new Set(nodes.map((n) => n.id))
  const pair = new Map<string, InsightEdge>()
  for (const members of byNote.values()) {
    const ids = members.map((m) => m.id).filter((i) => keep.has(i))
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]]
        const k = `${a}|${b}`
        const cur = pair.get(k) ?? { a, b, weight: 0 }
        cur.weight++
        pair.set(k, cur)
      }
    }
  }
  const edges = [...pair.values()].sort((a, b) => b.weight - a.weight).slice(0, 150)
  return { days, notes: notes.length, words, nodes, edges }
}

/**
 * Open tasks "tied to" an entity: owned by them, mentioning them, or living in a note
 * that mentions them. (Persons: owner/alias match; everything else: note mentions.)
 */
export function tasksTiedTo<
  T extends { status: string; owner: string; description: string; notePath: string }
>(
  tasks: T[],
  entity: { name: string; category: EntityCategory; aliases: string[] },
  mentioningPaths: Set<string>
): T[] {
  const names = [entity.name, ...entity.aliases].map((s) => s.toLowerCase())
  return tasks.filter((t) => {
    if (t.status !== 'open') return false
    const owner = t.owner.toLowerCase()
    const desc = t.description.toLowerCase()
    if (entity.category === 'person') {
      return names.includes(owner) || names.some((n) => desc.includes(n))
    }
    return mentioningPaths.has(t.notePath) || names.some((n) => desc.includes(n))
  })
}
