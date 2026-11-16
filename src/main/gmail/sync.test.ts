import { describe, it, expect } from 'vitest'
import { openDb } from '../db'
import {
  GmailSync,
  addMute,
  applyThreads,
  assessHealth,
  guessEmail,
  listLabels,
  listMutes,
  overview,
  recordAction,
  removeMute,
  senderNames,
  type CrawlOptions,
  type GmailScrape
} from './sync'
import { normalizeRows, type RawRow } from './parse'

const SELF = 'me@x.com'
const me = { name: 'me', email: SELF }
const joe = { name: 'Joe Park', email: 'joe@example.com' }
const NOW = new Date(2026, 10, 13, 12, 0, 0)

const raw = (id: string, over: Partial<RawRow> = {}): RawRow => ({
  legacyId: id,
  threadId: `#thread-${id}`,
  senders: [joe],
  subject: `Subject ${id}`,
  snippet: '',
  timeTitle: 'Mon, Nov 9, 2026, 9:00 AM',
  unread: false,
  starred: false,
  labels: ['Inbox'],
  ...over
})
const rec = (rows: RawRow[]): ReturnType<typeof normalizeRows> => normalizeRows(rows, SELF)

describe('mail overview: read-time relevance', () => {
  const build = (): ReturnType<typeof openDb> => {
    const db = openDb(':memory:')
    applyThreads(
      db,
      rec([
        raw('j1', {
          subject: '[JIRA] (NMRO-1) Tune limits',
          labels: ['Jira'],
          unread: true,
          senders: [{ name: 'Jira', email: 'jira@corp.net' }]
        }),
        raw('j2', {
          subject: '[JIRA] (NMRO-2) Cert rotation',
          labels: ['Jira'],
          senders: [{ name: 'Jira', email: 'jira@corp.net' }]
        }),
        raw('c1', { subject: 'Calendar update', labels: ['Invites'], unread: true }),
        raw('h1', { subject: 'Human inbox mail', labels: ['Inbox'], unread: true }),
        raw('n1', {
          subject: 'Weekly digest',
          labels: ['Inbox'],
          senders: [{ name: 'News', email: 'newsletter@brand.com' }]
        }),
        raw('a1', { subject: 'Old archived thread', labels: [] }),
        raw('cal', { subject: 'Accepted: Team sync @ Mon', labels: ['Inbox'] }),
        raw('s1', { subject: 'Budget question', labels: [], senders: [joe, me] }), // I wrote last, 4 days ago
        raw('s2', {
          subject: 'Fresh ask',
          labels: [],
          senders: [joe, me],
          timeTitle: 'Fri, Nov 13, 2026, 9:00 AM'
        }), // 3h
        raw('s3', { subject: 'Answered', labels: [], senders: [me, joe] }) // they replied last
      ]),
      rec([
        raw('st1', {
          subject: 'Keep this',
          labels: [],
          starred: true,
          timeTitle: 'Mon, Aug 3, 2026, 9:00 AM'
        })
      ])
    )
    return db
  }
  const handlers = { Jira: 'tasks', Invites: 'info' } as const

  it('brings in routed and human mail, drops automated/archived/calendar chatter, and says why', () => {
    const db = build()
    const ov = overview(db, { ...handlers }, NOW)
    expect(ov.stats.stored).toBe(11)
    expect(ov.stats.dropped).toEqual({ automated: 1, archived: 1, calendar: 1 })
    expect(ov.stats.kept).toBe(8)
    expect(ov.stats.keptBy).toMatchObject({ label: 2, counted: 1, starred: 1, mine: 3, inbox: 1 })
    expect(ov.needsReply.map((t) => t.subject)).toEqual(['Budget question']) // not too-fresh, not answered
    expect(ov.starred.map((t) => t.subject)).toEqual(['Keep this']) // older than any window, still kept
    // The mirror image: a person wrote to me, it's still in my inbox, and I haven't answered.
    expect(ov.awaitingMe.map((t) => t.subject)).toEqual(['Human inbox mail'])
    expect(ov.awaitingMe[0].taskText).toBe('Reply: Human inbox mail')
    expect(ov.awaitingMeTotal).toBe(1) // labeled, automated, answered and archived mail is not in it
    expect(ov.groups.map((g) => g.label)).toEqual(['Jira'])
    expect(ov.groups[0].threads[0].taskText).toBe('Jira NMRO-1: Tune limits') // unread first
    expect(ov.info).toEqual([{ label: 'Invites', unread: 1, total: 1 }])
  })

  it('applies settings instantly: ignoring a label, muting a sender and dismissing a thread', () => {
    const db = build()
    // Ignoring the only label on a thread drops it; the others stay.
    const ig = overview(db, { ...handlers, Invites: 'ignore' }, NOW)
    expect(ig.info).toEqual([])
    expect(ig.stats.dropped['ignored-label']).toBe(1)

    // Muting a domain removes its mail (even human mail), and unmuting brings it back.
    expect(addMute(db, 'https://Example.com/')).toBe('@example.com')
    expect(addMute(db, 'nonsense')).toBeNull()
    const m = overview(db, { ...handlers }, NOW)
    expect(m.stats.dropped.muted).toBeGreaterThan(0)
    expect(m.needsReply).toHaveLength(0)
    expect(listMutes(db)).toEqual(['@example.com'])
    removeMute(db, '@example.com')
    expect(overview(db, { ...handlers }, NOW).needsReply).toHaveLength(1)

    recordAction(db, 's1', 'dismissed')
    expect(overview(db, { ...handlers }, NOW).needsReply).toHaveLength(0)
  })

  it('discovers labels, guesses recipients, and offers human sender names for auto-tagging', () => {
    const db = build()
    expect(
      listLabels(db, { ...handlers })
        .map((l) => `${l.name}:${l.handler}`)
        .sort()
    ).toEqual(['Invites:info', 'Jira:tasks'])
    expect(guessEmail(db, 'joe')).toBe('joe@example.com')
    expect(senderNames(db)).toContain('Joe Park')
    expect(senderNames(db)).not.toContain('Jira')
    expect(senderNames(db)).not.toContain('News')
  })

  it('re-syncing updates in place, clears stale stars and expires old unstarred mail', () => {
    const db = openDb(':memory:')
    applyThreads(db, [], rec([raw('a', { starred: true }), raw('b', { starred: true })]))
    expect(overview(db, {}, NOW).starred).toHaveLength(2)
    applyThreads(db, [], rec([raw('a', { starred: true })])) // b was un-starred
    expect(overview(db, {}, NOW).starred.map((t) => t.id)).toEqual(['a'])
    applyThreads(db, rec([raw('old', { timeTitle: 'Mon, Jan 5, 2026, 9:00 AM' })]), [])
    expect(
      (db.prepare("SELECT count(*) c FROM email_threads WHERE id='old'").get() as { c: number }).c
    ).toBe(0)
  })
})

