import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { adjustSender, levelOf, loadRepliedTo, loadWeights, scoreThread } from './importance'
import type { ImportanceCtx, ImportanceFacts } from './importance'
import { applyThreads, overview, recordAction, worthwhileThreadIds } from './sync'
import type { ThreadRecord } from './parse'
import { signalsOf } from '../google/api'

const ctx = (over: Partial<ImportanceCtx> = {}): ImportanceCtx => ({
  weights: new Map(),
  repliedTo: new Map(),
  ...over
})
const facts = (over: Partial<ImportanceFacts> = {}): ImportanceFacts => ({
  starred: false,
  unread: true,
  iParticipated: false,
  lastSenderIsMe: false,
  senderEmail: 'dana@acme.com',
  senderName: 'Dana Cole',
  subject: 'Quick question',
  snippet: 'Can you send the numbers?',
  ageHours: 5,
  toMe: true,
  ccMe: false,
  bulk: false,
  importantLabel: false,
  msgCount: 1,
  ...over
})

describe('how much an email matters', () => {
  it('a person asking you something directly is important', () => {
    const r = scoreThread(facts(), ctx({ knownPerson: (n) => n === 'Dana Cole' }))
    expect(r.level).toBe('important')
    expect(r.reasons).toEqual(
      expect.arrayContaining(['Sent to you', 'Someone you know', 'Asks something'])
    )
  })

  it('a newsletter, a copy and an old thread fall below the line', () => {
    const news = scoreThread(
      facts({
        senderEmail: 'news@shop.com',
        senderName: 'Shop',
        bulk: true,
        snippet: 'Big sale',
        toMe: false
      }),
      ctx()
    )
    expect(news.level).toBe('noise')
    const cc = scoreThread(
      facts({ toMe: false, ccMe: true, snippet: 'FYI the plan is attached' }),
      ctx()
    )
    expect(cc.level).toBe('noise')
    const old = scoreThread(facts({ ageHours: 24 * 20, unread: false, snippet: 'ok' }), ctx())
    expect(old.level).toBe('noise')
  })

  it('stars, Gmail importance and topics lift a thread; an older script without headers still scores', () => {
    expect(
      scoreThread(facts({ starred: true, toMe: null, ccMe: null, bulk: null }), ctx()).level
    ).toBe('important')
    const maybe = scoreThread(
      facts({ snippet: 'notes from the call', toMe: null, ccMe: null, bulk: null, unread: false }),
      ctx({ topic: () => true })
    )
    expect(levelOf(maybe.score)).not.toBe('noise')
  })

  it('learns from Important / Not important, per address and half per domain', () => {
    const db = openDb(':memory:')
    adjustSender(db, 'Promo@Shop.com', -3)
    adjustSender(db, 'promo@shop.com', -3)
    const w = loadWeights(db)
    expect(w.get('promo@shop.com')).toBe(-6)
    expect(w.get('@shop.com')).toBe(-6)
    const s = scoreThread(facts({ senderEmail: 'promo@shop.com' }), ctx({ weights: w }))
    expect(s.reasons).toContain('You marked this sender not important')
    // A different address at the same domain feels half of it.
    const other = scoreThread(facts({ senderEmail: 'hello@shop.com' }), ctx({ weights: w }))
    expect(other.score).toBeLessThan(
      scoreThread(facts({ senderEmail: 'hello@shop.com' }), ctx()).score
    )
    expect(adjustSender(db, 'promo@shop.com', 3)).toBe(-3)
  })

  it('reads the headers of a thread', () => {
    const msg = (
      from: string,
      h: Record<string, string>,
      labelIds: string[] = []
    ): { labelIds: string[]; payload: { headers: { name: string; value: string }[] } } => ({
      labelIds,
      payload: {
        headers: [
          { name: 'From', value: from },
          ...Object.entries(h).map(([name, value]) => ({ name, value }))
        ]
      }
    })
    const s = signalsOf(
      [
        msg('Bot <bot@x.com>', { To: 'me@me.com', 'List-Unsubscribe': '<mailto:u@x.com>' }, [
          'IMPORTANT'
        ]),
        msg('Dana <dana@acme.com>', { To: 'a@b.com', Cc: 'me@me.com' })
      ],
      'me@me.com'
    )
    expect(s).toMatchObject({ toMe: false, ccMe: true, bulk: true, important: true, msgCount: 2 })
  })
})

