import { describe, it, expect } from 'vitest'
import { openDb, type Db } from '../db'
import { NudgeEngine, type EngineSettings } from './engine'
import { jaccard, seriesKey, substantive } from './rules'
import type { TaskItem } from '../vault/vault'
import type { GmailOverview } from '../gmail/sync'

const FRI = (h: number, m = 0): Date => new Date(2026, 10, 13, h, m) // Friday 13 Nov 2026
const SAT = new Date(2026, 10, 14, 9, 0)

const settings = (over: Partial<EngineSettings['nudges']> = {}): EngineSettings => ({
  nudges: { enabled: true, toasts: true, rules: {}, eodTime: '16:45', ...over },
  workHours: { start: '08:00', end: '18:00' },
  defaultTaskMinutes: 30
})

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
  since: '2026-11-12',
  completedAt: null,
  notePath: 'notes/2026/x.md',
  noteTitle: 'X',
  account: null,
  ...over
})

const mail = (over: Partial<GmailOverview> = {}): GmailOverview =>
  ({
    awaitingMe: [],
    awaitingMeTotal: 0,
    needsReply: [],
    starred: [],
    groups: [],
    info: [],
    attention: 0,
    stats: { stored: 0, kept: 0, dropped: {}, keptBy: {} },
    ...over
  }) as GmailOverview

function setup(opts: { tasks?: TaskItem[]; mail?: GmailOverview; set?: EngineSettings } = {}): {
  db: Db
  engine: NudgeEngine
  sent: string[][]
} {
  const db = openDb(':memory:')
  const sent: string[][] = []
  const engine = new NudgeEngine(db, {
    getSettings: () => opts.set ?? settings(),
    getTasks: () => opts.tasks ?? [],
    getMail: () => opts.mail ?? null,
    onNew: (n) => sent.push(n.map((x) => x.rule))
  })
  return { db, engine, sent }
}

let seq = 0
const event = (
  db: Db,
  title: string,
  date: string,
  start: string,
  end: string,
  status: string | null = 'accepted'
): string => {
  const id = `ev${++seq}`
  db.prepare(
    `INSERT INTO calendar_events (id,title,start_at,end_at,date,all_day,kind,status) VALUES (?,?,?,?,?,0,'meeting',?)`
  ).run(id, title, `${date}T${start}:00`, `${date}T${end}:00`, date, status)
  return id
}
const note = (
  db: Db,
  title: string,
  date: string,
  body = '',
  eventId: string | null = null,
  questions: string[] = []
): { id: string; path: string } => {
  const id = `n${++seq}`
  const path = `notes/2026/${date}-${id}.md`
  db.prepare(
    `INSERT INTO notes (id,file_path,title,type,date,calendar_event_id,body_text) VALUES (?,?,?,'meeting',?,?,?)`
  ).run(id, path, title, date, eventId, body)
  if (questions.length) {
    db.prepare(`INSERT INTO note_chunks (note_id,heading,text) VALUES (?,?,?)`).run(
      id,
      'Open Questions / Parking Lot',
      questions.map((q) => `- ${q}`).join('\n')
    )
  }
  return { id, path }
}

describe('helpers', () => {
  it('normalises recurring meeting titles into one series', () => {
    expect(seriesKey('Sriya / Jacob - Monthly 1:1')).toBe(
      seriesKey('Sriya / Jacob - Monthly 1:1 (Nov 9)')
    )
    expect(seriesKey('NMRO Daily Standup - Nov 12')).toBe(seriesKey('NMRO Daily Standup - Nov 13'))
    expect(seriesKey('Weekly sync Friday')).toBe(seriesKey('Weekly sync'))
    expect(seriesKey('Design review')).not.toBe(seriesKey('Budget review'))
  })
  it('counts only real note content, not the template skeleton', () => {
    expect(substantive('## Context\n\n## Action Items\n- [ ] \n-\n')).toBe(0)
    expect(substantive('## Context\nAgreed to move the cutover to Thursday.\n')).toBeGreaterThan(30)
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBeCloseTo(0.5)
  })
})

