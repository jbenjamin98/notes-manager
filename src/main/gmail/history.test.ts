import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { GmailSync, type CrawlOptions, type GmailScrape } from './sync'
import type { RawRow } from './parse'

const row = (id: string): RawRow => ({
  legacyId: id,
  threadId: id,
  senders: [{ name: 'Joe', email: 'joe@x.com' }],
  subject: 'Hello ' + id,
  snippet: '',
  timeTitle: 'Fri, Nov 13, 2026, 9:00 AM',
  unread: true,
  starred: false,
  labels: ['Inbox']
})

const scrape = (o: Partial<GmailScrape>): GmailScrape => ({
  signedIn: true,
  selfEmail: 'me@x.com',
  rows: [],
  starred: [],
  pages: 1,
  reachedCutoff: true,
  ...o
})

describe('mail history position', () => {
  it('saves the position, reads only changes next time, and re-reads everything on resync', async () => {
    const db = openDb(':memory:')
    const calls: CrawlOptions[] = []
    let script: GmailScrape[] = [
      scrape({ rows: [row('a'), row('b')], historyId: '100' }), // first (full) read
      scrape({ rows: [], historyId: '101', incremental: true }), // nothing changed
      scrape({ resync: true, incremental: false }), // the source lost our place
      scrape({ rows: [row('a'), row('b'), row('c')], historyId: '200' }) // so: a full read again
    ]
    const sync = new GmailSync(db, async (o) => {
      calls.push(o)
      return script.shift()!
    })

    await sync.sync()
    expect(calls[0].sinceHistoryId).toBeNull() // first ever read is full
    expect(
      (db.prepare("SELECT value FROM kv WHERE key = 'gmail.historyId'").get() as { value: string })
        .value
    ).toBe('100')

    const st = await sync.sync()
    expect(calls[1].sinceHistoryId).toBe('100')
    expect(st.health).toBe('ok') // an empty incremental read is not a failure

    await sync.sync()
    expect(calls[2].sinceHistoryId).toBe('101')
    expect(calls[3].sinceHistoryId).toBeNull() // fell back to a full read
    expect(
      (db.prepare("SELECT value FROM kv WHERE key = 'gmail.historyId'").get() as { value: string })
        .value
    ).toBe('200')
    script = []
  })
})
