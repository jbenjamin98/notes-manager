import { describe, it, expect } from 'vitest'
import { openDb } from '../db'
import { applyEvents } from '../calendar/sync'
import { candidates, fresh, markAnnounced, type ProEnv } from './proactive'
import { PERSONAS, PERSONA_IDS, fill, personaFor } from '../../shared/personas'
import type { TaskItem } from '../vault/vault'

const task = (o: Partial<TaskItem>): TaskItem =>
  ({
    id: 't' + Math.random(),
    description: 'Update firewall rules',
    owner: 'Me',
    isMine: true,
    due: null,
    priority: null,
    estMinutes: null,
    status: 'open',
    autoOwner: false,
    autoDue: false,
    since: '2026-11-01',
    completedAt: null,
    notePath: 'notes/2026/x.md',
    noteTitle: 'NextMRO Weekly 11/6',
    account: null,
    ...o
  }) as TaskItem

function env(over: Partial<ProEnv> & { now: Date }): ProEnv {
  const db = openDb(':memory:')
  applyEvents(db, [
    {
      id: 'E1',
      date: '2026-11-13',
      startTime: '15:00',
      endTime: '15:30',
      allDay: false,
      title: 'NextMRO Weekly 11/13',
      status: 'accepted',
      kind: 'meeting'
    }
  ])
  return {
    db,
    persona: 'nova',
    tasks: [],
    awaitingMe: [],
    workStartMin: 480,
    workEndMin: 1080,
    eodMin: 1005,
    ...over
  }
}
const FRI = (h: number, m = 0): Date => new Date(2026, 10, 13, h, m)

describe('personas', () => {
  it('every persona has a distinct name, a tone line and all the phrases', () => {
    expect(new Set(PERSONA_IDS.map((p) => PERSONAS[p].name)).size).toBe(4)
    for (const p of PERSONA_IDS) {
      expect(PERSONAS[p].tone.length).toBeGreaterThan(10)
      expect(Object.values(PERSONAS[p].say).every((s) => s.length > 5)).toBe(true)
    }
    expect(personaFor('nope').id).toBe('nova')
    expect(fill('{n} overdue{more}.', { n: 2 })).toBe('2 overdue.')
  })
})

describe('proactive messages', () => {
  it('morning brief once per weekday, in the persona voice, with action chips', () => {
    const e = env({
      now: FRI(8, 30),
      tasks: [task({ due: '2026-11-13' }), task({ due: '2026-11-10' })]
    })
    const [brief] = candidates(e)
    expect(brief).toMatchObject({ key: 'brief:2026-11-13', trigger: 'brief', urgent: false })
    expect(brief.body).toContain('2 tasks')
    expect(brief.body).toContain('1 overdue')
    expect(brief.body).toContain('1 meeting')
    expect(brief.chips).toEqual(["What's due today?", 'Plan my day::day-brief:'])
    expect(candidates(env({ now: FRI(8, 30), persona: 'rook' }))[0].body).toMatch(/Suspicious/)
    expect(candidates(env({ now: new Date(2026, 10, 14, 8, 30) }))).toEqual([]) // Saturday
  })

  it('heads-up 8 to 15 minutes before a meeting, urgent, with what is open from last time', () => {
    const e = env({ now: FRI(14, 50), tasks: [task({})] })
    const pm = candidates(e).find((c) => c.trigger === 'pre_meeting')!
    expect(pm.key).toBe('pm:E1:2026-11-13')
    expect(pm.urgent).toBe(true)
    expect(pm.body).toContain('10 minutes')
    expect(pm.body).toContain('1 item still open')
    expect(pm.chips).toEqual(['Brief me::prep-brief:E1'])
    expect(candidates(env({ now: FRI(14, 30) })).some((c) => c.trigger === 'pre_meeting')).toBe(
      false
    )
    expect(candidates(env({ now: FRI(14, 59) })).some((c) => c.trigger === 'pre_meeting')).toBe(
      false
    )
  })

  it('overdue only after 1 PM, reply-owed only after two days, wrap-up after the end-of-day time', () => {
    const t = [task({ due: '2026-11-09' })]
    expect(candidates(env({ now: FRI(11), tasks: t })).some((c) => c.key.startsWith('od:'))).toBe(
      false
    )
    expect(
      candidates(env({ now: FRI(13, 30), tasks: t })).find((c) => c.key.startsWith('od:'))!.body
    ).toContain('Update firewall rules')
    const mail = [
      { id: 'm1', subject: 'Budget', sender: 'Priya', lastMessageAt: '2026-11-10T09:00' }
    ]
    expect(
      candidates(env({ now: FRI(10), awaitingMe: mail })).find((c) => c.key === 'reply:m1')!.body
    ).toContain('3 days')
    expect(
      candidates(
        env({ now: FRI(10), awaitingMe: [{ ...mail[0], lastMessageAt: '2026-11-13T07:00' }] })
      ).some((c) => c.key.startsWith('reply:'))
    ).toBe(false)
    expect(
      candidates(env({ now: FRI(16, 50) })).find((c) => c.key === 'eod:2026-11-13')!.body
    ).toContain('0 tasks done')
  })

  it('announces each key once', () => {
    const e = env({ now: FRI(8, 30) })
    const first = fresh(e.db, candidates(e))
    expect(first.length).toBeGreaterThan(0)
    for (const c of first) markAnnounced(e.db, c, e.now)
    expect(fresh(e.db, candidates(e))).toEqual([])
  })
})