describe('morning brief', () => {
  it('summarises the day once, in the first hours of work, weekdays only', () => {
    const tasks = [
      task({ due: '2026-11-10', description: 'Overdue one' }),
      task({ due: '2026-11-13' }),
      task({ due: '2026-11-13' }),
      task({ isMine: false, owner: 'Joe', since: '2026-11-05' })
    ]
    const { db, engine } = setup({ tasks, mail: mail({ awaitingMe: [{ unread: true } as never] }) })
    event(db, 'Team sync', '2026-11-13', '09:30', '10:30')
    event(db, 'Declined thing', '2026-11-13', '11:00', '12:00', 'declined')

    expect(engine.tick(FRI(7, 30))).toHaveLength(0) // before work starts
    const [n] = engine.tick(FRI(8, 5))
    expect(n.rule).toBe('brief')
    expect(n.body).toContain('1 meeting (1h), first at 9:30 AM')
    expect(n.body).toContain('1 overdue')
    expect(n.body).toContain('2 tasks due today')
    expect(n.body).toContain('1 unread email waiting for your reply')
    expect(engine.tick(FRI(8, 6))).toHaveLength(0) // deduped: once a day
    expect(setup().engine.tick(SAT)).toHaveLength(0) // weekend
    expect(
      setup()
        .engine.tick(FRI(13, 0))
        .filter((x) => x.rule === 'brief')
    ).toHaveLength(0) // window closed
  })

  it('catches up when the laptop was asleep at 8:00 (opens at 9:40)', () => {
    const { engine } = setup()
    expect(engine.tick(FRI(9, 40)).map((n) => n.rule)).toContain('brief')
  })
})

describe('pre-meeting prep', () => {
  it('fires 15 minutes ahead with context from the last meeting in the series, and stays quiet otherwise', () => {
    const { db, engine } = setup({
      tasks: [task({ notePath: 'notes/2026/2026-11-06-prev.md', description: 'Verify firewall' })]
    })
    db.prepare(
      `INSERT INTO notes (id,file_path,title,type,date) VALUES ('p1','notes/2026/2026-11-06-prev.md','NextMRO Sync (Nov 6)','meeting','2026-11-06')`
    ).run()
    db.prepare(
      `INSERT INTO note_chunks (note_id,heading,text) VALUES ('p1','Open Questions / Parking Lot','- Do we need a separate service account for the health check?')`
    ).run()
    event(db, 'NextMRO Sync', '2026-11-13', '10:00', '10:30')
    event(db, 'Brand new meeting', '2026-11-13', '10:05', '10:30')

    expect(engine.tick(FRI(9, 30)).filter((n) => n.rule === 'prep')).toHaveLength(0) // 30 min ahead: too early
    const preps = engine.tick(FRI(9, 47)).filter((n) => n.rule === 'prep')
    expect(preps).toHaveLength(1) // the brand-new meeting has nothing to prepare from
    expect(preps[0].title).toBe('In 13 min: NextMRO Sync')
    expect(preps[0].body).toContain('1 open task, 1 unresolved question')
    expect(preps[0].body).toContain('separate service account')
    expect(preps[0].actions.map((a) => a.type)).toEqual(['open-prep', 'open-event', 'open-note'])
    expect(engine.tick(FRI(9, 50)).filter((n) => n.rule === 'prep')).toHaveLength(0) // not again
  })
})

describe('post-meeting empty-note catcher', () => {
  it('nudges for series you take notes for, skips filled notes, short one-offs and lunch', () => {
    const { db, engine } = setup()
    note(db, 'Weekly Architect Sync', '2026-11-06', 'Lots of content here about decisions made.')
    const e1 = event(db, 'Weekly Architect Sync', '2026-11-13', '09:00', '09:30') // habitual, no note
    const e2 = event(db, 'Weekly Architect Sync', '2026-11-13', '09:40', '10:10') // habitual, note filled
    note(
      db,
      'Weekly Architect Sync',
      '2026-11-13',
      '## Context\nWe agreed to ship the staging change on Thursday after review.',
      e2
    )
    event(db, 'One-off chat', '2026-11-13', '09:00', '09:20') // short, not a series
    event(db, 'Lunch with team', '2026-11-13', '09:00', '10:00') // ignored by title
    event(db, 'Long planning offsite', '2026-11-13', '09:15', '10:00') // 45 min one-off: counts

    // Meetings that ended less than 5 minutes ago are left alone (people are still wrapping up).
    expect(engine.tick(FRI(9, 32)).filter((n) => n.rule === 'empty-note')).toHaveLength(0)

    const out = engine.tick(FRI(10, 15)).filter((n) => n.rule === 'empty-note')
    expect(out.map((n) => n.title).sort()).toEqual(
      [
        'Capture Long planning offsite while it is fresh',
        'Capture Weekly Architect Sync while it is fresh'
      ].sort()
    )
    expect(out.find((n) => n.title.includes('Architect'))!.actions[0]).toMatchObject({
      type: 'open-event',
      id: e1
    })
    // Too late (more than 45 minutes after it ended): the moment has passed.
    expect(engine.tick(FRI(12, 0)).filter((n) => n.rule === 'empty-note')).toHaveLength(0)
  })
})

