import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, schemaVersion, health } from './index'
import { MIGRATIONS } from './migrations'

describe('db', () => {
  it('migrates, is idempotent, and keeps FTS in sync via triggers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nm-'))
    const file = join(dir, 'index.db')
    try {
      let db = openDb(file)
      expect(schemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1].version)
      db.prepare(
        "INSERT INTO notes (id,file_path,title,type,date) VALUES ('n1','notes/2026/a.md','A','meeting','2026-11-13')"
      ).run()
      db.prepare(
        "INSERT INTO note_chunks (note_id,heading,text) VALUES ('n1','Decisions','Cutover pushed to Thursday')"
      ).run()
      expect(
        db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'cutover'").all()
      ).toHaveLength(1)
      db.close()

      db = openDb(file) // re-open: no re-migration, data intact
      expect(health(db, file).ftsOk).toBe(true)
      db.prepare("DELETE FROM notes WHERE id='n1'").run() // cascade -> chunks -> fts trigger
      expect(
        db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'cutover'").all()
      ).toHaveLength(0)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('backup before upgrading', () => {
  it('copies an older database once, keeps only the last 3, and skips fresh or current ones', async () => {
    const { mkdtempSync, writeFileSync, readdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const { backupBeforeMigrate } = await import('./index')
    const { MIGRATIONS } = await import('./migrations')
    const dir = mkdtempSync(join(tmpdir(), 'nm-bak-'))
    try {
      const file = join(dir, 'index.db')
      const db = new DatabaseSync(file)
      db.exec('CREATE TABLE t (x)')
      expect(backupBeforeMigrate(db, file)).toBeNull() // brand new (version 0): nothing to protect
      for (const v of [5, 6, 7, 8]) {
        db.exec(`PRAGMA user_version = ${v}`)
        expect(backupBeforeMigrate(db, file)).toContain(`.pre-v${v}.bak`)
        writeFileSync(join(dir, `index.db.pre-v${v}.bak`), 'x') // bump mtime ordering
        await new Promise((r) => setTimeout(r, 15))
      }
      const baks = readdirSync(dir).filter((n) => n.endsWith('.bak'))
      expect(baks).toHaveLength(3)
      db.exec(`PRAGMA user_version = ${MIGRATIONS[MIGRATIONS.length - 1].version}`)
      expect(backupBeforeMigrate(db, file)).toBeNull() // already current
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
