import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { daysAsked, formatSources, gatherContext, nearestNotes } from './context'
import { askSystemPrompt } from './proposals'
import type { TaskItem } from '../vault/vault'

const TODAY = '2026-11-16'

function fixture(): ReturnType<typeof openDb> {
  const db = openDb(':memory:')
  db.prepare(
    `INSERT INTO notes (id,file_path,title,type,date,account,calendar_event_id,llm_blocked,body_text,updated_at)
     VALUES ('n1','notes/a.md','Acme weekly','meeting','2026-11-10',NULL,NULL,0,?,CURRENT_TIMESTAMP),
            ('n2','notes/b.md','Waiting On 2026-11','adhoc','2026-11-01',NULL,NULL,0,?,CURRENT_TIMESTAMP)`
  ).run(
    'Acme wants the cutover on December 4.',
    '## Waiting On\n- **Waiting on Priya Shah:** Send the budget numbers (due 2026-11-18)'
  )
  db.prepare(
    `INSERT INTO note_chunks (note_id, heading, text) VALUES ('n1','Decisions','Acme wants the cutover on December 4.')`
  ).run()
  db.prepare(
    `INSERT INTO entities (id, name, category, in_registry) VALUES ('e1','Priya Shah','person',1),('e2','Acme','customer',1)`
  ).run()
  db.prepare(`INSERT INTO note_entities (note_id, entity_id) VALUES ('n1','e2'),('n2','e1')`).run()
  db.prepare(
    `INSERT INTO calendar_events (id,title,start_at,end_at,date,all_day,kind,status,fetched_at)
     VALUES ('ev1','Acme cutover review','2026-11-16T14:00:00','2026-11-16T14:30:00','2026-11-16',0,'meeting','accepted',CURRENT_TIMESTAMP)`
  ).run()
  db.prepare(
    `INSERT INTO insights (id, kind, text, owner, due, confidence, source_type, source_ref, source_label, source_snippet, source_at, dedupe_key)
     VALUES ('i1','risk','Acme firewall rules are late','Priya Shah',NULL,0.8,'chat','{}','Chat · Priya · Nov 14','','2026-11-14T15:00:00Z','k1')`
  ).run()
  return db
}

const task = (description: string, due: string | null, noteTitle = 'Acme weekly'): TaskItem => ({
  id: description,
  description,
  owner: 'Me',
  isMine: true,
  due,
  priority: null,
  estMinutes: null,
  status: 'open',
  autoOwner: false,
  autoDue: false,
  sourceId: null,
  sourceLabel: null,
  since: '2026-11-10',
  completedAt: null,
  notePath: 'notes/a.md',
  noteTitle,
  account: null
})

const budget = { notes: 8, noteChars: 900, extraChars: 6000 }

describe('assistant context: every source, not just note keywords', () => {
  it('a question about a customer pulls notes, tasks, meetings and risks', () => {
    const db = fixture()
    const s = gatherContext(db, 'What is going on with Acme?', {
      tasks: [task('Send Acme the runbook', '2026-11-17'), task('Book dentist', null, 'Personal')],
      today: TODAY,
      budget
    })
    const kinds = new Set(s.map((x) => x.kind))
    for (const k of ['entity', 'note', 'task', 'meeting', 'insight']) expect(kinds).toContain(k)
    expect(s.some((x) => x.text.includes('Book dentist'))).toBe(false)
    expect(formatSources(s)).toMatch(/\[1\] /)
  })

  it('a question about a person finds what they owe you by first name', () => {
    const db = fixture()
    const s = gatherContext(db, 'What is Priya working on?', { tasks: [], today: TODAY, budget })
    expect(s.find((x) => x.kind === 'waiting')?.text).toContain('Send the budget numbers')
    expect(s.find((x) => x.kind === 'insight')?.text).toContain('firewall')
  })

  it('"today" means today\'s meetings and pressing tasks', () => {
    const db = fixture()
    expect(daysAsked('what is on my plate today', TODAY)).toEqual([TODAY])
    expect(daysAsked('this week?', TODAY)).toHaveLength(7)
    const s = gatherContext(db, 'What do I have today?', {
      tasks: [task('Send Acme the runbook', '2026-11-16')],
      today: TODAY,
      budget
    })
    expect(s.filter((x) => x.kind === 'meeting')).toHaveLength(1)
    expect(s.filter((x) => x.kind === 'task')).toHaveLength(1)
  })

  it('nothing matched still suggests the nearest notes', () => {
    const db = fixture()
    expect(nearestNotes(db, 'acmes weekly status')[0]?.title).toBe('Acme weekly')
  })

  it('the prompt asks for a direct, cited, complete answer (not "keep it short")', () => {
    const p = askSystemPrompt(true, 'normal')
    expect(p).toMatch(/Lead with the direct answer/)
    expect(p).toMatch(/name the gap/)
    expect(p).toMatch(/followups/)
    expect(p).not.toMatch(/Keep it short/)
  })
})