describe('capacity overload', () => {
  it('warns when meetings plus due tasks do not fit, using estimates or the default', () => {
    const tasks = Array.from({ length: 6 }, () => task({ due: '2026-11-13', estMinutes: 60 }))
    const { db, engine } = setup({ tasks })
    event(db, 'All hands', '2026-11-13', '09:00', '12:00')
    event(db, 'Planning', '2026-11-13', '13:00', '16:00')
    const [o] = engine.tick(FRI(8, 10)).filter((n) => n.rule === 'overload')
    expect(o.title).toBe('Today will not fit')
    expect(o.body).toContain('6h of meetings leaves about 4h for 6 tasks that need roughly 6h')

    const light = setup({ tasks: [task({ due: '2026-11-13' })] })
    event(light.db, 'Short', '2026-11-13', '09:00', '10:00')
    expect(light.engine.tick(FRI(8, 10)).filter((n) => n.rule === 'overload')).toHaveLength(0)
  })

  it('also looks at the next business day at end of day (Friday -> Monday)', () => {
    const tasks = Array.from({ length: 8 }, () => task({ due: '2026-11-16', estMinutes: 60 }))
    const { db, engine } = setup({ tasks })
    event(db, 'Monday marathon', '2026-11-16', '09:00', '15:00')
    const out = engine.tick(FRI(16, 50)).filter((n) => n.rule === 'overload')
    expect(out.map((n) => n.title)).toEqual(['Tomorrow will not fit'])
  })
})

describe('follow-up radar', () => {
  it('sends one daily digest of stale delegated tasks and unanswered emails, mid-morning only', () => {
    const tasks = [
      task({
        isMine: false,
        owner: 'Sarah',
        description: 'Firewall rules',
        since: '2026-11-03',
        due: '2026-11-10'
      }),
      task({ isMine: false, owner: 'Joe', description: 'Fresh ask', since: '2026-11-12' }), // too new
      task({ isMine: false, owner: 'Priya', description: 'Budget numbers', since: '2026-11-06' })
    ]
    const m = mail({
      needsReply: [
        {
          subject: 'Contract terms',
          senderName: 'Sam Ortiz',
          lastMessageAt: '2026-11-09T09:00'
        } as never
      ]
    })
    const { engine } = setup({ tasks, mail: m })
    expect(engine.tick(FRI(9, 0)).filter((n) => n.rule === 'followup')).toHaveLength(0) // too early
    const [r] = engine.tick(FRI(10, 10)).filter((n) => n.rule === 'followup')
    expect(r.title).toBe('3 follow-ups to chase')
    expect(r.body).toContain('@Sarah: Firewall rules (due 3d ago)')
    expect(r.body).toContain('No reply from Sam Ortiz: Contract terms (4d)')
    expect(r.body).not.toContain('Fresh ask')
    expect(engine.tick(FRI(10, 40)).filter((n) => n.rule === 'followup')).toHaveLength(0)
    expect(
      setup({ tasks: [task({ isMine: false, since: '2026-11-12' })] })
        .engine.tick(FRI(10, 10))
        .filter((n) => n.rule === 'followup')
    ).toHaveLength(0) // nothing stale: silent
  })
})

describe('chronic blockers', () => {
  it('flags an open question that repeats across the last 3 meetings of a series, but not unrelated ones', () => {
    const { db, engine } = setup()
    note(db, 'NMRO Weekly (Oct 23)', '2026-10-23', '', null, [
      'Do we need a separate service account for the automated health check?'
    ])
    note(db, 'NMRO Weekly (Oct 30)', '2026-10-30', '', null, [
      'Separate service account for health check still unclear',
      'Who owns billing?'
    ])
    note(db, 'NMRO Weekly (Nov 6)', '2026-11-06', '', null, [
      'Is a separate service account needed for the health check?'
    ])
    const [b] = engine.tick(FRI(8, 30)).filter((n) => n.rule === 'blocker')
    expect(b.title).toBe('A blocker keeps coming back')
    expect(b.body).toContain('separate service account')
    expect(b.body).toContain('last 3')

    const other = setup()
    note(other.db, 'Planning (Oct 23)', '2026-10-23', '', null, ['Who owns billing?'])
    note(other.db, 'Planning (Oct 30)', '2026-10-30', '', null, ['What is the rollout date?'])
    note(other.db, 'Planning (Nov 6)', '2026-11-06', '', null, ['Where do logs go?'])
    expect(other.engine.tick(FRI(8, 30)).filter((n) => n.rule === 'blocker')).toHaveLength(0)
  })
})

