import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from './migrations'

export type Db = DatabaseSync

/**
 * Opens (and migrates) the local index. No Electron imports on purpose, so it
 * can be unit-tested in plain Node. Memory stays small: file-backed, WAL, and a
 * capped page cache (unlike sql.js, which holds the whole DB in RAM).
 */
export function openDb(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -8000;
    PRAGMA mmap_size = 0;
  `)
  migrate(db)
  return db
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

function migrate(db: Db): void {
  const current = schemaVersion(db)
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`, {
        cause: err
      })
    }
  }
}

export function health(
  db: Db,
  path: string
): { sqliteVersion: string; schemaVersion: number; ftsOk: boolean; path: string } {
  const v = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
  let ftsOk: boolean
  try {
    db.prepare("SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH 'healthcheck'").get()
    ftsOk = true
  } catch {
    ftsOk = false
  }
  return { sqliteVersion: v.v, schemaVersion: schemaVersion(db), ftsOk, path }
}
