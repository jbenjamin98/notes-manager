import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { ingestChat } from './ingest'
import { recordFeedback, triage, loadWeights } from './triage'
import type { ChatIn } from './types'

const NOW = new Date('2026-11-14T15:00:00Z')
const at = (hoursAgo: number): string =>
  new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)

const m = (o: Partial<ChatIn> & { id: string; hoursAgo: number }): ChatIn => ({
  space: 'spaces/dm1',
  spaceName: 'Direct message',
  spaceType: 'dm',
  sender: 'Priya',
  senderId: 'users/priya',
  text: 'hi',
  createdAt: at(o.hoursAgo),
  thread: null,
  mentionsMe: false,
  fromMe: false,
  ...o
})

function seed(msgs: ChatIn[]): ReturnType<typeof openDb> {
  const db = openDb(':memory:')
  // created_at must stay inside the 14-day window used by triage(), which reads real "now".
  ingestChat(db, msgs)
  return db
}

describe('chat triage', () => {
  it('a question in a DM that I have not answered needs me', () => {
    const db = seed([m({ id: '1', hoursAgo: 5, text: 'Can you send the SOW today?' })])
    const { conversations } = triage(db, { now: new Date() })
    const c = conversations[0]
    expect(c.bucket).toBe('needs-you')
    expect(c.reasons).toEqual(expect.arrayContaining(['dm', 'question', 'deadline', 'unanswered']))
    expect(c.awaitingMeHours).toBeGreaterThan(0)
  })

  it('my unanswered question becomes "waiting on them"', () => {
    const db = seed([
      m({ id: '1', hoursAgo: 30, fromMe: true, text: 'Did legal approve the contract?' })
    ])
    const c = triage(db, { now: new Date() }).conversations[0]
    expect(c.bucket).toBe('waiting')
    expect(c.awaitingThemHours).toBeGreaterThan(8)
  })

  it('once I answer, it is no longer waiting on me', () => {
    const db = seed([
      m({ id: '1', hoursAgo: 6, text: 'Can you review?' }),
      m({ id: '2', hoursAgo: 5, fromMe: true, text: 'Done, approved.' })
    ])
    const c = triage(db, { now: new Date() }).conversations[0]
    expect(c.awaitingMeHours).toBe(0)
    expect(c.bucket).toBe('noise')
  })

  it('chatter in a space I only follow by mention never appears; a mention does', () => {
    const db = seed([
      m({
        id: 'a',
        space: 'spaces/s',
        spaceType: 'space',
        spaceName: 'Eng',
        hoursAgo: 3,
        text: 'lunch?'
      }),
      m({
        id: 'b',
        space: 'spaces/s',
        spaceType: 'space',
        spaceName: 'Eng',
        hoursAgo: 3,
        text: '@me please look at the deploy',
        mentionsMe: true,
        thread: 't9'
      })
    ])
    const list = triage(db, { now: new Date() }).conversations
    expect(list).toHaveLength(1)
    expect(list[0].reasons).toContain('mention')
  })

  it('splits DM conversations at long silences', () => {
    const db = seed([
      m({ id: '1', hoursAgo: 60, text: 'old thing' }),
      m({ id: '2', hoursAgo: 3, text: 'new thing' })
    ])
    expect(triage(db, { now: new Date() }).conversations).toHaveLength(2)
  })

  it('finds my commitments', () => {
    const db = seed([
      m({ id: '1', hoursAgo: 4, text: 'Can you share the deck?' }),
      m({ id: '2', hoursAgo: 3, fromMe: true, text: "I'll send the deck after lunch" })
    ])
    const { commitments } = triage(db, { now: new Date() })
    expect(commitments).toHaveLength(1)
    expect(commitments[0].text).toContain('deck')
  })

  it('feedback moves weights, within bounds', () => {
    const db = seed([m({ id: '1', hoursAgo: 5, text: 'FYI only' })])
    for (let i = 0; i < 40; i++) recordFeedback(db, 'k', ['dm'], false)
    expect(loadWeights(db).dm).toBe(0.2)
    for (let i = 0; i < 80; i++) recordFeedback(db, 'k', ['dm'], true)
    expect(loadWeights(db).dm).toBe(6)
  })
})
