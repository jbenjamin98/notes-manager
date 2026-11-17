import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { parseNote, parseTaskLine } from './parse'
import { ensureIdentity, setTaskChecked } from './edit'
import { patchFile } from './fsio'
import { Vault } from './vault'

const NOTE = `---
id: "01JEXAMPLE0000000000000001"
title: "NextMRO Sync"
type: "meeting"
date: "2026-11-13"
account: "Navy NextMRO"
---

## Context & Objective
Align on cutover.

## Action Items
- [ ] Verify firewall rules | @Sarah | due:2026-11-17 | priority:High ^tabc123
- [x] Review checklist | @Me | due:2026-11-14 | priority:medium | est:1h30m ^tdef456
`

describe('parse', () => {
  it('parses task fields, ids, estimates and chunks', () => {
    const p = parseNote(NOTE)
    expect(p.tasks).toHaveLength(2)
    expect(p.tasks[0]).toMatchObject({
      id: 'tabc123',
      checked: false,
      description: 'Verify firewall rules',
      owner: 'Sarah',
      due: '2026-11-17',
      priority: 'High'
    })
    expect(p.tasks[1]).toMatchObject({ checked: true, priority: 'Medium', estMinutes: 90 })
    expect(p.chunks.map((c) => c.heading)).toEqual(['Context & Objective', 'Action Items'])
  })
  it('ignores non-task lines', () => {
    expect(parseTaskLine('- not a task', 0)).toBeNull()
  })
})

describe('edit', () => {
  it('toggles exactly one line by id and preserves CRLF', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n')
    const out = setTaskChecked(crlf, 'tabc123', true)!
    expect(out.replace('- [x] Verify', '- [ ] Verify')).toBe(crlf)
    expect(out).toContain('- [x] Verify firewall rules')
    expect(out.match(/\r\n/g)!.length).toBe(crlf.match(/\r\n/g)!.length)
    expect(setTaskChecked(NOTE, 'nope', true)).toBeNull()
  })
  it('assigns ids, re-issues duplicates and taken ids, and is stable afterwards', () => {
    const raw =
      '# Scratch\n- [ ] one\n- [ ] two ^tdup111\n- [ ] three ^tdup111\n- [ ] four ^ttaken1\n'
    const r = ensureIdentity(raw, (id) => id === 'ttaken1')
    expect(r.changed).toBe(true)
    const tasks = parseNote(r.content).tasks
    const ids = tasks.map((t) => t.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(4)
    expect(ids).toContain('tdup111')
    expect(ids).not.toContain('ttaken1')
    expect(r.content.startsWith('---\nid: "')).toBe(true)
    const again = ensureIdentity(r.content, (id) => id === 'ttaken1')
    expect(again.changed).toBe(false)
  })
})