describe('end of day', () => {
  it('summarises what is still open and warns about a crowded next business day', () => {
    const tasks = [
      task({ due: '2026-11-13' }),
      task({ due: '2026-11-13' }),
      task({ due: '2026-11-16', priority: 'High' }),
      task({ due: '2026-11-16', priority: 'High' }),
      task({ due: '2026-11-16' })
    ]
    const { db, engine } = setup({ tasks })
    event(db, 'Monday heavy', '2026-11-16', '09:00', '13:00')
    expect(engine.tick(FRI(16, 30)).filter((n) => n.rule === 'eod')).toHaveLength(0) // before 4:45
    const [e] = engine.tick(FRI(16, 50)).filter((n) => n.rule === 'eod')
    expect(e.body).toContain('2 tasks due today are still open')
    expect(e.body).toContain('Monday: 3 tasks due (2 High) and 4h of meetings')
    expect(engine.tick(FRI(17, 5)).filter((n) => n.rule === 'eod')).toHaveLength(0)
  })

  it('catches up late in the evening but not after hours', () => {
    expect(
      setup()
        .engine.tick(FRI(18, 30))
        .filter((n) => n.rule === 'eod')
    ).toHaveLength(1)
    expect(
      setup()
        .engine.tick(FRI(20, 30))
        .filter((n) => n.rule === 'eod')
    ).toHaveLength(0)
  })
})

describe('engine feed', () => {
  it('respects the master and per-rule switches', () => {
    expect(setup({ set: settings({ enabled: false }) }).engine.tick(FRI(8, 5))).toHaveLength(0)
    const some = setup({ set: settings({ rules: { brief: false } }) }).engine.tick(FRI(8, 5))
    expect(some.map((n) => n.rule)).not.toContain('brief')
  })

  it('lists newest first, tracks unread, and supports read / dismiss / snooze with wake-up', () => {
    const { engine } = setup({ set: settings({ rules: { rollup: false } }) })
    engine.tick(FRI(8, 5)) // brief
    engine.tick(FRI(16, 50)) // eod
    const list = engine.list(FRI(17, 0))
    expect(list.map((n) => n.rule)).toEqual(['eod', 'brief'])
    expect(engine.unread(FRI(17, 0))).toBe(2)

    engine.markRead(list[0].id)
    expect(engine.unread(FRI(17, 0))).toBe(1)
    engine.snooze(list[1].id, 60, FRI(17, 0))
    expect(engine.list(FRI(17, 30)).map((n) => n.rule)).toEqual(['eod']) // snoozed: hidden
    expect(engine.list(FRI(18, 5)).map((n) => n.rule)).toEqual(['eod', 'brief']) // wakes up, unread again
    expect(engine.unread(FRI(18, 5))).toBe(1)
    engine.dismiss(list[1].id)
    expect(engine.list(FRI(18, 5)).map((n) => n.rule)).toEqual(['eod'])
    engine.markRead()
    expect(engine.unread(FRI(18, 5))).toBe(0)
  })

  it('sends one weekly review on Friday afternoon, and not on other days', () => {
    const { engine } = setup()
    const roll = (n: { rule: string }[]): number => n.filter((x) => x.rule === 'rollup').length
    expect(roll(engine.tick(FRI(10, 0)))).toBe(0)
    expect(roll(engine.tick(new Date(2026, 10, 12, 16, 50)))).toBe(0) // Thursday
    const first = engine.tick(FRI(16, 20)).find((n) => n.rule === 'rollup')
    expect(first?.actions).toEqual([{ type: 'open-rollup', label: 'Open weekly review' }])
    expect(roll(engine.tick(FRI(16, 40)))).toBe(0) // once per week
  })

  it('only toasts on weekdays during work hours, and only when toasts are on', () => {
    const on = setup().engine
    expect(on.shouldToast(FRI(9, 0))).toBe(true)
    expect(on.shouldToast(FRI(23, 0))).toBe(false)
    expect(on.shouldToast(SAT)).toBe(false)
    expect(setup({ set: settings({ toasts: false }) }).engine.shouldToast(FRI(9, 0))).toBe(false)
  })

  it('has a test notification that goes through the same delivery path', () => {
    const { engine, sent } = setup()
    const n = engine.test(FRI(9, 0))
    expect(n.title).toContain('working')
    expect(sent).toEqual([['brief']])
    expect(engine.list(FRI(9, 1))).toHaveLength(1)
  })
})
