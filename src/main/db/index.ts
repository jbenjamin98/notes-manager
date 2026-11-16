import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
  if (file !== ':memory:') backupBeforeMigrate(db, file)
  migrate(db)
  return db
}

/**
 * Before upgrading an existing database, keep a copy (the last 3). The search index can be rebuilt
 * from the notes, but settings-like data (feedback, history, saved insights) cannot.
 * Never blocks startup: a failed backup is skipped.
 */
export function backupBeforeMigrate(db: Db, file: string, keep = 3): string | null {
  try {
    const current = schemaVersion(db)
    const latest = MIGRATIONS[MIGRATIONS.length - 1].version
    if (current === 0 || current >= latest || !existsSync(file)) return null
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const copy = `${file}.pre-v${current}.bak`
    copyFileSync(file, copy)
    const dir = dirname(file)
    const prefix = basename(file) + '.pre-v'
    const old = readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.bak'))
      .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const o of old.slice(keep)) unlinkSync(join(dir, o.n))
    return copy
  } catch {
    return null
  }
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
