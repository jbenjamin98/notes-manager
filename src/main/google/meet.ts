import type { Db } from '../db'
import { quickSummary, renderQuickSummary } from '../assistant/local/extract'
import type { Vault } from '../vault/vault'
import { openEventNote } from '../calendar/openEvent'
import { seriesKey } from '../../shared/series'
import type { MeetArtifact } from './api'

/**
 * Gemini's meeting notes land in Drive as "<Meeting title> - Notes by Gemini". This matches each
 * one to the calendar event with that title around that time and writes the text into the
 * meeting's note under its own heading. Idempotent: a file is written once (tracked by file id).
 */
export const titleOf = (name: string): string =>
  name.replace(/\s*[-–—]\s*(Notes by Gemini|Transcript|Gemini Notes)\s*$/i, '').trim()

export function matchEvent(
  db: Db,
  a: MeetArtifact
): { id: string; date: string; title: string } | null {
  // Exact: the document was attached to this very event.
  if (a.eventId) {
    const hit = db
      .prepare('SELECT id, title, date FROM calendar_events WHERE id = ?')
      .get(a.eventId) as { id: string; title: string; date: string } | undefined
    if (hit) return hit
  }
  const day = a.createdAt.slice(0, 10)
  const rows = db
    .prepare(
      `SELECT id, title, date FROM calendar_events WHERE date BETWEEN date(?, '-1 day') AND date(?, '+1 day') AND kind = 'meeting'`
    )
    .all(day, day) as { id: string; title: string; date: string }[]
  const want = seriesKey(titleOf(a.name))
  const exact = rows.filter((r) => seriesKey(r.title) === want)
  if (exact.length === 0) return null
  // Prefer the same day, then the closest.
  return exact.sort(
    (x, y) => Math.abs(x.date.localeCompare(day)) - Math.abs(y.date.localeCompare(day))
  )[0]
}

export const driveUrl = (fileId: string): string => `https://docs.google.com/document/d/${fileId}`

/**
 * What goes into the meeting's note. By default a short, useful version: a link to the document in
 * Drive plus its key points (decisions, open questions, next steps). `fullText` copies everything.
 */
export function sectionFor(a: MeetArtifact, fullText = true): string {
  const head = a.kind === 'transcript' ? '## Transcript (Meet)' : '## Notes by Gemini (Meet)'
  const link = `[Open in Drive](${driveUrl(a.fileId)})`
  let body = a.text.trim() || '(empty)'
  if (!fullText) {
    const k = quickSummary(a.text)
    body = k ? renderQuickSummary(k) : body.slice(0, 1500)
    body = `${link}\n\n${body}`
  } else body = `${link}\n\n${body}`
  return `\n${head}\n<!-- meet:${a.fileId} -->\n${body}\n`
}

export interface MeetingRead {
  eventId: string | null
  title: string
  date: string
  text: string
  notePath: string | null
  fileId: string
}

export async function applyMeetArtifacts(
  db: Db,
  vault: Vault,
  artifacts: MeetArtifact[],
  opts: { fullText?: boolean; onMeeting?: (m: MeetingRead) => Promise<unknown> } = {}
): Promise<{ written: number; unmatched: number }> {
  let written = 0
  let unmatched = 0
  const ins = db.prepare(
    `INSERT OR IGNORE INTO meet_artifacts (file_id, name, kind, created_at, event_id, note_path) VALUES (?,?,?,?,?,?)`
  )
  for (const a of artifacts) {
    const ev = matchEvent(db, a)
    if (!ev) {
      unmatched++
      ins.run(a.fileId, a.name, a.kind, a.createdAt, null, null)
      await opts.onMeeting?.({
        eventId: null,
        title: titleOf(a.name),
        date: a.createdAt,
        text: a.text,
        notePath: null,
        fileId: a.fileId
      })
      continue
    }
    const path = await openEventNote(db, vault, ev.id)
    const { content, hash } = await vault.readNote(path)
    if (!content.includes(`<!-- meet:${a.fileId} -->`)) {
      await vault.saveNote(
        path,
        content.trimEnd() + '\n' + sectionFor(a, opts.fullText ?? true),
        hash
      )
      written++
    }
    ins.run(a.fileId, a.name, a.kind, a.createdAt, ev.id, path)
    await opts.onMeeting?.({
      eventId: ev.id,
      title: ev.title,
      date: ev.date,
      text: a.text,
      notePath: path,
      fileId: a.fileId
    })
  }
  return { written, unmatched }
}

export const knownArtifacts = (db: Db): Set<string> =>
  new Set(
    (db.prepare('SELECT file_id FROM meet_artifacts').all() as { file_id: string }[]).map(
      (r) => r.file_id
    )
  )