describe('gmail health + crawl planning', () => {
  const scrape = (over: Partial<GmailScrape> = {}): GmailScrape => ({
    signedIn: true,
    selfEmail: SELF,
    rows: Array.from({ length: 6 }, (_, i) => raw(`r${i}`)),
    starred: [],
    pages: 1,
    reachedCutoff: true,
    ...over
  })

  it('flags empty or half-readable crawls as degraded, naming the list', () => {
    expect(assessHealth(scrape()).health).toBe('ok')
    expect(assessHealth(scrape({ rows: [] })).health).toBe('degraded')
    const broken = scrape().rows.map((r) => ({ ...r, subject: '' }))
    expect(assessHealth(scrape({ rows: broken })).detail).toContain('mail list')
    const noTime = scrape().rows.map((r) => ({ ...r, timeTitle: '' }))
    expect(assessHealth(scrape({ rows: noTime })).detail).toContain('readable time')
  })

  it('does a full crawl first, then quick recent-days crawls, and re-crawls fully if coverage was partial', async () => {
    const db = openDb(':memory:')
    const seen: CrawlOptions[] = []
    let reached = true
    const s = new GmailSync(
      db,
      async (o) => {
        seen.push(o)
        return scrape({ reachedCutoff: reached })
      },
      undefined,
      () => true,
      () => 45
    )
    await s.sync()
    expect(seen[0]).toMatchObject({ days: 45, maxPages: 80 }) // 45 days -> 100 pages wanted, capped at 80
    expect(s.getStatus()).toMatchObject({
      lastFull: true,
      partial: false,
      lastRead: 6,
      health: 'ok'
    })
    await s.sync()
    expect(seen[1]).toMatchObject({ days: 3, maxPages: 8 }) // within 6h of a complete full crawl
    await s.sync(true)
    expect(seen[2].days).toBe(45) // manual full refresh

    // A crawl that stopped at the page cap is NOT remembered as complete.
    const db2 = openDb(':memory:')
    const seen2: CrawlOptions[] = []
    const p = new GmailSync(
      db2,
      async (o) => (seen2.push(o), scrape({ reachedCutoff: (reached = false) })),
      undefined,
      () => true,
      () => 30
    )
    await p.sync()
    expect(p.getStatus().partial).toBe(true)
    await p.sync()
    expect(seen2[1].days).toBe(30) // tries the full window again
  })

  it('keeps data when signed out, reports errors, shares concurrent runs and honours the off switch', async () => {
    const db = openDb(':memory:')
    let signedIn = true
    let calls = 0
    const s = new GmailSync(db, async () => (calls++, scrape({ signedIn })))
    const [a, b] = await Promise.all([s.sync(), s.sync()])
    expect(calls).toBe(1)
    expect(a).toBe(b)
    expect(a).toMatchObject({ state: 'idle', threads: 6 })
    signedIn = false
    expect((await s.sync(true)).state).toBe('needs-auth')
    expect(s.getStatus().threads).toBe(6) // data kept
    const bad = new GmailSync(openDb(':memory:'), async () => {
      throw new Error('boom')
    })
    expect(await bad.sync()).toMatchObject({ state: 'error', error: 'boom' })
    let off = 0
    const o = new GmailSync(
      openDb(':memory:'),
      async () => (off++, scrape()),
      undefined,
      () => false
    )
    await o.sync()
    expect(off).toBe(0)
  })
})

