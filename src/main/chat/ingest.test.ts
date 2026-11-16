import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { effectiveMode, hasQuestion, ingestChat } from './ingest'
import type { ChatIn } from './types'

const msg = (o: Partial<ChatIn> & { id: string }): ChatIn => ({
  space: 'spaces/a',
  spaceName: 'Team',
  spaceType: 'space',
  sender: 'Priya',
  senderId: null,
  text: 'hello',
  createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  thread: null,
  mentionsMe: false,
  fromMe: false,
  ...o
})

describe('chat ingest', () => {
  it('defaults: DMs and groups tracked, spaces mentions-only', () => {
    expect(effectiveMode('dm', 'auto')).toBe('track')
    expect(effectiveMode('group', 'auto')).toBe('track')
    expect(effectiveMode('space', 'auto')).toBe('mentions')
    expect(effectiveMode('space', 'ignore')).toBe('ignore')
  })

  it('keeps only relevant messages in a space', () => {
    const db = openDb(':memory:')
    const r = ingestChat(db, [
      msg({ id: '1', text: 'lunch?' }),
      msg({ id: '2', text: '@me can you review?', mentionsMe: true }),
      msg({ id: '3', text: 'on it', fromMe: true, thread: 't1' }),
      msg({ id: '4', text: 'thanks!', thread: 't1' }),
      msg({ id: '5', text: 'other thread', thread: 't2' })
    ])
    expect(r).toEqual({ stored: 3, skipped: 2 })
    const ids = (
      db.prepare('SELECT id FROM chat_messages ORDER BY id').all() as { id: string }[]
    ).map((x) => x.id)
    expect(ids).toEqual(['2', '3', '4'])
  })

  it('stores everything in DMs, flags questions, honors ignore, and expires old rows', () => {
    const db = openDb(':memory:')
    ingestChat(db, [
      msg({ id: 'd1', space: 'spaces/dm', spaceType: 'dm', text: 'Can you send the deck?' })
    ])
    const row = db.prepare('SELECT has_question q FROM chat_messages WHERE id = ?').get('d1') as {
      q: number
    }
    expect(row.q).toBe(1)
    db.prepare("UPDATE chat_spaces SET mode = 'ignore' WHERE space = ?").run('spaces/dm')
    expect(ingestChat(db, [msg({ id: 'd2', space: 'spaces/dm', spaceType: 'dm' })]).stored).toBe(0)
    ingestChat(db, [
      msg({ id: 'old', space: 'spaces/g', spaceType: 'group', createdAt: '2020-01-01 00:00:00' })
    ])
    expect(db.prepare("SELECT 1 FROM chat_messages WHERE id = 'old'").get()).toBeUndefined()
  })

  it('detects questions', () => {
    expect(hasQuestion('ready?')).toBe(true)
    expect(hasQuestion('could you look')).toBe(true)
    expect(hasQuestion('done.')).toBe(false)
  })
})
