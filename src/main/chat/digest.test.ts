import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { ingestChat } from './ingest'
import { chatDigestText } from './digest'

const ago = (h: number): string =>
  new Date(Date.now() - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)

describe('chat digest', () => {
  it('is null when there is nothing, and lists what waits on me otherwise', () => {
    const db = openDb(':memory:')
    expect(chatDigestText(db)).toBeNull()
    ingestChat(db, [
      {
        id: '1',
        space: 'a',
        spaceName: 'DM',
        spaceType: 'dm',
        sender: 'Priya',
        senderId: 'u',
        text: 'Can you approve the SOW today?',
        createdAt: ago(6),
        thread: null,
        mentionsMe: false,
        fromMe: false
      }
    ])
    const t = chatDigestText(db)!
    expect(t).toContain('Waiting on me')
    expect(t).toContain('Priya')
  })

  it('keeps long messages whole instead of cutting at 500 characters', () => {
    const db = openDb(':memory:')
    const long = 'word '.repeat(300).trim()
    ingestChat(db, [
      {
        id: 'L',
        space: 'a',
        spaceName: 'DM',
        spaceType: 'dm',
        sender: 'Priya',
        senderId: 'u',
        text: long,
        createdAt: ago(1),
        thread: null,
        mentionsMe: false,
        fromMe: false
      }
    ])
    const r = db.prepare('SELECT length(text) AS n FROM chat_messages WHERE id = ?').get('L') as {
      n: number
    }
    expect(r.n).toBe(long.length)
  })
})
