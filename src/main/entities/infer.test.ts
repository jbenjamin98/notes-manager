import { describe, it, expect } from 'vitest'
import { buildPersonIndex, findMentions, inferDue, inferOwner } from './infer'

const ME = new Set(['me', 'jacob', 'jacob benjamin'])
const idx = buildPersonIndex(
  [
    { name: 'Sarah Chen', aliases: ['SC'] },
    { name: 'Joe Park' },
    { name: 'Priya Nair' },
    { name: 'Will Turner' }, // "Will" is also an everyday word
    { name: 'Jacob Benjamin' }, // me
    { name: 'Alex Kim' },
    { name: 'Alex Rivera' } // ambiguous first name
  ],
  ME
)

describe('person index', () => {
  it('maps full names, aliases and unambiguous first names; skips me, everyday words and shared first names', () => {
    expect(idx.lookup.get('sarah chen')).toBe('Sarah Chen')
    expect(idx.lookup.get('sc')).toBe('Sarah Chen')
    expect(idx.lookup.get('sarah')).toBe('Sarah Chen')
    expect(idx.lookup.get('joe')).toBe('Joe Park')
    expect(idx.lookup.has('will')).toBe(false) // everyday word
    expect(idx.lookup.get('will turner')).toBe('Will Turner') // full name still fine
    expect(idx.lookup.has('alex')).toBe(false) // two Alexes
    expect(idx.lookup.has('jacob')).toBe(false)
    expect(idx.lookup.has('jacob benjamin')).toBe(false)
  })

  it('finds capitalised mentions with exact offsets, preferring the longest name', () => {
    const t = 'Met with Sarah Chen and joe about Priya'
    const m = findMentions(t, idx)
    expect(m.map((x) => x.name)).toEqual(['Sarah Chen', 'Priya Nair']) // lowercase "joe" is not a name here
    expect(t.slice(m[0].start, m[0].end)).toBe('Sarah Chen')
    expect(t.slice(m[1].start, m[1].end)).toBe('Priya')
    expect(findMentions('Sarah to check', idx)[0]).toMatchObject({
      name: 'Sarah Chen',
      start: 0,
      end: 5
    })
  })
})

describe('owner inference', () => {
  it.each([
    ['Remind Sarah to update the firewall rules', 'Sarah Chen'],
    ['Ask Joe to review the checklist', 'Joe Park'],
    ['Have Priya send the deck', null], // "Have X send": no "to" -> not matched (kept conservative)
    ['Sarah to verify the firewall', 'Sarah Chen'],
    ['Joe will send the revised estimate', 'Joe Park'],
    ['Update the runbook - Joe to review', 'Joe Park'],
    ['Waiting on Priya for the budget numbers', 'Priya Nair'],
    ['Waiting for Sarah Chen to confirm', 'Sarah Chen']
  ])('%s -> %s', (text, owner) => {
    expect(inferOwner(text, idx)).toBe(owner)
  })

  it('leaves my own tasks alone: talking ABOUT someone, or me doing it', () => {
    expect(inferOwner('Call Sarah about the cutover', idx)).toBeNull() // I call her
    expect(inferOwner('Ask Sarah about the firewall', idx)).toBeNull() // asking, not delegating
    expect(inferOwner('Send Priya the deck', idx)).toBeNull()
    expect(inferOwner('Review the plan with Joe', idx)).toBeNull()
    expect(inferOwner('Jacob to review the plan', idx)).toBeNull() // me
    expect(inferOwner('Will we ship on Friday?', idx)).toBeNull() // "Will" is not a person
    expect(inferOwner('Remind them to update things', idx)).toBeNull()
  })
})

describe('due inference', () => {
  // A note written on Friday 13 Nov 2026
  const ref = new Date(2026, 10, 13)
  it.each([
    ['Update the firewall rules by Tuesday', '2026-11-17'],
    ['Send the deck tomorrow', '2026-11-14'],
    ['Review checklist next Thursday', '2026-11-19'],
    ['Finish the draft on Nov 20', '2026-11-20'],
    ['Check in on Monday', '2026-11-16'],
    ['Submit timesheet today', '2026-11-13']
  ])('%s -> %s', (text, due) => {
    expect(inferDue(text, ref)).toBe(due)
  })

  it('ignores bare months, numbers, far-away dates and ordinary prose', () => {
    expect(inferDue('Review May roadmap', ref)).toBeNull()
    expect(inferDue('Call 5 vendors', ref)).toBeNull()
    expect(inferDue('Fix the Tuesday standup agenda', ref)).toBe('2026-11-17') // weekday word is a clear day
    expect(inferDue('Plan the offsite for Nov 20, 2031', ref)).toBeNull() // beyond 120 days
    expect(inferDue('Just think about it', ref)).toBeNull()
  })
})
