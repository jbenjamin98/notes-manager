import { describe, it, expect } from 'vitest'
import { instantFromWall, todayIn, wallClock } from './tz'

describe('time zone', () => {
  // 2026-11-13 03:30 UTC is still the 12th (10:30 PM) in New York and already 12:30 PM in Tokyo.
  const instant = new Date('2026-11-13T03:30:00Z')

  it('reads the wall clock in the chosen zone, whatever the computer uses', () => {
    const ny = wallClock(instant, 'America/New_York')
    expect([ny.getFullYear(), ny.getMonth(), ny.getDate(), ny.getHours(), ny.getMinutes()]).toEqual(
      [2026, 10, 12, 22, 30]
    )
    const tokyo = wallClock(instant, 'Asia/Tokyo')
    expect([tokyo.getDate(), tokyo.getHours()]).toEqual([13, 12])
  })

  it("gives the zone's own date for 'today'", () => {
    expect(todayIn('America/New_York', instant)).toBe('2026-11-12')
    expect(todayIn('Asia/Tokyo', instant)).toBe('2026-11-13')
  })

  it('falls back to the given date for a missing or unknown zone', () => {
    expect(wallClock(instant)).toBe(instant)
    expect(wallClock(instant, 'Not/AZone')).toBe(instant)
  })

  it('round-trips: 3 PM in New York is the right instant, across the daylight-saving change', () => {
    for (const day of [13, 1]) {
      const month = day === 13 ? 10 : 2 // Nov (EST) and Mar (EST -> EDT around the 8th)
      const wall = new Date(2026, month, day, 15, 0, 0)
      const inst = instantFromWall(wall, 'America/New_York')
      const back = wallClock(inst, 'America/New_York')
      expect([back.getDate(), back.getHours(), back.getMinutes()]).toEqual([day, 15, 0])
    }
    expect(instantFromWall(new Date(2026, 10, 13, 15, 0), 'America/New_York').toISOString()).toBe(
      '2026-11-13T20:00:00.000Z'
    )
  })
})
