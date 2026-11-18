import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { BridgeClient, BridgeError } from './bridge'
import { runSelfTest } from './health'

const json = (o: unknown): Response =>
  new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } })

const client = (fetchImpl: (u: string) => Promise<Response>, extra = {}): BridgeClient =>
  new BridgeClient({
    url: () => 'https://script.google.com/macros/s/AKfy/exec',
    token: () => 'tok',
    fetchImpl: (u) => fetchImpl(u),
    tz: () => 'America/New_York',
    sleep: async () => undefined,
    ...extra
  })

describe('Google rate limits', () => {
  it("turns Gmail's quota answer into a plain 'try again soon' error", async () => {
    const c = client(async () =>
      json({
        ok: false,
        error:
          "API call to gmail.users.labels.list failed with error: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"
      })
    )
    const err = await c.mail({ days: 30, maxPages: 5 }).catch((e) => e)
    expect(err).toBeInstanceOf(BridgeError)
    expect(err.code).toBe('rate-limited')
    expect(err.message).toMatch(/try again in a minute/i)
  })

  it('does one big read at a time', async () => {
    let running = 0
    let peak = 0
    const c = client(async (u) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return json(
        new URL(u).searchParams.get('action') === 'chat'
          ? { messages: [] }
          : { rows: [], nextPageToken: null, historyId: '1', resync: false, selfEmail: 'me@x.com' }
      )
    })
    await Promise.all([
      c.mail({ days: 3, maxPages: 1 }),
      c.chat(1),
      c.mail({ days: 5, maxPages: 1 })
    ])
    expect(peak).toBe(1)
  })

  it('pages through mail slowly (a pause between pages)', async () => {
    const pauses: number[] = []
    let page = 0
    const c = client(
      async () =>
        json({
          rows: [],
          nextPageToken: ++page < 3 ? 'next' : null,
          historyId: '1',
          resync: false,
          selfEmail: 'me@x.com'
        }),
      { sleep: async (ms: number) => void pauses.push(ms), gapMs: 0 }
    )
    await c.mail({ days: 30, maxPages: 10 })
    expect(pauses.filter((p) => p === 3500)).toHaveLength(2) // between 3 pages
  })

  it('Verify does not call Google slowing down a fault in the script', async () => {
    const db = openDb(':memory:')
    const c = client(async (u) => {
      const a = new URL(u).searchParams.get('action')
      if (a === 'ping') return json({ ok: true, version: 8, contract: 1, email: 'me@x.com' })
      return json({
        ok: true,
        version: 8,
        email: 'me@x.com',
        sections: {
          calendar: { ok: true },
          mail: { ok: false, error: "Quota exceeded for quota metric 'Total Query Cost'" },
          meet: { ok: true },
          chat: { ok: true }
        }
      })
    })
    const r = await runSelfTest(c, db)
    expect(r.ok).toBe(true)
    const mail = r.sections.find((s) => s.name === 'mail')!
    expect(mail.ok).toBe(true)
    expect(mail.error).toMatch(/busy/i)
  })
})

describe('a rate limit part way through a long mail read', () => {
  const page = (n: number): Response =>
    json({
      rows: [
        {
          legacyId: `t${n}`,
          threadId: null,
          senders: [{ name: 'Priya', email: 'priya@x.com' }],
          subject: `Thread ${n}`,
          snippet: '',
          lastMs: Date.now(),
          unread: false,
          starred: false,
          labels: ['Inbox']
        }
      ],
      nextPageToken: 'more',
      historyId: '9',
      resync: false,
      selfEmail: 'me@x.com'
    })

  it('keeps the pages already read instead of throwing them away', async () => {
    let n = 0
    const c = client(
      async () =>
        ++n <= 2
          ? page(n)
          : json({ ok: false, error: "Quota exceeded for quota metric 'Total Query Cost'" }),
      { gapMs: 0, paceMs: 0 }
    )
    const r = await c.mail({ days: 14, maxPages: 20 })
    expect(r.rows.map((x) => x.legacyId)).toEqual(['t1', 't2'])
    expect(r.rateLimited).toBe(true)
    expect(r.reachedCutoff).toBe(false)
  })

  it('still fails when nothing at all was read', async () => {
    const c = client(async () => json({ ok: false, error: "Quota exceeded 'Total Query Cost'" }))
    await expect(c.mail({ days: 14, maxPages: 5 })).rejects.toMatchObject({ code: 'rate-limited' })
  })
})
