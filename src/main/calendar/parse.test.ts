import { describe, it, expect } from 'vitest'
import { decodeDatekey, parseTimeLine, parseChip, parseChips } from './parse'

describe('calendar parsing', () => {
  it('decodes Google datekeys (verified against observed Nov 13/16 2026)', () => {
    expect(decodeDatekey(29037)).toBe('2026-11-13')
    expect(decodeDatekey(29040)).toBe('2026-11-16')
    expect(decodeDatekey(29042)).toBe('2026-11-18')
    expect(decodeDatekey(0)).toBeNull()
  })

  it('parses time ranges including shared and mixed am/pm', () => {
    expect(parseTimeLine('9 – 10am')).toEqual({ start: '09:00', end: '10:00' })
    expect(parseTimeLine('9:30 – 9:55am')).toEqual({ start: '09:30', end: '09:55' })
    expect(parseTimeLine('11:30am – 12pm')).toEqual({ start: '11:30', end: '12:00' })
    expect(parseTimeLine('12:45 – 1pm')).toEqual({ start: '12:45', end: '13:00' })
    expect(parseTimeLine('1:15 – 3pm')).toEqual({ start: '13:15', end: '15:00' })
    expect(parseTimeLine('11 – 1pm')).toEqual({ start: '11:00', end: '13:00' })
    expect(parseTimeLine('8am')).toEqual({ start: '08:00', end: '08:00' })
    expect(parseTimeLine('9 – 10am')).toEqual({ start: '09:00', end: '10:00' }) // narrow nbsp
    expect(parseTimeLine('All day')).toBeNull()
  })

  it('classifies chips: meeting, declined, task, working location, all-day', () => {
    const base = { id: 'abc', datekey: 29037 }
    expect(
      parseChip({ ...base, lines: ['9 – 10am', 'Team sync', 'Jacob Benjamin, Declined'] })
    ).toMatchObject({ title: 'Team sync', status: 'declined', kind: 'meeting', startTime: '09:00' })
    expect(
      parseChip({ ...base, lines: ['10 – 10:30am', 'Weekly 1:1', 'Jacob Benjamin, Accepted'] })
    ).toMatchObject({ status: 'accepted', kind: 'meeting', endTime: '10:30' })
    expect(
      parseChip({ ...base, lines: ['8am', 'Submit Timesheet', 'Calendar: Tasks, Accepted'] })
    ).toMatchObject({ kind: 'task' })
    expect(
      parseChip({ ...base, lines: ['All day', 'Office', 'Jacob Benjamin, Accepted'] })
    ).toMatchObject({ kind: 'working_location', allDay: true, startTime: null })
    expect(
      parseChip({ ...base, lines: ['All day', 'Company holiday', 'Calendar: Holidays'] })
    ).toMatchObject({
      kind: 'allday'
    })
    // Organizer-owned events may have no RSVP line; extra lines (location) must not become the title.
    expect(parseChip({ ...base, lines: ['2 – 3pm', 'Design review', 'Room 4'] })).toMatchObject({
      title: 'Design review',
      status: null
    })
  })

  it('rejects junk and de-duplicates the double-rendered chips', () => {
    expect(parseChip({ id: 'x', datekey: 29037, lines: ['hello'] })).toBeNull()
    expect(parseChip({ id: 'x', datekey: 1, lines: ['9 – 10am', 'T'] })).toBeNull()
    const c = { id: 'abc', datekey: 29037, lines: ['9 – 10am', 'Sync', 'Me, Accepted'] }
    expect(parseChips([c, { ...c }, { ...c, datekey: 29040 }])).toHaveLength(2)
  })
})

import { ownerNameFromChips } from './parse'

describe('calendar owner name', () => {
  const chip = (last: string, id = 'x'): { id: string; datekey: number; lines: string[] } => ({
    id,
    datekey: 29037,
    lines: ['9 – 10am', 'Sync', last]
  })
  it('learns the most frequent RSVP name and ignores tasks and one-offs', () => {
    const chips = [
      chip('Jacob Benjamin, Accepted'),
      chip('Jacob Benjamin, Declined'),
      chip('Jacob Benjamin, Accepted'),
      chip('Calendar: Tasks, Accepted'),
      chip('Calendar: Tasks, Accepted'),
      chip('Calendar: Tasks, Accepted'),
      chip('Somebody Else, Accepted')
    ]
    expect(ownerNameFromChips(chips)).toBe('Jacob Benjamin')
    expect(ownerNameFromChips(chips.slice(3, 5))).toBeNull() // too few / not a person
    expect(ownerNameFromChips([])).toBeNull()
  })
})
