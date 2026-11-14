import { describe, it, expect } from 'vitest'
import { openDb, type Db } from '../db'
import { buildDossier, buildRange } from './dossier'
import {
  cleanMeetUrl,
  loadDetail,
  nameFromEmail,
  normalizeGuests,
  saveDetail
} from '../calendar/detail'
import type { TaskItem } from '../vault/vault'

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: Math.random().toString(36).slice(2),
  description: 'Do the thing',
  owner: 'Me',
  isMine: true,
  due: null,
  priority: null,
  estMinutes: null,
  status: 'open',
  autoOwner: false,
  autoDue: false,
  since: '2026-11-10',
  completedAt: null,
  notePath: 'notes/2026/x.md',
  noteTitle: 'X',
  account: null,
  ...over
})

function seed(): Db {
  const db = openDb(':memory:')
  const ins = (sql: string, ...a: unknown[]): void => void db.prepare(sql).run(...(a as never[]))
  // The meeting today, and two earlier ones in the same series.
  ins(
    `INSERT INTO calendar_events (id,title,start_at,end_at,date,all_day,kind,status) VALUES ('e1','NextMRO Sync','2026-11-13T10:00:00','2026-11-13T10:30:00','2026-11-13',0,'meeting','accepted')`
  )
  ins(
    `INSERT INTO notes (id,file_path,title,type,date) VALUES ('p1','notes/2026/2026-11-06-sync.md','NextMRO Sync (Nov 6)','meeting','2026-11-06')`
  )
  ins(
    `INSERT INTO notes (id,file_path,title,type,date) VALUES ('p0','notes/2026/2026-10-30-sync.md','NextMRO Sync (Oct 30)','meeting','2026-10-30')`
  )
  ins(
    `INSERT INTO note_chunks (note_id,heading,text) VALUES ('p1','Open Questions / Parking Lot','- Do we need a separate service account?')`
  )
  // Sarah: a known person, an email sender, and in earlier notes.
  ins(
    `INSERT INTO entities (id,name,category,in_registry) VALUES ('person:sarah chen','Sarah Chen','person',1)`
  )
  ins(
    `INSERT INTO note_entities (note_id,entity_id,mention_count) VALUES ('p1','person:sarah chen',2)`
  )
  ins(
    `INSERT INTO email_threads (id,subject,sender_name,sender_email,last_message_at,starred) VALUES ('m1','Firewall rules for staging','Sarah Chen','sarah.chen@example.com',datetime('now','localtime','-2 days'),0)`
  )
  ins(
    `INSERT INTO email_threads (id,subject,sender_name,sender_email,last_message_at,starred) VALUES ('m2','Old thread','Sarah Chen','sarah.chen@example.com',datetime('now','localtime','-90 days'),0)`
  )
  ins(
    `INSERT INTO email_threads (id,subject,sender_name,sender_email,last_message_at,starred) VALUES ('m3','NextMRO contract terms','Sam Ortiz','sam@other.com',datetime('now','localtime','-10 days'),1)`
  )
  ins(
    `INSERT INTO email_threads (id,subject,sender_name,sender_email,last_message_at,starred) VALUES ('m4','Unrelated starred','Sam Ortiz','sam@other.com',datetime('now','localtime','-5 days'),1)`
  )
  return db
}

describe('event detail helpers', () => {
  it('accepts only real Meet room links', () => {
    expect(cleanMeetUrl('https://meet.google.com/abc-defg-hij?authuser=0')).toBe(
      'https://meet.google.com/abc-defg-hij'
    )
    expect(cleanMeetUrl('https://meet.google.com/lookup/xyz')).toBeNull()
    expect(cleanMeetUrl('http://meet.google.com/abc-defg-hij')).toBeNull()
    expect(cleanMeetUrl('https://evil.com/meet.google.com/abc-defg-hij')).toBeNull()
    expect(cleanMeetUrl('javascript:alert(1)')).toBeNull()
    expect(cleanMeetUrl(null)).toBeNull()
  })
  it('cleans guests: dedupe, lowercase, drop me, rooms and junk; derive a name from an address', () => {
    const g = normalizeGuests(
      [
        { email: 'Sarah.Chen@Example.com', name: null },
        { email: 'sarah.chen@example.com', name: 'Sarah Chen' },
        { email: 'me@corp.com', name: 'Me' },
        { email: 'room-4@resource.calendar.google.com', name: 'Room 4' },
        { email: 'not-an-email', name: 'x' }
      ],
      'ME@corp.com'
    )
    expect(g).toEqual([{ email: 'sarah.chen@example.com', name: 'Sarah Chen' }])
    expect(nameFromEmail('jane.doe+tag@x.com')).toBe('Jane Doe')
    expect(nameFromEmail('priya@x.com')).toBe('Priya')
  })
  it('caches details and distinguishes "not fetched" from "no guests"', () => {
    const db = seed()
    expect(loadDetail(db, 'e1')).toMatchObject({ fetched: false })
    saveDetail(db, 'e1', { guests: [], meetUrl: null })
    expect(loadDetail(db, 'e1')).toMatchObject({
      fetched: true,
      detail: { guests: [], meetUrl: null }
    })
    expect(loadDetail(db, 'nope')).toBeNull()
  })
})

