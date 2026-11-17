import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import {
  createMasterNote,
  linesMentioning,
  linkToSeries,
  listSeries,
  sectionBullets,
  seriesCandidates,
  seriesDetail,
  seriesKey,
  startNextSession
} from './series'

const dirs: string[] = []
const vaults: Vault[] = []
afterEach(async () => {
  while (vaults.length) await vaults.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('meeting series', () => {
  it('one series whatever the date or "Weekly" in the title', () => {
    expect(seriesKey('Weekly NextMRO Sync (Nov 12)')).toBe('nextmro sync')
    expect(seriesKey('NextMRO sync 2026-11-19')).toBe('nextmro sync')
    expect(seriesKey('Re: NextMRO Sync')).toBe('nextmro sync')
  })

  it('reads the bullets under a heading, not empty or task lines', () => {
    const md = '## Key Decisions & Insights\n- Ship Friday\n- \n- [ ] a task\n\n## Other\n- no'
    expect(sectionBullets(md, /decisions/i)).toEqual(['Ship Friday'])
  })

  it('groups sessions, carries open actions and questions, and starts the next session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-series-'))
    dirs.push(root)
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    const note = (n: string, id: string, title: string, date: string, body: string): void =>
      writeFileSync(
        join(root, 'notes', '2026', n),
        `---\nid: "${id}"\ntitle: ${JSON.stringify(title)}\ntype: "meeting"\ndate: "${date}"\n---\n\n${body}\n`
      )
    note(
      'a.md',
      '01SER0000000000000000000A1',
      'NextMRO Sync',
      '2026-11-02',
      '## Key Decisions & Insights\n- Use staging first\n\n## Open Questions / Parking Lot\n- Who owns the cutover?\n\n## Action Items\n- [ ] Send the runbook'
    )
    note(
      'b.md',
      '01SER0000000000000000000B2',
      'Weekly NextMRO Sync (Nov 9)',
      '2026-11-09',
      '## Action Items\n- [x] Book the room\n- [ ] Draft the plan'
    )
    note('c.md', '01SER0000000000000000000C3', 'Lunch', '2026-11-10', 'Not a series.')
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.init()
    vaults.push(vault)
    const ins = db.prepare(
      `INSERT INTO calendar_events (id, title, start_at, end_at, date, all_day, kind) VALUES (?, ?, ?, ?, ?, 0, 'meeting')`
    )
    ins.run(
      'ev1',
      'NextMRO Sync',
      '2026-11-23T10:00:00-05:00',
      '2026-11-23T10:30:00-05:00',
      '2026-11-23'
    )

    const today = '2026-11-16'
    const list = listSeries(db, vault, today)
    expect(list.map((s) => s.key)).toEqual(['nextmro sync'])
    expect(list[0]).toMatchObject({ sessions: 3, nextDate: '2026-11-23', openActions: 2 })

    const d = (await seriesDetail(db, vault, 'nextmro sync', today))!
    expect(d.sessions.map((s) => [s.date, s.status])).toEqual([
      ['2026-11-23', 'scheduled'],
      ['2026-11-09', 'notes'],
      ['2026-11-02', 'notes']
    ])
    expect(d.carried.map((t) => t.description)).toEqual(['Send the runbook', 'Draft the plan'])
    expect(d.decisions.map((x) => x.text)).toEqual(['Use staging first'])
    expect(d.questions.map((x) => x.text)).toEqual(['Who owns the cutover?'])

    // The next session's note is made from the calendar event and starts from what is still open.
    const path = await startNextSession(db, vault, 'nextmro sync', today)
    const content = (await vault.readNote(path)).content
    expect(content).toContain('Open question: Who owns the cutover?')
    expect(content).toContain('Still open: Draft the plan')
    expect(content).toContain('calendar_event_id: "ev1"')
  })
})

describe('series: by hand, by Google repeat id, threads, master page', () => {
  const setup = async (): Promise<{
    db: ReturnType<typeof openDb>
    vault: Vault
    root: string
  }> => {
    const root = mkdtempSync(join(tmpdir(), 'nm-series2-'))
    dirs.push(root)
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    const note = (n: string, id: string, title: string, date: string, body: string): void =>
      writeFileSync(
        join(root, 'notes', '2026', n),
        `---
id: "${id}"
title: ${JSON.stringify(title)}
type: "meeting"
date: "${date}"
---

${body}
`
      )
    note(
      'a.md',
      '01SERB000000000000000000A1',
      'Navy Weekly',
      '2026-11-02',
      '- Talked about Zorblax rollout\n- [ ] Call Zorblax'
    )
    note(
      'b.md',
      '01SERB000000000000000000B2',
      'NextMRO Sync',
      '2026-11-09',
      '- Zorblax rollout slipped'
    )
    note('c.md', '01SERB000000000000000000C3', 'NextMRO Sync', '2026-11-16', '- nothing')
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.upsertRegistryEntry('customer', 'Zorblax', [])
    await vault.init()
    vaults.push(vault)
    return { db, vault, root }
  }

  it('a note can be added to a series by hand and taken out again', async () => {
    const { db, vault } = await setup()
    const today = '2026-11-20'
    expect(listSeries(db, vault, today).map((s) => s.key)).toEqual(['nextmro sync'])
    expect(seriesCandidates(db, 'nextmro sync').map((c) => c.title)).toEqual(['Navy Weekly'])
    expect(await linkToSeries(db, vault, 'notes/2026/a.md', 'nextmro sync', true)).toBe(true)
    expect(listSeries(db, vault, today)[0].sessions).toBe(3)
    await linkToSeries(db, vault, 'notes/2026/a.md', 'nextmro sync', false)
    expect(listSeries(db, vault, today)[0].sessions).toBe(2)
  })

  it('joins differently named occurrences that Google says repeat together', async () => {
    const { db, vault } = await setup()
    const ins = db.prepare(
      `INSERT INTO calendar_events (id, title, start_at, end_at, date, all_day, kind, series_id) VALUES (?, ?, ?, ?, ?, 0, 'meeting', ?)`
    )
    ins.run(
      'e1',
      'NextMRO Sync',
      '2026-11-23T10:00:00',
      '2026-11-23T10:30:00',
      '2026-11-23',
      'rep1'
    )
    ins.run(
      'e2',
      'NextMRO Sync - moved',
      '2026-11-30T10:00:00',
      '2026-11-30T10:30:00',
      '2026-11-30',
      'rep1'
    )
    const list = listSeries(db, vault, '2026-11-20')
    expect(list).toHaveLength(1)
    expect(list[0].sessions).toBe(4)
  })

  it('finds topics that run through several sessions and makes a master note', async () => {
    const { db, vault } = await setup()
    await linkToSeries(db, vault, 'notes/2026/a.md', 'nextmro sync', true)
    const d = (await seriesDetail(db, vault, 'nextmro sync', '2026-11-20'))!
    const z = d.threads.find((t) => t.name === 'Zorblax')!
    expect(z.sessions).toBe(2)
    expect(z.lines.map((l) => l.text)).toContain('Zorblax rollout slipped')
    const path = await createMasterNote(db, vault, 'nextmro sync', '2026-11-20')
    const text = (await vault.readNote(path)).content
    expect(text).toContain('## Decisions Log')
    expect(text).toContain('2026-11-16: NextMRO Sync')
  })

  it('reads the lines that mention a name', () => {
    expect(
      linesMentioning(
        '- Zorblax rollout\n- [ ] Call @Zorblax ^ab12cd\n- other\nZorblax plain',
        'Zorblax'
      )
    ).toEqual(['Zorblax rollout', 'Call @Zorblax'])
  })
})
