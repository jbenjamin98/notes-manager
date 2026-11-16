import type { Db } from '../db'
import type { Vault } from '../vault/vault'
import { openEventNote } from '../calendar/openEvent'
import { addUnderHeading } from '../insights/accept'

/**
 * Tasks are only for you. Something someone else should do is kept as a note line instead:
 *
 *   - **Waiting on Sarah:** Send the deck (due 2026-11-20) [Chat · Priya · Nov 14](nm://src/…)
 *
 * It lives in the meeting's note (or this month's log), reads well in any editor, and the
 * "Waiting On" view and the follow-up radar find it by that shape. Striking it through (~~…~~)
 * marks it received.
 */
export const WAITING_HEADING = 'Waiting On'

export interface WaitingInput {
  who: string
  text: string
  due?: string | null
  /** A markdown link back to where it came from. */
  link?: string | null
}

export interface WaitingItem {
  who: string
  text: string
  due: string | null
  /** The exact line, so it can be found again to mark it received. */
  line: string
  notePath: string
  noteTitle: string
  /** The note's date: roughly when you started waiting. */
  since: string
  done: boolean
}

const LINE_RE = /^\s*[-*]\s+(~~)?\*\*Waiting on ([^:*]+):\*\*\s*(.*?)(~~)?\s*(✓.*)?$/i
const DUE_RE = /\s*\(due (\d{4}-\d{2}-\d{2})\)/i
const LINK_RE = /\s*\[[^\]]*\]\(nm:\/\/src\/[^)]+\)/g

export function formatWaitingLine(w: WaitingInput): string {
  const due = w.due ? ` (due ${w.due})` : ''
  const link = w.link ? ` ${w.link}` : ''
  return `- **Waiting on ${w.who.replace(/^@/, '').trim()}:** ${w.text.trim()}${due}${link}`
}

export function parseWaitingLine(
  line: string
): { who: string; text: string; due: string | null; done: boolean } | null {
  const m = LINE_RE.exec(line)
  if (!m) return null
  const rest = m[3]
  const due = DUE_RE.exec(rest)?.[1] ?? null
  const text = rest.replace(DUE_RE, '').replace(LINK_RE, '').trim()
  return { who: m[2].trim(), text, due, done: !!m[1] || !!m[5] }
}

/** Every Waiting On line in your notes (open ones by default), oldest first. */
export function listWaiting(db: Db, opts: { includeDone?: boolean } = {}): WaitingItem[] {
  const rows = db
    .prepare(
      `SELECT file_path AS path, title, date, body_text AS body FROM notes
        WHERE body_text LIKE '%**Waiting on %' ORDER BY date`
    )
    .all() as { path: string; title: string; date: string; body: string }[]
  const out: WaitingItem[] = []
  for (const r of rows)
    for (const line of r.body.split('\n')) {
      const p = parseWaitingLine(line)
      if (!p || (p.done && !opts.includeDone)) continue
      out.push({ ...p, line: line.trimEnd(), notePath: r.path, noteTitle: r.title, since: r.date })
    }
  return out
}

/** Is this owner you? (No owner = you.) */
export const ownerIsMe = (owner: string | null | undefined, me: string[]): boolean =>
  !owner ||
  ['me', ...me.map((a) => a.toLowerCase())].includes(owner.replace(/^@/, '').trim().toLowerCase())

const ym = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

/**
 * Write a Waiting On line under the "Waiting On" heading: in the given note, the meeting's note,
 * or this month's log note (created on first use).
 */
export async function addWaiting(
  db: Db,
  vault: Vault,
  w: WaitingInput,
  now: Date,
  where: { notePath?: string | null; eventId?: string | null } = {}
): Promise<{ path: string }> {
  let path = where.notePath ?? null
  if (!path && where.eventId) path = await openEventNote(db, vault, where.eventId)
  if (!path) {
    const key = `waiting.log.${ym(now)}`
    path =
      (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)
        ?.value ?? null
    if (!path) {
      path = await vault.createNote({
        kind: 'adhoc',
        title: `Waiting On ${ym(now)}`,
        date: `${ym(now)}-01`
      })
      db.prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(key, path)
    }
  }
  const { content, hash } = await vault.readNote(path)
  await vault.saveNote(path, addUnderHeading(content, WAITING_HEADING, formatWaitingLine(w)), hash)
  return { path }
}

/** Got it: strike the line through and date it, so it leaves the Waiting On list. */
export async function markReceived(
  vault: Vault,
  path: string,
  line: string,
  today: string
): Promise<boolean> {
  const { content, hash } = await vault.readNote(path)
  const lines = content.split('\n')
  const i = lines.findIndex((l) => l.trimEnd() === line.trimEnd())
  if (i < 0) return false
  const m = /^(\s*[-*]\s+)(.*)$/.exec(lines[i])
  if (!m) return false
  lines[i] = `${m[1]}~~${m[2].trimEnd()}~~ ✓ ${today}`
  await vault.saveNote(path, lines.join('\n'), hash)
  return true
}
