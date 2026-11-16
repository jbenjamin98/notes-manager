import { describe, expect, it } from 'vitest'
import { openDb } from '../../db'
import { ingestChat } from '../../chat/ingest'
import { localRoute } from './router'

const ago = (h: number): string =>
  new Date(Date.now() - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)
const base = {
  spaceName: 'DM',
  spaceType: 'dm' as const,
  senderId: 'u',
  thread: null,
  mentionsMe: false
}

describe('local router', () => {
  it('answers chat lookups with no model', () => {
    const db = openDb(':memory:')
    ingestChat(db, [
      {
        ...base,
        id: '1',
        space: 'a',
        sender: 'Priya',
        text: 'Can you approve?',
        createdAt: ago(6),
        fromMe: false
      },
      {
        ...base,
        id: '2',
        space: 'b',
        sender: 'Me',
        text: 'Did legal sign off?',
        createdAt: ago(30),
        fromMe: true
      }
    ])
    expect(localRoute(db, 'Which chats are waiting on me?')?.text).toContain('Priya')
    expect(localRoute(db, 'Who am I waiting on in chat?')?.text).toContain('waiting on 1')
    expect(localRoute(db, 'What do I have on the calendar next?')).toBeNull()
    expect(localRoute(db, 'when is my next meeting?')?.text).toContain('no upcoming')
    expect(localRoute(db, 'Summarize the Acme project')).toBeNull()
  })
})