describe('after Google slows mail down', () => {
  it('saves what was read, then does small reads (not the whole crawl) until the pause ends', async () => {
    const db = openDb(':memory:')
    const seen: { days: number; since: string | null | undefined }[] = []
    let limited = true
    const row = {
      legacyId: 'a1',
      threadId: null,
      senders: [{ name: 'Priya', email: 'priya@x.com' }],
      subject: 'Budget',
      snippet: '',
      timeTitle: 'Nov 14',
      unread: true,
      starred: false,
      labels: ['Inbox']
    }
    const s = new GmailSync(db, async (o) => {
      seen.push({ days: o.days, since: o.sinceHistoryId })
      return {
        signedIn: true,
        selfEmail: 'me@x.com',
        rows: [row],
        starred: [],
        pages: 1,
        reachedCutoff: !limited,
        rateLimited: limited,
        historyId: limited ? null : '7',
        incremental: false
      }
    })
    await s.sync() // first read: limited part way, rows kept
    expect(s.getStatus().threads).toBe(1)
    expect(s.getStatus().state).toBe('idle')
    expect(s.getStatus().lastSyncAt).not.toBeNull()
    limited = false
    await s.sync() // paused: a small recent read, not the full window
    expect(seen[1].days).toBe(3)
    expect(seen[0].days).toBeGreaterThan(3)
  })
})