describe('prep dossier', () => {
  const deps = (tasks: TaskItem[]): Parameters<typeof buildDossier>[2] => ({
    tasks,
    selfEmail: 'me@corp.com',
    guessAccount: (t) => (/nextmro/i.test(t) ? 'Navy NextMRO' : null)
  })

  it('assembles attendees, last-time context, account work and recent email', () => {
    const db = seed()
    saveDetail(db, 'e1', {
      guests: [
        { email: 'sarah.chen@example.com', name: null },
        { email: 'newperson@example.com', name: null }
      ],
      meetUrl: 'https://meet.google.com/abc-defg-hij'
    })
    const tasks = [
      task({
        isMine: false,
        owner: 'Sarah Chen',
        description: 'Verify firewall',
        notePath: 'notes/2026/2026-11-06-sync.md'
      }),
      task({ isMine: false, owner: 'Sarah', description: 'Send the cert list' }), // first-name owner
      task({
        description: 'Draft runbook',
        notePath: 'notes/2026/2026-11-06-sync.md',
        account: 'Navy NextMRO'
      }),
      task({ description: 'Unrelated', account: 'Acme' }),
      task({ status: 'completed', isMine: false, owner: 'Sarah Chen' })
    ]
    const d = buildDossier(db, 'e1', deps(tasks))!

    expect(d.event).toMatchObject({
      title: 'NextMRO Sync',
      startTime: '10:00',
      endTime: '10:30',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      detailFetched: true,
      notePath: null
    })
    // Sarah resolves to a known person (via a sender we've seen); the other guest gets a readable name.
    expect(d.attendees.map((a) => a.name)).toEqual(['Sarah Chen', 'Newperson'])
    expect(d.attendees[0]).toMatchObject({
      personId: 'person:sarah chen',
      theyOwe: 2,
      lastNoteDate: '2026-11-06',
      recentEmails: 1
    })
    expect(d.attendees[1]).toMatchObject({ personId: null, theyOwe: 0, lastNoteDate: null })

    expect(d.series.previous.map((p) => p.date)).toEqual(['2026-11-06', '2026-10-30'])
    expect(d.series.previous[0].openTasks).toBe(2)
    expect(d.series.questions).toEqual(['Do we need a separate service account?'])
    // Each task appears once: "Verify firewall" is under the people, "Draft runbook" under the series.
    expect(d.series.openTasks.map((t) => t.description)).toEqual(['Draft runbook'])
    expect(d.attendeeTasks.map((t) => t.description).sort()).toEqual([
      'Send the cert list',
      'Verify firewall'
    ])
    expect(d.account).toBe('Navy NextMRO')
    expect(d.accountTasks).toEqual([]) // its only task is already listed under the series

    // Recent mail from the guests (last 30 days only) plus starred mail about the topic; unrelated starred is excluded.
    expect(d.emails.map((e) => e.subject).sort()).toEqual([
      'Firewall rules for staging',
      'NextMRO contract terms'
    ])
    expect(d.emails.find((e) => e.subject.includes('contract'))!.starred).toBe(true)
  })

  it('works with no guest data yet, no history, and an unknown event', () => {
    const db = seed()
    const d = buildDossier(db, 'e1', deps([]))!
    expect(d.event.detailFetched).toBe(false)
    expect(d.attendees).toEqual([])
    db.prepare(
      `INSERT INTO calendar_events (id,title,start_at,end_at,date,all_day,kind,status) VALUES ('e2','Brand new meeting','2026-11-13T11:00:00','2026-11-13T11:30:00','2026-11-13',0,'meeting','accepted')`
    ).run()
    const fresh = buildDossier(db, 'e2', deps([]))!
    expect(fresh.series.previous).toEqual([])
    expect(fresh.series.questions).toEqual([])
    expect(fresh.account).toBeNull()
    expect(buildDossier(db, 'nope', deps([]))).toBeNull()
  })
})

describe('calendar range', () => {
  it('collects meetings (not declined/all-day), notes without events, and due-task counts per day', () => {
    const db = seed()
    db.prepare(
      `INSERT INTO calendar_events (id,title,start_at,end_at,date,all_day,kind,status) VALUES ('dec','Declined','2026-11-13T12:00:00','2026-11-13T13:00:00','2026-11-13',0,'meeting','declined')`
    ).run()
    db.prepare(
      `INSERT INTO calendar_events (id,title,start_at,end_at,date,all_day,kind,status) VALUES ('ad','Holiday','2026-11-13T00:00:00','2026-11-13T23:59:00','2026-11-13',1,'allday',NULL)`
    ).run()
    db.prepare(
      `INSERT INTO notes (id,file_path,title,type,date,calendar_event_id) VALUES ('lnk','notes/2026/2026-11-13-linked.md','Linked','meeting','2026-11-13','e1')`
    ).run()
    db.prepare(
      `INSERT INTO notes (id,file_path,title,type,date) VALUES ('free','notes/2026/2026-11-12-scratch.md','Scratch','adhoc','2026-11-12')`
    ).run()
    const tasks = [
      task({ due: '2026-11-13', priority: 'High' }),
      task({ due: '2026-11-13' }),
      task({ due: '2026-11-20' }), // outside the range
      task({ due: '2026-11-13', isMine: false }),
      task({ due: '2026-11-13', status: 'completed' })
    ]
    const days = buildRange(db, '2026-11-09', '2026-11-15', tasks)
    expect(days.map((d) => d.date)).toEqual(['2026-11-12', '2026-11-13'])
    const fri = days.find((d) => d.date === '2026-11-13')!
    expect(fri.events.map((e) => e.id)).toEqual(['e1'])
    expect(fri.events[0]).toMatchObject({
      startTime: '10:00',
      notePath: 'notes/2026/2026-11-13-linked.md'
    })
    expect(fri.notes).toEqual([]) // an event's own note is shown on the event, not twice
    expect(fri.due).toEqual({ count: 2, high: 1 })
    expect(days[0].notes).toEqual([{ path: 'notes/2026/2026-11-12-scratch.md', title: 'Scratch' }])
  })
})
