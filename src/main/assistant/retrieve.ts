import type { Db } from '../db'

export interface Hit {
  /** 1-based citation number used in prompts ("[1]"). */
  n: number
  chunkId: number
  path: string
  title: string
  date: string
  heading: string | null
  text: string
}

const STOP = new Set(
  'the and for with that this are was were what when where which who whom how why did does have has had about from into over our your you your can could should would will any all not but also still need needs tell show find list summarize summarise remind decide decided decision last month week year'.split(
    ' '
  )
)

/**
 * A safe FTS5 query: every word quoted (so punctuation and operators in the question can never be
 * parsed as syntax) and OR-ed together; bm25 ranking then favours chunks matching more of them.
 */
export function ftsQuery(question: string): string | null {
  const words = [
    ...new Set(question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [])
  ].filter((w) => !STOP.has(w))
  if (words.length === 0) return null
  return words
    .slice(0, 12)
    .map((w) => `"${w.replace(/"/g, '')}"`)
    .join(' OR ')
}

/** Top chunks from the user's notes for a question: full-text search, conflict copies excluded. */
export function retrieve(db: Db, question: string, k = 5, chars = 700): Hit[] {
  const q = ftsQuery(question)
  if (!q) return []
  let rows: {
    id: number
    path: string
    title: string
    date: string
    heading: string | null
    text: string
  }[]
  try {
    rows = db
      .prepare(
        `SELECT c.id, n.file_path AS path, n.title, n.date, c.heading, c.text
           FROM chunks_fts f
           JOIN note_chunks c ON c.id = f.rowid
           JOIN notes n ON n.id = c.note_id
          WHERE chunks_fts MATCH ? AND n.file_path NOT LIKE '% (%).md' AND lower(n.file_path) NOT LIKE '%conflict%'
          ORDER BY bm25(chunks_fts) LIMIT ?`
      )
      .all(q, k * 3) as unknown as typeof rows
  } catch {
    return []
  }
  // One chunk per heading per note keeps the context varied.
  const seen = new Set<string>()
  const hits: Hit[] = []
  for (const r of rows) {
    const key = `${r.path}#${r.heading ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push({
      n: hits.length + 1,
      chunkId: r.id,
      path: r.path,
      title: r.title,
      date: r.date,
      heading: r.heading,
      text: r.text.length > chars ? r.text.slice(0, chars - 3) + '…' : r.text
    })
    if (hits.length >= k) break
  }
  return hits
}

/** Paths of notes whose text contains ALL the typed words (for the All notes filter). */
export function searchNotePaths(db: Db, query: string, limit = 300): string[] {
  const words = [
    ...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{1,}/gu) ?? [])
  ].slice(0, 8)
  if (words.length === 0) return []
  const q = words.map((w) => `"${w.replace(/"/g, '')}"`).join(' AND ')
  try {
    return (
      db
        .prepare(
          `SELECT DISTINCT n.file_path AS path FROM chunks_fts f
             JOIN note_chunks c ON c.id = f.rowid JOIN notes n ON n.id = c.note_id
            WHERE chunks_fts MATCH ? AND n.type <> 'inbox' LIMIT ?`
        )
        .all(q, limit) as { path: string }[]
    ).map((r) => r.path)
  } catch {
    return []
  }
}
