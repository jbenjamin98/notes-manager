import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { applyEvents } from './sync'
import { openEventNote } from './openEvent'

describe('start notes from a calendar meeting / rename untitled notes', () => {
  it('creates one pre-filled meeting note per event (idempotent), then renames an untitled note', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-open-'))
    try {
      const db = openDb(':memory:')
      const vault = new Vault(db, root, () => ['Me'])
      applyEvents(db, [
        {
          id: 'evt1',
          date: '2026-11-13',
          startTime: '09:00',
          endTime: '10:00',
          allDay: false,
          title: 'NextMRO Sync',
          status: 'accepted',
          kind: 'meeting'
        }
      ])
      const p1 = await openEventNote(db, vault, 'evt1')
      const p2 = await openEventNote(db, vault, 'evt1') // double click
      expect(p2).toBe(p1)
      expect(p1).toBe('notes/2026/2026-11-13-nextmro-sync.md')
      const md = readFileSync(join(root, ...p1.split('/')), 'utf8')
      expect(md).toContain('title: "NextMRO Sync"')
      expect(md).toContain('calendar_event_id: "evt1"')
      expect(md).toContain('time: "09:00-10:00"')
      expect(md).toContain('## Action Items')
      await expect(openEventNote(db, vault, 'gone')).rejects.toThrow('no longer on your calendar')

      // Blank note -> set a title -> file is renamed, note id & tasks survive.
      const blank = await vault.createNote({ kind: 'adhoc', title: 'Untitled', date: '2026-11-13' })
      expect(blank).toBe('notes/2026/2026-11-13-untitled.md')
      await vault.saveNote(
        blank,
        (await vault.readNote(blank)).content + '- [ ] call Joe | @Joe\n',
        (await vault.readNote(blank)).hash
      )
      const before = db.prepare('SELECT id FROM notes WHERE file_path = ?').get(blank) as {
        id: string
      }
      const renamed = await vault.setTitle(blank, 'Architecture ideas')
      expect(renamed).toBe('notes/2026/2026-11-13-architecture-ideas.md')
      expect(existsSync(join(root, ...blank.split('/')))).toBe(false)
      const after = db.prepare('SELECT id, title FROM notes WHERE file_path = ?').get(renamed) as {
        id: string
        title: string
      }
      expect(after).toEqual({ id: before.id, title: 'Architecture ideas' })
      expect(vault.tasksForNote(renamed)).toHaveLength(1)
      expect(vault.status().notes).toBe(2) // no ghost row for the old path

      // A real (non-placeholder) filename is never renamed, only the title changes.
      expect(await vault.setTitle(p1, 'Renamed meeting')).toBe(p1)
      expect(readFileSync(join(root, ...p1.split('/')), 'utf8')).toContain(
        'title: "Renamed meeting"'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
