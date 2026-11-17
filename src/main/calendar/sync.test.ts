import { describe, it, expect } from 'vitest'
import { openDb } from '../db'
import { applyEvents, listUpcoming, CalendarSync } from './sync'
import type { CalEvent } from './parse'

const ev = (
  id: string,
  date: string,
  start: string | null,
  over: Partial<CalEvent> = {}
): CalEvent => ({
  id,
  date,
  startTime: start,
  endTime: start ? '10:00' : null,
  allDay: start === null,
  title: `T-${id}`,
  status: 'accepted',
  kind: 'meeting',
  ...over
})

describe('calendar store', () => {
  it('upserts, removes cancelled events inside the window, and keeps events outside it', () => {
    const db = openDb(':memory:')
    applyEvents(db, [
      ev('a', '2026-11-13', '09:00'),
      ev('b', '2026-11-13', '11:00'),
      ev('c', '2026-11-20', '09:00')
    ])
    // Next sync: 'b' was cancelled, 'a' moved to 10:00, and a new 'd' appeared. Window is 13th..16th.
    const r = applyEvents(db, [ev('a', '2026-11-13', '10:00'), ev('d', '2026-11-16', '14:00')])
    expect(r.removed).toBe(1)
    const ids = listUpcoming(db, '2026-11-01').map((e) => e.id)
    expect(ids).toEqual(['a', 'd', 'c'])
    expect(listUpcoming(db, '2026-11-01')[0].startTime).toBe('10:00')
  })

  it('never wipes the calendar on an empty scrape', () => {
    const db = openDb(':memory:')
    applyEvents(db, [ev('a', '2026-11-13', '09:00')])
    expect(applyEvents(db, [])).toEqual({ upserted: 0, removed: 0 })
    expect(listUpcoming(db, '2026-11-01')).toHaveLength(1)
  })

  it('hides declined, tasks, all-day and working-location from the meeting list; links existing notes', () => {
    const db = openDb(':memory:')
    applyEvents(db, [
      ev('m', '2026-11-13', '09:00'),
      ev('d', '2026-11-13', '10:00', { status: 'declined' }),
      ev('t', '2026-11-13', '08:00', { kind: 'task' }),
      ev('w', '2026-11-13', null, { kind: 'working_location' }),
      ev('h', '2026-11-13', null, { kind: 'allday' })
    ])
    db.prepare(
      "INSERT INTO notes (id,file_path,title,type,date,calendar_event_id) VALUES ('n1','notes/2026/x.md','X','meeting','2026-11-13','m')"
    ).run()
    const list = listUpcoming(db, '2026-11-13')
    expect(list.map((e) => e.id)).toEqual(['m'])
    expect(list[0].notePath).toBe('notes/2026/x.md')
  })
})

describe('CalendarSync', () => {
  const ev = (id: string): CalEvent => ({
    id,
    date: '2026-11-13',
    startTime: '09:00',
    endTime: '10:00',
    allDay: false,
    title: 'Sync ' + id,
    status: 'accepted',
    kind: 'meeting'
  })

  it('syncs, reports needs-auth without touching data, recovers, and shares concurrent runs', async () => {
    const db = openDb(':memory:')
    let signedIn = true
    let calls = 0
    const states: string[] = []
    const s = new CalendarSync(
      db,
      async () => {
        calls++
        return {
          signedIn,
          events: [ev('a'), ev('a'), ev('b')],
          details: [],
          owner: null,
          selfEmail: null
        }
      },
      (st) => states.push(st.state)
    )
    const [r1, r2] = await Promise.all([s.sync(), s.sync()])
    expect(calls).toBe(1) // second call joined the in-flight run
    expect(r1).toBe(r2)
    expect(r1.state).toBe('idle')
    expect(r1.lastSyncAt).not.toBeNull()
    expect(listUpcoming(db, '2026-11-13')).toHaveLength(2) // duplicates collapsed

    signedIn = false
    const r3 = await s.sync()
    expect(r3.state).toBe('needs-auth')
    expect(listUpcoming(db, '2026-11-13')).toHaveLength(2) // data kept

    signedIn = true
    expect((await s.sync()).state).toBe('idle')
    expect(states).toContain('syncing')
  })

  it('reports errors instead of throwing', async () => {
    const s = new CalendarSync(openDb(':memory:'), async () => {
      throw new Error('boom')
    })
    const r = await s.sync()
    expect(r).toMatchObject({ state: 'error', error: 'boom' })
  })
})

describe('calendar repeat id', () => {
  it("keeps Google's repeat id, and an update without one does not erase it", () => {
    const db = openDb(':memory:')
    applyEvents(db, [ev('a', '2026-11-13', '09:00', { seriesId: 'rep1' })])
    applyEvents(db, [ev('a', '2026-11-13', '09:00')])
    const row = db.prepare("SELECT series_id AS s FROM calendar_events WHERE id = 'a'").get() as {
      s: string | null
    }
    expect(row.s).toBe('rep1')
  })
})
