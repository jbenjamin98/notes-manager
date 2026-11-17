import { describe, it, expect } from 'vitest'
import { parseQuickAdd, formatTaskLine } from './quickadd'

// Friday, 13 Nov 2026
const NOW = new Date(2026, 10, 13, 9, 0, 0)

describe('quick-add parsing', () => {
  it('pulls out priority, estimate and a relative date, and keeps @tags in the text', () => {
    expect(parseQuickAdd('Send deck for @Joe Brown tomorrow !high ~30m', NOW)).toEqual({
      description: 'Send deck for @Joe Brown',
      owner: 'Me',
      due: '2026-11-14',
      priority: 'High',
      estMinutes: 30,
      ownerExplicit: false
    })
  })

  it('an @Name never makes someone else the owner (people, companies, places, systems)', () => {
    for (const t of [
      'Finish onboarding for @John Smith',
      'Review contract with @Acme',
      'Visit @Denver',
      'Patch @Okta'
    ])
      expect(parseQuickAdd(t, NOW)).toMatchObject({
        owner: 'Me',
        ownerExplicit: false,
        description: t
      })
  })

  it('handles weekdays, dangling "by", and defaults to me', () => {
    expect(parseQuickAdd('Update the firewall rules by Tuesday', NOW)).toMatchObject({
      description: 'Update the firewall rules',
      owner: 'Me',
      due: '2026-11-17'
    })
    expect(parseQuickAdd('Review checklist next Thursday', NOW).due).toBe('2026-11-19')
    expect(parseQuickAdd('Plan offsite Nov 20', NOW).due).toBe('2026-11-20')
  })

  it('supports explicit due:, compound estimates and short priorities', () => {
    expect(parseQuickAdd('Write spec due:2026-12-01 !m ~1h30m', NOW)).toMatchObject({
      description: 'Write spec',
      due: '2026-12-01',
      priority: 'Medium',
      estMinutes: 90
    })
  })

  it('does not invent dates from bare numbers or times, and keeps plain text intact', () => {
    expect(parseQuickAdd('Call 5 vendors', NOW)).toMatchObject({
      description: 'Call 5 vendors',
      due: null
    })
    expect(parseQuickAdd('Sync at 5pm', NOW).due).toBeNull()
    expect(parseQuickAdd('Just a thought', NOW)).toEqual({
      description: 'Just a thought',
      owner: 'Me',
      due: null,
      priority: null,
      estMinutes: null,
      ownerExplicit: false
    })
  })

  it('never lets a pipe break the inline syntax; empty input yields an empty description', () => {
    expect(parseQuickAdd('A | B', NOW).description).toBe('A / B')
    expect(parseQuickAdd('   ', NOW).description).toBe('')
  })

  it('formats the inline task line', () => {
    expect(
      formatTaskLine({
        description: 'Send deck',
        owner: 'Joe',
        due: '2026-11-14',
        priority: 'High',
        estMinutes: 90
      })
    ).toBe('- [ ] Send deck | @Joe | due:2026-11-14 | priority:High | est:1h30m')
    expect(
      formatTaskLine({
        description: 'Think',
        owner: 'Me',
        due: null,
        priority: null,
        estMinutes: null
      })
    ).toBe('- [ ] Think') // no @Me written: wording ("Remind Sarah to...") can decide the owner
    expect(
      formatTaskLine({
        description: 'Mine',
        owner: 'Me',
        due: null,
        priority: null,
        estMinutes: null,
        ownerExplicit: true
      })
    ).toBe('- [ ] Mine | @Me') // an explicit @Me is kept
  })
})
