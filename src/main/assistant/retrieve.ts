import type { Db } from '../db'
import { mentionsCui } from './intent'

export interface Hit {
  /** 1-based citation number used in prompts ("[1]"). */
  n: number
  chunkId: number
  path: string
  title: string
  date: string
  heading: string | null
  text: string
  /** Note is marked CUI: may be shown locally, never sent to an LLM. */
  blocked: boolean
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
export function retrieve(db: Db, question: string, k = 5): Hit[] {
  const q = ftsQuery(question)
  if (!q) return []
  let rows: {
    id: number
    path: string
    title: string
    date: string
    heading: string | null
    text: string
    blocked: number
  }[]
  try {
    rows = db
      .prepare(
        `SELECT c.id, n.file_path AS path, n.title, n.date, c.heading, c.text, n.llm_blocked AS blocked
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
      text: r.text.length > 700 ? r.text.slice(0, 697) + '…' : r.text,
      // Tagged notes are blocked as a whole; any snippet that says CUI is blocked even in an untagged note.
      blocked: !!r.blocked || mentionsCui(r.text) || mentionsCui(r.title)
    })
    if (hits.length >= k) break
  }
  return hits
}
