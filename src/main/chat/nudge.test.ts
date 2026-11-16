import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { ingestChat } from './ingest'
import { chatNeedsYou, type Env } from '../nudges/rules'

const ago = (h: number): string =>
  new Date(Date.now() - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)

describe('chat nudge', () => {
  it('fires once per conversation waiting 4+ hours, not for fresh or answered ones', () => {
    const db = openDb(':memory:')
    const base = {
      space: 's1',
      spaceName: 'DM',
      spaceType: 'dm' as const,
      senderId: 'u1',
      thread: null,
      mentionsMe: false,
      fromMe: false
    }
    ingestChat(db, [
      { ...base, id: '1', sender: 'Priya', text: 'Can you approve this?', createdAt: ago(6) },
      { ...base, id: '2', space: 's2', sender: 'Joe', text: 'Can you look?', createdAt: ago(1) }
    ])
    // A weekday at midday in the user's local clock.
    const now = new Date()
    now.setDate(now.getDate() - ((now.getDay() + 6) % 7)) // Monday of this week
    now.setHours(12, 0, 0, 0)
    const env = { now, db, workStartMin: 480, workEndMin: 1080 } as unknown as Env
    const out = chatNeedsYou(env)
    expect(out).toHaveLength(1)
    expect(out[0].title).toContain('Priya')
    expect(out[0].actions[0].type).toBe('open-chat')
  })
})
