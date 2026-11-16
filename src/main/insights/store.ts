import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import type { Candidate, InsightKind, SourceInfo } from './types'

export interface InsightRow {
  id: string
  kind: InsightKind
  text: string
  owner: string | null
  due: string | null
  confidence: number
  status: 'new' | 'accepted' | 'dismissed'
  sourceType: SourceInfo['type']
  sourceRef: Record<string, string | null>
  sourceLabel: string
  sourceSnippet: string
  sourceAt: string | null
  createdAt: string
  entities: string[]
}

const STOP = new Set(
  'a an the and or but to of in on for with at by from is are was were be been will would can could should this that it we i you they he she our your their my me us as so if then there here have has had do does did not no'.split(
    ' '
  )
)

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  )

export function similarity(a: string, b: string): number {
  const x = tokens(a)
  const y = tokens(b)
  if (!x.size || !y.size) return 0
  let n = 0
  for (const t of x) if (y.has(t)) n++
  return n / (x.size + y.size - n)
}

const SAME_FAMILY: Record<InsightKind, InsightKind[]> = {
  action: ['action', 'ask', 'promise'],
  ask: ['action', 'ask', 'promise'],
  promise: ['action', 'ask', 'promise'],
  decision: ['decision', 'change'],
  change: ['decision', 'change'],
  question: ['question'],
  risk: ['risk'],
  fact: ['fact']
}

const names = (db: Db): string[] =>
  (db.prepare('SELECT name FROM entities WHERE length(name) >= 3').all() as { name: string }[]).map(
    (r) => r.name
  )

const mentions = (text: string, all: string[]): string[] => {
  const t = text.toLowerCase()
  return all.filter((n) => {
    const i = t.indexOf(n.toLowerCase())
    return i >= 0 && !/\w/.test(t[i - 1] ?? ' ') && !/\w/.test(t[i + n.length] ?? ' ')
  })
}

/**
 * Keep new candidates, once: skip anything we already have (the same action said in the meeting
 * and again in chat is one insight, with the first source). Returns what was added.
 */
export function saveInsights(
  db: Db,
  src: SourceInfo,
  found: Candidate[],
  minConfidence = 0.45
): InsightRow[] {
  const known = db
    .prepare(
      "SELECT kind, text FROM insights WHERE created_at > datetime('now','-60 days') AND status <> 'dismissed' OR status = 'accepted'"
    )
    .all() as { kind: InsightKind; text: string }[]
  const ins = db.prepare(
    `INSERT INTO insights (id, kind, text, owner, due, confidence, source_type, source_ref, source_label, source_snippet, source_at, dedupe_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const link = db.prepare(
    'INSERT OR IGNORE INTO insight_entities (insight_id, entity_name) VALUES (?,?)'
  )
  const all = names(db)
  const added: string[] = []
  db.exec('BEGIN')
  try {
    for (const c of found) {
      if (c.confidence < minConfidence) continue
      const fam = SAME_FAMILY[c.kind]
      if (known.some((k) => fam.includes(k.kind) && similarity(k.text, c.text) >= 0.7)) continue
      const id = randomUUID()
      const key = `${c.kind}:${[...tokens(c.text)].sort().slice(0, 12).join('-')}`
      try {
        ins.run(
          id,
          c.kind,
          c.text,
          c.owner,
          c.due,
          c.confidence,
          src.type,
          JSON.stringify(src.ref),
          src.label,
          c.evidence.slice(0, 300),
          src.at,
          key
        )
      } catch {
        continue // the same key already exists
      }
      for (const n of mentions(`${c.text} ${c.owner ?? ''}`, all)) link.run(id, n)
      known.push({ kind: c.kind, text: c.text })
      added.push(id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return added.map((id) => getInsight(db, id)!)
}

interface Raw {
  id: string
  kind: InsightKind
  text: string
  owner: string | null
  due: string | null
  confidence: number
  status: InsightRow['status']
  source_type: InsightRow['sourceType']
  source_ref: string
  source_label: string
  source_snippet: string
  source_at: string | null
  created_at: string
}

const toRow = (db: Db, r: Raw): InsightRow => ({
  id: r.id,
  kind: r.kind,
  text: r.text,
  owner: r.owner,
  due: r.due,
  confidence: r.confidence,
  status: r.status,
  sourceType: r.source_type,
  sourceRef: JSON.parse(r.source_ref || '{}') as Record<string, string | null>,
  sourceLabel: r.source_label,
  sourceSnippet: r.source_snippet,
  sourceAt: r.source_at,
  createdAt: r.created_at,
  entities: (
    db.prepare('SELECT entity_name FROM insight_entities WHERE insight_id = ?').all(r.id) as {
      entity_name: string
    }[]
  ).map((e) => e.entity_name)
})

export function getInsight(db: Db, id: string): InsightRow | null {
  const r = db.prepare('SELECT * FROM insights WHERE id = ?').get(id) as unknown as Raw | undefined
  return r ? toRow(db, r) : null
}

export function listInsights(
  db: Db,
  status: InsightRow['status'] = 'new',
  limit = 200
): InsightRow[] {
  return (
    db
      .prepare(
        'SELECT * FROM insights WHERE status = ? ORDER BY confidence DESC, coalesce(source_at, created_at) DESC LIMIT ?'
      )
      .all(status, limit) as unknown as Raw[]
  ).map((r) => toRow(db, r))
}

export function setStatus(db: Db, id: string, status: InsightRow['status']): void {
  db.prepare('UPDATE insights SET status = ? WHERE id = ?').run(status, id)
}

/** Facts and decisions about a person, company, project or system, with where each came from. */
export function insightsFor(db: Db, entityName: string, limit = 30): InsightRow[] {
  return (
    db
      .prepare(
        `SELECT i.* FROM insights i JOIN insight_entities e ON e.insight_id = i.id
          WHERE lower(e.entity_name) = lower(?) AND i.status <> 'dismissed'
          ORDER BY coalesce(i.source_at, i.created_at) DESC LIMIT ?`
      )
      .all(entityName, limit) as unknown as Raw[]
  ).map((r) => toRow(db, r))
}

/** Have we already read this exact source text? Skips work (and tokens) on unchanged sources. */
export function alreadyRead(db: Db, key: string, hash: string): boolean {
  const r = db.prepare('SELECT hash FROM insight_runs WHERE source_key = ?').get(key) as
    { hash: string } | undefined
  return r?.hash === hash
}
export function markRead(db: Db, key: string, hash: string): void {
  db.prepare(
    `INSERT INTO insight_runs (source_key, hash, at) VALUES (?,?,datetime('now'))
     ON CONFLICT(source_key) DO UPDATE SET hash = excluded.hash, at = excluded.at`
  ).run(key, hash)
}
