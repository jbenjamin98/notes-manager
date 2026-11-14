import type { Db } from '../db'
import type { Vault } from '../vault/vault'

/**
 * "Start notes for this meeting": returns the existing note linked to the calendar
 * event, or creates a meeting-template note pre-filled from it. Idempotent, so a
 * double click never creates two notes.
 */
export async function openEventNote(db: Db, vault: Vault, eventId: string): Promise<string> {
  const existing = db
    .prepare('SELECT file_path FROM notes WHERE calendar_event_id = ? LIMIT 1')
    .get(eventId) as { file_path: string } | undefined
  if (existing) return existing.file_path

  const e = db
    .prepare('SELECT title, date, start_at, end_at, all_day FROM calendar_events WHERE id = ?')
    .get(eventId) as
    { title: string; date: string; start_at: string; end_at: string; all_day: number } | undefined
  if (!e) throw new Error('That meeting is no longer on your calendar. Refresh and try again.')

  return vault.createNote({
    kind: 'meeting',
    title: e.title,
    date: e.date,
    calendarEventId: eventId,
    // "NextMRO Sync" files itself under the right account when that account is known.
    account: vault.guessAccount(e.title) ?? undefined,
    time: e.all_day ? undefined : `${e.start_at.slice(11, 16)}-${e.end_at.slice(11, 16)}`
  })
}