describe('vault (real filesystem)', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })
  const setup = async (): Promise<{
    vault: Vault
    root: string
    db: ReturnType<typeof openDb>
  }> => {
    const root = mkdtempSync(join(tmpdir(), 'nm-vault-'))
    dirs.push(root)
    const db = openDb(':memory:')
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    const vault = new Vault(db, root, () => ['Me'])
    return { vault, root, db }
  }

  it('indexes a note, writes back a toggle, and treats its own write as a no-op (no echo loop)', async () => {
    const { vault, root, db } = await setup()
    const rel = 'notes/2026/2026-11-13-nextmro-sync.md'
    writeFileSync(join(root, ...rel.split('/')), NOTE)
    expect(await vault.processFile(rel)).toBe('indexed')
    expect(vault.status()).toMatchObject({ notes: 1, tasksOpen: 1, tasksDone: 1 })
    expect(db.prepare("SELECT is_mine FROM tasks WHERE id='tdef456'").get()).toMatchObject({
      is_mine: 1
    })
    expect(db.prepare("SELECT is_mine FROM tasks WHERE id='tabc123'").get()).toMatchObject({
      is_mine: 0
    })

    expect(await vault.setTaskDone('tabc123', true)).toBe(true)
    expect(readFileSync(join(root, ...rel.split('/')), 'utf8')).toContain(
      '- [x] Verify firewall rules'
    )
    expect(vault.status()).toMatchObject({ tasksOpen: 0, tasksDone: 2 })
    // The watcher would now fire for our own write: must be a no-op.
    expect(await vault.processFile(rel)).toBe('unchanged')
    expect(
      db.prepare("SELECT completed_at FROM tasks WHERE id='tabc123'").get() as {
        completed_at: string | null
      }
    ).toMatchObject({ completed_at: expect.any(String) })
  })

  it('adds identity to a bare external file once, then is idempotent', async () => {
    const { vault, root } = await setup()
    const rel = 'notes/2026/2026-11-12-scratch.md'
    writeFileSync(join(root, ...rel.split('/')), '# Scratch\n- [ ] call Joe | @Joe\n')
    expect(await vault.processFile(rel)).toBe('indexed')
    const after = readFileSync(join(root, ...rel.split('/')), 'utf8')
    expect(after).toMatch(/^---\nid: "[0-9A-Z]{26}"\n---\n/)
    expect(after).toMatch(/\^t[a-z0-9]{6}\n$/)
    expect(await vault.processFile(rel)).toBe('unchanged')
  })

  it('gives a copied file a new note id and fresh task ids; removes vanished files', async () => {
    const { vault, root, db } = await setup()
    const a = 'notes/2026/a.md'
    const b = 'notes/2026/a - copy.md'
    writeFileSync(join(root, ...a.split('/')), NOTE)
    await vault.processFile(a)
    copyFileSync(join(root, ...a.split('/')), join(root, ...b.split('/')))
    await vault.processFile(b)
    expect(vault.status().notes).toBe(2)
    expect(vault.status().tasksOpen + vault.status().tasksDone).toBe(4)
    const ids = (db.prepare('SELECT id FROM tasks').all() as { id: string }[]).map((r) => r.id)
    expect(new Set(ids).size).toBe(4)
    rmSync(join(root, ...b.split('/')))
    expect(await vault.processFile(b)).toBe('removed')
    expect(vault.status().notes).toBe(1)
  })

  it('reconcile picks up files and reports removals; CAS patch re-applies after a concurrent change', async () => {
    const { vault, root } = await setup()
    writeFileSync(join(root, 'notes', '2026', 'x.md'), NOTE)
    expect((await vault.reconcile()).indexed).toBe(1)
    rmSync(join(root, 'notes', '2026', 'x.md'))
    expect((await vault.reconcile()).removed).toBe(1)

    const f = join(root, 'cas.md')
    writeFileSync(f, 'a\n- [ ] t ^tcas0001\n')
    let calls = 0
    const r = await patchFile(f, (c) => {
      if (calls++ === 0) writeFileSync(f, 'a\nEXTRA\n- [ ] t ^tcas0001\n') // simulate Drive delivering a newer copy
      return setTaskChecked(c, 'tcas0001', true)
    })
    expect(r.changed).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('a\nEXTRA\n- [x] t ^tcas0001\n')
  })
})

import { slugify, notePath, renderTemplate } from './templates'

describe('templates', () => {
  it('slugifies safely, avoiding Windows reserved names and empty slugs', () => {
    expect(slugify('NextMRO Staging: Cutover Sync!')).toBe('nextmro-staging-cutover-sync')
    expect(slugify('Café résumé')).toBe('cafe-resume')
    expect(slugify('CON')).toBe('con-note')
    expect(slugify('???')).toBe('untitled')
    expect(notePath('2026-11-13', 'Sync', 2)).toBe('notes/2026/2026-11-13-sync-2.md')
  })
  it('meeting template parses to the 3-box + action ledger structure with CUI-safe frontmatter', () => {
    const md = renderTemplate({
      kind: 'meeting',
      title: 'A "quoted" sync',
      date: '2026-11-13',
      account: 'Navy'
    })
    const p = parseNote(md)
    expect(p.frontmatter?.data).toMatchObject({
      title: 'A "quoted" sync',
      type: 'meeting',
      account: 'Navy'
    })
    expect(p.chunks.map((c) => c.heading)).toEqual([
      'Key Decisions & Insights',
      'Open Questions / Parking Lot',
      'Action Items'
    ])
  })
})

