import { describe, it, expect } from 'vitest'
import { groupNotes, weekStartOf, type LibNote } from './library'

const NOW = new Date(2026, 10, 13, 10, 0) // Fri 13 Nov 2026

const n = (path: string, title: string, date: string, extra: Partial<LibNote> = {}): LibNote => ({
  path,
  title,
  date,
  type: 'meeting',
  account: null,
  openTasks: 0,
  isConflict: false,
  entities: [],
  ...extra
})

const sarah = { id: 'person:sarah', name: 'Sarah Chen', category: 'person' }
const navy = { id: 'customer:navy', name: 'Navy', category: 'customer' }

const notes: LibNote[] = [
  n('a', 'NextMRO Weekly 11/13', '2026-11-13', {
    account: 'Navy',
    entities: [sarah, navy],
    openTasks: 2
  }),
  n('b', 'NextMRO Weekly 11/6', '2026-11-06', { account: 'Navy', entities: [navy] }),
  n('c', 'NextMRO Weekly 10/30', '2026-10-30', {
    account: 'Navy',
    entities: [sarah, navy],
    openTasks: 1
  }),
  n('d', 'Budget one-off', '2026-11-12', { account: 'Finance' }),
  n('e', 'Brain dump', '2026-09-02', { type: 'adhoc', entities: [sarah] }),
  n('f', 'Inbox 2026-11', '2026-11-01', { type: 'inbox' })
]

describe('library grouping', () => {
  it('keeps nothing out but the task inbox, and never loses a note across views', () => {
    for (const v of ['newest', 'weeks', 'subjects'] as const) {
      const paths = groupNotes(v, notes, { now: NOW }).flatMap((g) => g.notes.map((x) => x.path))
      expect(paths.sort()).toEqual(['a', 'b', 'c', 'd', 'e']) // old notes are never cut off
    }
  })

  it('newest: newest to oldest in relative buckets, then months', () => {
    const g = groupNotes('newest', notes, { now: NOW })
    expect(g.map((x) => x.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Previous 30 days',
      'September 2026'
    ])
    expect(g[0].notes[0].path).toBe('a')
  })

  it('weeks: Monday-first, newest first, friendly names for this and last week', () => {
    expect(weekStartOf('2026-11-13')).toBe('2026-11-09')
    const g = groupNotes('weeks', notes, { now: NOW })
    expect(g.map((x) => x.label)).toEqual([
      'This week',
      'Last week',
      'Oct 26 – Nov 1',
      'Aug 31 – Sep 6'
    ])
    expect(g[0].notes.map((x) => x.path)).toEqual(['a', 'd'])
  })

  it('meetings: recurring series together (dates ignored), one-offs gathered at the end', () => {
    const g = groupNotes('meetings', notes, { now: NOW })
    expect(g[0].label).toBe('NextMRO Weekly 11/13')
    expect(g[0].notes.map((x) => x.path)).toEqual(['a', 'b', 'c'])
    expect(g[0].sub).toBe('3 meetings · last Nov 13')
    expect(g[1]).toMatchObject({ label: 'One-off meetings' })
    expect(g[1].notes.map((x) => x.path)).toEqual(['d'])
  })

  it('accounts: by account with unassigned last', () => {
    const g = groupNotes('subjects', notes, { now: NOW })
    expect(g.map((x) => x.label)).toEqual(['Navy', 'Finance', 'No account'])
  })

  it('people & things: a note appears under every person/thing it mentions, busiest first, filterable by kind', () => {
    const g = groupNotes('people', notes, { now: NOW })
    expect(g.map((x) => x.label)).toEqual(['Navy', 'Sarah Chen'])
    expect(g[0].notes).toHaveLength(3)
    expect(g[1].notes.map((x) => x.path)).toEqual(['a', 'c', 'e'])
    expect(
      groupNotes('people', notes, { now: NOW, category: 'person' }).map((x) => x.label)
    ).toEqual(['Sarah Chen'])
  })

  it('open tasks: only notes with work left, most first', () => {
    const g = groupNotes('tasks', notes, { now: NOW })
    expect(g[0].notes.map((x) => x.path)).toEqual(['a', 'c'])
    expect(g[0].sub).toBe('3 open tasks in 2 notes')
    expect(groupNotes('tasks', [n('z', 'Done', '2026-11-01')], { now: NOW })).toEqual([])
  })

  it('also matches notes found by full-text search of their body', () => {
    const g = groupNotes('newest', notes, {
      now: NOW,
      query: 'zzz-not-in-titles',
      extraPaths: new Set(['b'])
    })
    expect(g.flatMap((x) => x.notes.map((n) => n.path))).toEqual(['b'])
  })

  it('search and type filters apply to every view (title, account or mentioned name)', () => {
    expect(
      groupNotes('newest', notes, { now: NOW, query: 'sarah' })
        .flatMap((g) => g.notes.map((x) => x.path))
        .sort()
    ).toEqual(['a', 'c', 'e'])
    expect(groupNotes('newest', notes, { now: NOW, query: 'finance' })[0].notes[0].path).toBe('d')
    expect(
      groupNotes('newest', notes, { now: NOW, type: 'adhoc' }).flatMap((g) =>
        g.notes.map((x) => x.path)
      )
    ).toEqual(['e'])
  })
})
