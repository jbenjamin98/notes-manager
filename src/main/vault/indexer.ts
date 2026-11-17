import type { Db } from '../db'
import { parseNote } from './parse'
import { readMentions } from './edit'
import { sha256 } from './ids'
import { extractEntities } from '../entities/extract'
import { inferDue, type PersonIndex } from '../entities/infer'
import type { Matcher } from '../entities/registry'
import { pruneOrphans, replaceNoteEntities } from '../entities/store'

export interface IndexInput {
  relPath: string
  content: string
  mtimeMs: number
  size: number
  meAliases: string[]
  matcher: Matcher
  /** Known people, for inferring who a task is for from its wording. */
  people: PersonIndex
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/

function noteType(relPath: string, fm: Record<string, unknown>): 'meeting' | 'adhoc' | 'inbox' {
  if (relPath.startsWith('inbox/')) return 'inbox'
  return fm.type === 'meeting' ? 'meeting' : 'adhoc'
}

function noteDate(relPath: string, fm: Record<string, unknown>, mtimeMs: number): string {
  const fromFm =
    fm.date instanceof Date ? fm.date.toISOString().slice(0, 10) : String(fm.date ?? '')
  if (DATE_RE.test(fromFm)) return fromFm.slice(0, 10)
  const file = relPath.split('/').pop() ?? ''
  const m = DATE_RE.exec(file)
  return m ? m[1] : new Date(mtimeMs).toISOString().slice(0, 10)
}

/** Owner of a task id (other than `noteId`), if any. Used to detect copy-pasted task lines. */
export function taskOwnerElsewhere(db: Db, id: string, noteId: string): boolean {
  const r = db.prepare('SELECT note_id FROM tasks WHERE id = ?').get(id) as
    { note_id: string } | undefined
  return !!r && r.note_id !== noteId
}

/** Path of another note already using this note id, if any. */
export function noteIdPath(db: Db, noteId: string): string | null {
  const r = db.prepare('SELECT file_path FROM notes WHERE id = ?').get(noteId) as
    { file_path: string } | undefined
  return r?.file_path ?? null
}

/**
 * Replace everything derived from one file, atomically. Content must already
 * carry identity (frontmatter id + task ids) — see ensureIdentity.
 */
export function indexNote(db: Db, input: IndexInput): { noteId: string; tasks: number } {
  const { relPath, content, mtimeMs, size, meAliases } = input
  const parsed = parseNote(content)
  const fm = parsed.frontmatter?.data ?? {}
  const noteId = String(fm.id ?? '')
  if (!noteId) throw new Error(`indexNote: ${relPath} has no frontmatter id`)

  const title =
    (typeof fm.title === 'string' && fm.title.trim()) ||
    parsed.title ||
    (relPath.split('/').pop() ?? relPath).replace(/\.md$/i, '')
  const account = typeof fm.account === 'string' ? fm.account : null
  const eventId = typeof fm.calendar_event_id === 'string' ? fm.calendar_event_id : null
  const mine = new Set(['me', ...meAliases.map((a) => a.toLowerCase())])

  const keep = new Set<string>()
  const noteDateIso = noteDate(relPath, fm, mtimeMs)
  db.exec('BEGIN')
  try {
    // A moved/renamed file keeps its id; free up the path if another row holds it.
    db.prepare('DELETE FROM notes WHERE file_path = ? AND id <> ?').run(relPath, noteId)
    db.prepare(
      `INSERT INTO notes (id,file_path,title,type,date,account,calendar_event_id,llm_blocked,body_text,series,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path,title=excluded.title,type=excluded.type,
         date=excluded.date,account=excluded.account,calendar_event_id=excluded.calendar_event_id,
         llm_blocked=excluded.llm_blocked,body_text=excluded.body_text,series=excluded.series,updated_at=CURRENT_TIMESTAMP`
    ).run(
      noteId,
      relPath,
      title,
      noteType(relPath, fm),
      noteDateIso,
      account,
      eventId,
      0,
      parsed.body,
      typeof fm.series === 'string' && fm.series.trim() ? fm.series.trim() : null
    )

    // Tasks: upsert by inline id, keep assigned_at, track completion transitions, drop removed.
    const existing = new Map(
      (
        db.prepare('SELECT id,status,completed_at FROM tasks WHERE note_id = ?').all(noteId) as {
          id: string
          status: string
          completed_at: string | null
        }[]
      ).map((r) => [r.id, r])
    )
    const upsert = db.prepare(
      `INSERT INTO tasks (id,note_id,line_hash,description,owner,is_mine,due_date,priority,est_minutes,status,completed_at,auto_owner,auto_due,source_id,source_label)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET line_hash=excluded.line_hash,description=excluded.description,
         owner=excluded.owner,is_mine=excluded.is_mine,due_date=excluded.due_date,priority=excluded.priority,
         est_minutes=excluded.est_minutes,status=excluded.status,completed_at=excluded.completed_at,
         auto_owner=excluded.auto_owner,auto_due=excluded.auto_due,
         source_id=excluded.source_id,source_label=excluded.source_label`
    )
    const firstSeenDone = new Date(
      Math.min(Date.now(), new Date(`${noteDateIso}T12:00:00`).getTime())
    ).toISOString()
    for (const t of parsed.tasks) {
      if (!t.id) continue
      keep.add(t.id)
      const prev = existing.get(t.id)
      const status = t.checked ? 'completed' : 'open'
      // Ticked while the app was watching: now. Already ticked the first time we see it (old notes, a new
      // install): the note's own date (file times are unreliable: we rewrite files to add task ids),
      // so history does not all look like "this week".
      const completedAt = t.checked
        ? (prev?.completed_at ?? (prev ? new Date().toISOString() : firstSeenDone))
        : null

      // Plain wording is enough for the date: "... by Tuesday" needs no due:.
      // Explicit fields always win; relative dates resolve against when the note was written
      // (inbox files are dated the 1st of the month, so those use today).
      const owner = t.owner
      let due = t.due
      const autoOwner = 0
      let autoDue = 0
      // Wording never changes the owner: "Remind Sarah to..." is your task about Sarah (linked below).
      if (!t.dueExplicit) {
        const ref = relPath.startsWith('inbox/') ? new Date() : new Date(`${noteDateIso}T12:00:00`)
        const d = inferDue(t.description, ref)
        if (d) {
          due = d
          autoDue = 1
        }
      }
      upsert.run(
        t.id,
        noteId,
        sha256(`${t.description}|${owner}|${due}|${t.priority}`),
        t.description,
        owner,
        mine.has(owner.toLowerCase()) ? 1 : 0,
        due,
        t.priority,
        t.estMinutes,
        status,
        completedAt,
        autoOwner,
        autoDue,
        t.sourceId,
        t.sourceLabel
      )
    }
    for (const id of existing.keys()) {
      if (!keep.has(id)) db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    }

    const attendees = Array.isArray(fm.attendees) ? fm.attendees.map(String) : []
    replaceNoteEntities(
      db,
      noteId,
      extractEntities(
        { title, body: applyMentions(parsed.body, readMentions(fm)), attendees, account },
        input.matcher
      )
    )

    db.prepare('DELETE FROM note_chunks WHERE note_id = ?').run(noteId)
    const ins = db.prepare('INSERT INTO note_chunks (note_id,heading,text) VALUES (?,?,?)')
    for (const c of parsed.chunks) ins.run(noteId, c.heading, c.text)

    db.prepare(
      `INSERT INTO file_state (path,hash,mtime_ms,size,indexed_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(path) DO UPDATE SET hash=excluded.hash,mtime_ms=excluded.mtime_ms,size=excluded.size,indexed_at=CURRENT_TIMESTAMP`
    ).run(relPath, sha256(content), mtimeMs, size)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { noteId, tasks: keep.size }
}

export function removeFromIndex(db: Db, relPath: string): void {
  db.prepare('DELETE FROM notes WHERE file_path = ?').run(relPath)
  db.prepare('DELETE FROM file_state WHERE path = ?').run(relPath)
  pruneOrphans(db)
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A note can say who a short name means (`mentions: {"Jacob": "Jacob Anderson"}`, set from Review
 * People). For finding people only, the bare short name is read as the full name; the note's text
 * is never changed. A short name already followed by a capitalised surname is left alone.
 */
export function applyMentions(body: string, mentions: Record<string, string>): string {
  let out = body
  for (const [short, full] of Object.entries(mentions))
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escRe(short)}(?![\\p{L}\\p{N}_]|\\s+\\p{Lu})`, 'gu'),
      full
    )
  return out
}