describe('saveNote / createNote', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })
  it('creates without clobbering, saves with identity, and refuses to overwrite a newer disk copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-save-'))
    dirs.push(root)
    const vault = new Vault(openDb(':memory:'), root, () => ['Me'])
    const a = await vault.createNote({ kind: 'meeting', title: 'Sync', date: '2026-11-13' })
    const b = await vault.createNote({ kind: 'meeting', title: 'Sync', date: '2026-11-13' })
    expect(a).toBe('notes/2026/2026-11-13-sync.md')
    expect(b).toBe('notes/2026/2026-11-13-sync-2.md')

    const { content, hash } = await vault.readNote(a)
    const edited = content.replace('- [ ] ', '- [ ] ship it | @Sarah | due:2026-11-20')
    const r1 = await vault.saveNote(a, edited, hash)
    expect(r1.ok).toBe(true)
    expect(r1.content).toMatch(/ship it \| @Sarah \| due:2026-11-20 \^t[a-z0-9]{6}/) // id added in the same write
    expect(vault.tasksForNote(a)).toHaveLength(1)

    // Drive delivers a newer copy; the editor still holds the old base hash.
    writeFileSync(join(root, ...a.split('/')), r1.content + '\nfrom another machine\n')
    const r2 = await vault.saveNote(a, edited + '\nmine', r1.hash)
    expect(r2.ok).toBe(false)
    expect(r2.content).toContain('from another machine')
    expect(readFileSync(join(root, ...a.split('/')), 'utf8')).toContain('from another machine')
    expect(readFileSync(join(root, ...a.split('/')), 'utf8')).not.toContain('mine')

    const r3 = await vault.forceSaveNote(a, edited + '\nmine')
    expect(r3.ok).toBe(true)
    await expect(vault.readNote('../secret.md')).rejects.toThrow('Invalid note path')
  })
})