const rec = (id: string, over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id,
  linkId: id,
  subject: `Subject ${id}`,
  snippet: 'Can you take a look?',
  senderName: 'Dana Cole',
  senderEmail: 'dana@acme.com',
  lastSenderIsMe: false,
  lastMessageAt: '2026-11-16T09:00',
  unread: true,
  starred: false,
  labels: [],
  inInbox: true,
  iParticipated: false,
  toMe: true,
  ccMe: false,
  bulk: false,
  importantLabel: false,
  msgCount: 1,
  ...over
})

describe('the mail overview uses the score', () => {
  const now = new Date('2026-11-17T09:00:00')
  it('lists what needs you, hides bulk and copies, and lets dismissal lapse when someone writes again', () => {
    const db = openDb(':memory:')
    applyThreads(
      db,
      [
        rec('a'),
        rec('news', {
          senderEmail: 'news@shop.com',
          senderName: 'Shop',
          bulk: true,
          snippet: 'Sale',
          toMe: false
        }),
        rec('cc', {
          senderEmail: 'pat@acme.com',
          senderName: 'Pat Lee',
          toMe: false,
          ccMe: true,
          snippet: 'FYI'
        }),
        rec('read', {
          unread: false,
          snippet: 'thanks',
          senderEmail: 'lou@acme.com',
          senderName: 'Lou Park'
        })
      ],
      []
    )
    const o = overview(db, {}, now, 48, { knownPerson: (n) => n === 'Dana Cole' })
    expect(o.awaitingMe.map((t) => t.id)).toEqual(['a'])
    expect(o.awaitingMe[0].level).toBe('important')
    expect(o.hidden.map((t) => t.id).sort()).toEqual(['cc', 'read'])
    expect(o.hiddenTotal).toBe(2)

    recordAction(db, 'a', 'dismissed')
    db.prepare("UPDATE email_actions SET at = '2026-11-17 09:30:00'").run()
    expect(
      overview(db, {}, now, 48, { knownPerson: (n) => n === 'Dana Cole' }).awaitingMe
    ).toHaveLength(0)
    // Dana writes again after the dismissal: it comes back.
    applyThreads(db, [rec('a', { lastMessageAt: '2026-11-17T10:00', snippet: 'Any update?' })], [])
    const later = new Date('2026-11-17T11:00:00')
    expect(
      overview(db, {}, later, 48, { knownPerson: (n) => n === 'Dana Cole' }).awaitingMe.map(
        (t) => t.id
      )
    ).toEqual(['a'])
  })

  it('shared filter for assistant and insights drops noise, muted and dismissed threads', () => {
    const db = openDb(':memory:')
    applyThreads(
      db,
      [
        rec('a'),
        rec('news', { senderEmail: 'news@shop.com', bulk: true, toMe: false, snippet: 'Sale' })
      ],
      []
    )
    expect([...worthwhileThreadIds(db, {}, { knownPerson: (n) => n === 'Dana Cole' })]).toEqual([
      'a'
    ])
    recordAction(db, 'a', 'dismissed')
    expect(worthwhileThreadIds(db, {}).size).toBe(0)
  })

  it('people you reply to count as known', () => {
    const db = openDb(':memory:')
    applyThreads(
      db,
      [
        rec('r1', { iParticipated: true, lastSenderIsMe: true }),
        rec('r2', { iParticipated: true, lastSenderIsMe: true })
      ],
      []
    )
    expect(loadRepliedTo(db).get('dana@acme.com')).toBe(2)
  })
})
