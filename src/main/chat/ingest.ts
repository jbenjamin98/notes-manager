import type { Db } from '../db'
import type { ChatIn, SpaceMode } from './types'

/**
 * Storing Chat messages. Volume is high and only some of it matters, so this keeps only what the
 * user asked to follow: the space mode decides (DMs and group chats: everything; spaces: only
 * mentions of me, replies in threads I wrote in, and my own messages). Text is kept
 * on this computer only, for two weeks (the insights drawn from it stay).
 */
export const RETENTION_DAYS = 14

export const hasQuestion = (t: string): boolean =>
  /\?\s*($|[)"'\]])/.test(t) ||
  /\b(can|could|would|will|do|did|are|is|have|has) (you|u|we)\b/i.test(t)

export function effectiveMode(type: string, mode: string): SpaceMode {
  if (mode === 'track' || mode === 'mentions' || mode === 'ignore') return mode
  return type === 'space' ? 'mentions' : 'track'
}

export function ingestChat(db: Db, msgs: ChatIn[]): { stored: number; skipped: number } {
  if (msgs.length === 0) return { stored: 0, skipped: 0 }
  const modeOf = new Map(
    (
      db.prepare('SELECT space, mode FROM chat_spaces').all() as { space: string; mode: string }[]
    ).map((r) => [r.space, r.mode])
  )
  // Threads where I have written something: replies there matter even in "mentions only" spaces.
  const mine = new Set<string>()
  for (const m of msgs) if (m.fromMe && m.thread) mine.add(`${m.space}|${m.thread}`)
  for (const r of db
    .prepare(
      'SELECT DISTINCT space, thread FROM chat_messages WHERE from_me = 1 AND thread IS NOT NULL'
    )
    .all() as { space: string; thread: string }[])
    mine.add(`${r.space}|${r.thread}`)

  const upSpace = db.prepare(
    `INSERT INTO chat_spaces (space, name, type, last_at) VALUES (?,?,?,?)
     ON CONFLICT(space) DO UPDATE SET name = excluded.name, type = excluded.type,
       last_at = max(coalesce(chat_spaces.last_at, ''), excluded.last_at)`
  )
  const up = db.prepare(
    `INSERT INTO chat_messages (id, space, space_name, space_type, sender, sender_id, text, created_at, thread, from_me, mentions_me, has_question, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET text = excluded.text, mentions_me = excluded.mentions_me, thread = excluded.thread`
  )
  let stored = 0
  let skipped = 0
  db.exec('BEGIN')
  try {
    for (const m of msgs) {
      upSpace.run(m.space, m.spaceName, m.spaceType, m.createdAt)
      const mode = effectiveMode(m.spaceType, modeOf.get(m.space) ?? 'auto')
      const relevant =
        m.fromMe || m.mentionsMe || (m.thread !== null && mine.has(`${m.space}|${m.thread}`))
      if (mode === 'ignore' || (mode === 'mentions' && !relevant)) {
        skipped++
        continue
      }
      const text = m.text.replace(/\s+/g, ' ').trim().slice(0, 4000)
      up.run(
        m.id,
        m.space,
        m.spaceName,
        m.spaceType,
        m.sender,
        m.senderId,
        text,
        m.createdAt,
        m.thread,
        m.fromMe ? 1 : 0,
        m.mentionsMe ? 1 : 0,
        hasQuestion(text) ? 1 : 0,
        'chat'
      )
      stored++
    }
    db.exec(
      `DELETE FROM chat_messages WHERE created_at < datetime('now','-${RETENTION_DAYS} days')`
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { stored, skipped }
}
