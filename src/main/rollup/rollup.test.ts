import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { addDays, buildRollup, isoDay, rollupMarkdown, weekStartOf } from './rollup'

describe('weekly rollup', () => {
  it('finds the Monday of a week and steps days', () => {
    expect(weekStartOf(new Date(2026, 10, 13))).toBe('2026-11-09') // Friday
    expect(weekStartOf(new Date(2026, 10, 15))).toBe('2026-11-09') // Sunday belongs to the week before
    expect(weekStartOf(new Date(2026, 10, 9))).toBe('2026-11-09')
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
  })

  it('summarises notes, finished and overdue work, and people for the week', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-roll-'))
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    const today = isoDay(new Date())
    const ws = weekStartOf(new Date())
    const note = (
      name: string,
      id: string,
      title: string,
      date: string,
      account: string,
      body: string
    ): void =>
      writeFileSync(
        join(root, 'notes', '2026', name),
        `---\nid: "${id}"\ntitle: "${title}"\ntype: "meeting"\ndate: "${date}"\naccount: "${account}"\n---\n\n${body}\n`
      )
    note(
      'a.md',
      '01JROLL0000000000000000001',
      'Navy sync',
      ws,
      'Navy',
      'Sarah Chen joined.\n- [x] Send the deck | @Me\n- [ ] Fix firewall | @Sarah Chen | due:' +
        addDays(today, -3) +
        '\n- [ ] Plan cutover | @Me | due:' +
        addDays(ws, 9)
    )
    note(
      'b.md',
      '01JROLL0000000000000000002',
      'Old meeting',
      addDays(ws, -10),
      'Navy',
      '- [x] Ancient task | @Me'
    )
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.upsertRegistryEntry('person', 'Sarah Chen', [])
    await vault.init()
    try {
      const r = buildRollup(db, vault.listTasks(), ws, today)
      expect(r.notes.map((n) => n.title)).toEqual(['Navy sync']) // last month's note is out
      expect(r.accounts).toEqual([{ account: 'Navy', notes: 1 }])
      expect(r.completed.map((t) => t.description)).toEqual(['Send the deck'])
      expect(r.overdue.map((t) => t.description)).toEqual([]) // Fix firewall is Sarah's, not mine
      expect(r.waitingOn).toEqual([{ owner: 'Sarah Chen', count: 1 }])
      expect(r.comingUp.map((t) => t.description)).toEqual(['Plan cutover'])
      expect(r.people.map((p) => p.name)).toContain('Sarah Chen')
      const md = rollupMarkdown(r)
      expect(md).toContain('1 meeting/notes · 1 tasks completed')
      expect(md).toContain('### Waiting on others\n- Sarah Chen: 1 open')
    } finally {
      await vault.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
