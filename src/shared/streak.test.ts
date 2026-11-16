import { describe, it, expect } from 'vitest'
import { streakOf } from './streak'

const done = (
  y: number,
  m: number,
  d: number,
  isMine = true
): { status: string; completedAt: string; isMine: boolean } => ({
  status: 'completed',
  completedAt: new Date(y, m - 1, d, 14, 0).toISOString(),
  isMine
})

describe('streak', () => {
  it('counts consecutive days back from today', () => {
    expect(
      streakOf([done(2026, 11, 13), done(2026, 11, 12), done(2026, 11, 11)], '2026-11-13')
    ).toBe(3)
  })
  it('keeps the streak alive until today is over, and breaks on a gap', () => {
    expect(streakOf([done(2026, 11, 12), done(2026, 11, 11)], '2026-11-13')).toBe(2)
    expect(streakOf([done(2026, 11, 13), done(2026, 11, 11)], '2026-11-13')).toBe(1)
    expect(streakOf([done(2026, 11, 10)], '2026-11-13')).toBe(0)
  })
  it('ignores other people’s tasks and open tasks', () => {
    expect(streakOf([done(2026, 11, 13, false)], '2026-11-13')).toBe(0)
    expect(streakOf([{ status: 'open', completedAt: null, isMine: true }], '2026-11-13')).toBe(0)
  })
})
