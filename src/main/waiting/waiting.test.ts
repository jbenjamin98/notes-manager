import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import {
  addWaiting,
  formatWaitingLine,
  listWaiting,
  markReceived,
  ownerIsMe,
  parseWaitingLine
} from './waiting'
import { acceptInsight } from '../insights/accept'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})
const setup = (): { vault: Vault; db: ReturnType<typeof openDb>; root: string } => {
  const root = mkdtempSync(join(tmpdir(), 'nm-wait-'))
  dirs.push(root)
  mkdirSync(join(root, 'notes'), { recursive: true })
  const db = openDb(':memory:')
  return { vault: new Vault(db, root, () => ['Me', 'Jacob']), db, root }
}
const NOW = new Date('2026-11-16T10:00:00')

describe('Waiting On lines (others’ actions are notes, not tasks)', () => {
  it('formats and parses a line, with due date and source link', () => {
    const line = formatWaitingLine({
      who: '@Sarah',
      text: 'Send the deck',
      due: '2026-11-20',
      link: '[Chat · Priya · Nov 14](nm://src/abc)'
    })
    expect(line).toBe(
      '- **Waiting on Sarah:** Send the deck (due 2026-11-20) [Chat · Priya · Nov 14](nm://src/abc)'
    )
    expect(parseWaitingLine(line)).toEqual({
      who: 'Sarah',
      text: 'Send the deck',
      due: '2026-11-20',
      done: false
    })
    expect(parseWaitingLine(`- ~~**Waiting on Sarah:** Send the deck~~ ✓ 2026-11-21`)?.done).toBe(
      true
    )
    expect(parseWaitingLine('- [ ] A real task @Sarah')).toBeNull()
  })

  it('knows who you are', () => {
    expect(ownerIsMe(null, [])).toBe(true)
    expect(ownerIsMe('Me', [])).toBe(true)
    expect(ownerIsMe('@jacob', ['Jacob'])).toBe(true)
    expect(ownerIsMe('Sarah', ['Jacob'])).toBe(false)
  })

  it('writes to a monthly log, lists it, and "Got It" strikes it through', async () => {
    const { vault, db, root } = setup()
    const { path } = await addWaiting(db, vault, { who: 'Sarah', text: 'Send the deck' }, NOW)
    await addWaiting(db, vault, { who: 'Joe', text: 'Share the plan', due: '2026-11-18' }, NOW)
    const items = listWaiting(db)
    expect(items.map((i) => [i.who, i.text, i.due])).toEqual([
      ['Sarah', 'Send the deck', null],
      ['Joe', 'Share the plan', '2026-11-18']
    ])
    expect(db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 0 })
    expect(readFileSync(join(root, path), 'utf8')).toContain('## Waiting On')
    expect(await markReceived(vault, path, items[0].line, '2026-11-17')).toBe(true)
    expect(listWaiting(db).map((i) => i.who)).toEqual(['Joe'])
  })

  it('accepting an Inbox action owned by someone else saves a Waiting On line, not a task', async () => {
    const { vault, db } = setup()
    db.prepare(
      `INSERT INTO insights (id, kind, text, owner, due, confidence, source_type, source_ref, source_label, source_snippet, source_at, dedupe_key)
       VALUES ('i1','action','Send the numbers','Priya','2026-11-20',0.8,'chat','{}','Chat · Priya · Nov 14','','2026-11-14T15:00:00Z','k1'),
              ('i2','ask','Review the plan','Me',null,0.8,'chat','{}','Chat · Joe · Nov 14','','2026-11-14T15:00:00Z','k2')`
    ).run()
    const a = await acceptInsight(db, vault, 'i1', NOW, {}, ['Jacob'])
    expect(a.kind).toBe('waiting')
    expect(listWaiting(db)[0]).toMatchObject({ who: 'Priya', text: 'Send the numbers' })
    const b = await acceptInsight(db, vault, 'i2', NOW, {}, ['Jacob'])
    expect(b.kind).toBe('task')
  })
})
