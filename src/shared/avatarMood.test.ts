import { describe, expect, it } from 'vitest'
import {
  initialMood,
  MOOD_MS,
  pickQuirk,
  stepMood,
  type MoodEvent,
  type MoodState
} from './avatarMood'

const run = (events: [number, MoodEvent['type']][], start = initialMood(0)): MoodState =>
  events.reduce((s, [t, type]) => stepMood(s, { type } as MoodEvent, t), start)

describe('assistant mood', () => {
  it('listens while you type, then relaxes', () => {
    const s = run([[100, 'typing']])
    expect(s.mood).toBe('listening')
    expect(
      run([
        [100, 'typing'],
        [100 + MOOD_MS.listening + 1, 'tick']
      ]).mood
    ).toBe('idle')
  })

  it('thinks until the reply starts, talks while it types out, then smiles', () => {
    let s = run([[0, 'send']])
    expect(s.mood).toBe('thinking')
    s = stepMood(s, { type: 'tick' }, 5000)
    expect(s.mood).toBe('thinking') // no timeout while waiting
    s = stepMood(s, { type: 'talk' }, 6000)
    expect(s.mood).toBe('talking')
    s = stepMood(s, { type: 'talk' }, 6400)
    s = stepMood(s, { type: 'tick' }, 6500)
    expect(s.mood).toBe('talking')
    s = stepMood(s, { type: 'tick' }, 6400 + MOOD_MS.talkTail + 1)
    expect(s.mood).toBe('happy')
    s = stepMood(s, { type: 'tick' }, 9000)
    expect(s.mood).toBe('idle')
  })

  it('typing does not interrupt thinking', () => {
    expect(
      run([
        [0, 'send'],
        [10, 'typing']
      ]).mood
    ).toBe('thinking')
  })

  it('an error looks concerned, then recovers', () => {
    const s = run([
      [0, 'send'],
      [500, 'error']
    ])
    expect(s.mood).toBe('concerned')
    expect(s.busy).toBe(false)
    expect(stepMood(s, { type: 'tick' }, 500 + MOOD_MS.concerned).mood).toBe('idle')
  })

  it('a proactive message surprises, but not twice in a row', () => {
    const s = run([[1000, 'proactive']])
    expect(s.mood).toBe('surprised')
    const again = run(
      [
        [1000 + MOOD_MS.surprised, 'tick'],
        [5000, 'proactive']
      ],
      s
    )
    expect(again.mood).toBe('idle')
  })

  it('dozes off after a long quiet spell and stretches when you come back', () => {
    let s = stepMood(initialMood(0), { type: 'tick' }, MOOD_MS.sleepAfter + 1)
    expect(s.mood).toBe('sleepy')
    s = stepMood(s, { type: 'typing' }, MOOD_MS.sleepAfter + 5000)
    expect(s.mood).toBe('waking')
    s = stepMood(s, { type: 'tick' }, MOOD_MS.sleepAfter + 5000 + MOOD_MS.waking)
    expect(s.mood).toBe('idle')
  })

  it('a task added makes it happy', () => {
    expect(run([[0, 'success']]).mood).toBe('happy')
  })
})

describe('quirks', () => {
  it('respects cool-downs and the mood', () => {
    expect(pickQuirk('talking', {}, 0)).toBeNull()
    expect(
      pickQuirk('idle', { wink: 0, glance: 0, signature: 0, 'double-blink': 0 }, 1000)
    ).toBeNull()
    expect(pickQuirk('idle', { wink: 0, glance: 5000, signature: 0 }, 13_000, () => 0)).toBe(
      'double-blink'
    )
    expect(pickQuirk('listening', { glance: 0, signature: 0, 'double-blink': 0 }, 1000)).toBeNull()
  })
})