describe('reconcile ordering', () => {
  it('lets the original keep its identity when a Drive conflict copy sorts first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-order-'))
    try {
      mkdirSync(join(root, 'notes', '2026'), { recursive: true })
      writeFileSync(join(root, 'notes', '2026', 'a.md'), NOTE)
      writeFileSync(join(root, 'notes', '2026', 'a (1).md'), NOTE)
      const db = openDb(':memory:')
      const vault = new Vault(db, root, () => ['Me'])
      await vault.reconcile()
      const orig = db.prepare("SELECT id FROM notes WHERE file_path='notes/2026/a.md'").get() as {
        id: string
      }
      expect(orig.id).toBe('01JEXAMPLE0000000000000001')
      expect(
        db
          .prepare(
            "SELECT t.id FROM tasks t JOIN notes n ON n.id=t.note_id WHERE n.file_path='notes/2026/a.md'"
          )
          .all()
          .map((r) => (r as { id: string }).id)
          .sort()
      ).toEqual(['tabc123', 'tdef456'])
      expect(vault.listNotes().filter((n) => n.isConflict)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

import { setTaskDue, appendLine } from './edit'

describe('task due edits and inbox', () => {
  it('sets, replaces and clears due on exactly one line', () => {
    const src =
      '- [ ] a | @Me | due:2026-11-10 | priority:High ^tdue0001\n- [ ] b | @Joe ^tdue0002\n'
    const set = setTaskDue(src, 'tdue0001', '2026-12-01')!
    expect(set).toBe(
      '- [ ] a | @Me | priority:High | due:2026-12-01 ^tdue0001\n- [ ] b | @Joe ^tdue0002\n'
    )
    expect(setTaskDue(set, 'tdue0002', '2026-11-30')).toContain(
      '- [ ] b | @Joe | due:2026-11-30 ^tdue0002'
    )
    expect(setTaskDue(src, 'tdue0001', null)).toContain('- [ ] a | @Me | priority:High ^tdue0001')
    expect(setTaskDue(src, 'nope0000', null)).toBeNull()
  })
  it('appendLine keeps a single trailing newline and the file EOL style', () => {
    expect(appendLine('x', 'y')).toBe('x\ny\n')
    expect(appendLine('x\n', 'y')).toBe('x\ny\n')
    expect(appendLine('x\r\n', 'y')).toBe('x\r\ny\r\n')
    expect(appendLine('', 'y')).toBe('y\n')
  })

  it('quick-add creates the monthly inbox once, appends tasks, lists them with waiting-since, hides conflict copies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-inbox-'))
    try {
      const db = openDb(':memory:')
      const vault = new Vault(db, root, () => ['Me'])
      const now = new Date(2026, 10, 13, 9, 0, 0)
      const a = await vault.addInboxTask('Send deck to Joe tomorrow @Joe !high', now)
      const b = await vault.addInboxTask('Think about caching', now)
      expect(a.path).toBe('inbox/2026-11.md')
      expect(b.path).toBe('inbox/2026-11.md')
      await expect(vault.addInboxTask('   ', now)).rejects.toThrow('Type a task first')

      const file = readFileSync(join(root, 'inbox', '2026-11.md'), 'utf8')
      expect(file.match(/^id: /gm)).toHaveLength(1) // header written once
      expect(file).toMatch(
        /- \[ \] Send deck to Joe @Joe \| due:2026-11-14 \| priority:High \^t[a-z0-9]{6}/
      )

      const tasks = vault.listTasks()
      expect(tasks.map((t) => t.description).sort()).toEqual([
        'Send deck to Joe @Joe',
        'Think about caching'
      ])
      const joe = tasks.find((t) => t.description.includes('@Joe'))!
      expect(joe).toMatchObject({
        owner: 'Me',
        isMine: true,
        due: '2026-11-14',
        priority: 'High',
        noteTitle: 'Inbox 2026-11'
      })
      // Inbox files are dated the 1st of the month, so waiting time counts from when the task was added.
      expect(joe.since).toBe(new Date().toLocaleDateString('en-CA'))

      expect(await vault.setTaskDue(joe.id, '2026-11-20')).toBe(true)
      expect(vault.listTasks().find((t) => t.id === joe.id)!.due).toBe('2026-11-20')
      expect(await vault.setTaskDue('missing', null)).toBe(false)

      // Completed tasks stay visible for 30 days; a conflict copy's tasks never show twice.
      await vault.setTaskDone(joe.id, true)
      expect(vault.listTasks().find((t) => t.id === joe.id)!.status).toBe('completed')
      writeFileSync(join(root, 'inbox', '2026-11 (1).md'), file)
      await vault.processFile('inbox/2026-11 (1).md')
      expect(vault.listTasks()).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('task source links', () => {
  it('a task keeps a readable link back to its source out of the description', () => {
    const t = parseTaskLine(
      '- [ ] Send the budget [Chat · Priya · Nov 14](nm://src/3f2c1a9e-1111-4222-8333-444455556666) | @Me | due:2026-11-20 ^t1x2y',
      0
    )!
    expect(t.description).toBe('Send the budget')
    expect(t.sourceLabel).toBe('Chat · Priya · Nov 14')
    expect(t.sourceId).toBe('3f2c1a9e-1111-4222-8333-444455556666')
    expect(t.due).toBe('2026-11-20')
    expect(parseTaskLine('- [ ] Plain task', 0)!.sourceId).toBeNull()
  })
})
