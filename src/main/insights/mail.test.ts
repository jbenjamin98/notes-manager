import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import type { MailBody } from '../google/mailBody'
import { insightsFromMail, mailCandidates } from './mail'
import type { PipelineDeps } from './pipeline'
import { listInsights } from './store'

const recent = (daysAgo: number): string => {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  return `${d.toLocaleDateString('en-CA')}T10:00`
}
const add = (
  db: ReturnType<typeof openDb>,
  id: string,
  o: {
    email?: string
    mine?: number
    unread?: number
    starred?: number
    days?: number
    sent?: number
  } = {}
): void => {
  db.prepare(
    `INSERT INTO email_threads (id, link_id, subject, snippet, sender_name, sender_email, last_sender_is_me, last_message_at, unread, starred, in_sent, labels_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]')`
  ).run(
    id,
    id,
    'Subject ' + id,
    '',
    'Someone',
    o.email ?? 'dana@acme.com',
    o.mine ?? 0,
    recent(o.days ?? 1),
    o.unread ?? 1,
    o.starred ?? 0,
    o.sent ?? 0
  )
}
const deps = (db: ReturnType<typeof openDb>): PipelineDeps => ({
  db,
  llm: null,
  me: () => ['Me', 'Jacob']
})

describe('reading email for insights', () => {
  it('picks recent threads written by people, skips machines, old and already-read ones', () => {
    const db = openDb(':memory:')
    add(db, 'person')
    add(db, 'robot', { email: 'no-reply@vendor.com' })
    add(db, 'old', { days: 20 })
    add(db, 'iwrote', { mine: 1, unread: 0 })
    add(db, 'star', { days: 10, starred: 1 })
    expect(
      mailCandidates(db)
        .map((c) => c.id)
        .sort()
    ).toEqual(['person', 'star'])
  })

  it('reads the text, keeps only the insight and a snippet, and does not read an unchanged thread twice', async () => {
    const db = openDb(':memory:')
    add(db, 't1')
    const body: MailBody = {
      threadId: 't1',
      subject: 'SOW approval',
      messages: [
        {
          id: 'm1',
          from: 'Dana Cole',
          fromEmail: 'dana@acme.com',
          at: new Date().toISOString(),
          text:
            'Please send the signed SOW back by Thursday. We agreed to keep the scope as is.\n\nUnique-body-marker-XYZ ' +
            'filler sentence number one. '.repeat(30)
        }
      ]
    }
    let fetched = 0
    const fetchBodies = async (ids: string[]): Promise<MailBody[]> => {
      fetched += ids.length
      return [body]
    }
    expect(await insightsFromMail(deps(db), fetchBodies, 'me@x.com')).toBeGreaterThan(0)
    const items = listInsights(db)
    expect(items.some((i) => i.kind === 'ask' && /signed SOW/.test(i.text))).toBe(true)
    expect(items.some((i) => i.kind === 'decision' && /scope/.test(i.text))).toBe(true)
    expect(items[0].sourceLabel).toMatch(/^Email · SOW approval · /)
    expect(items[0].sourceRef.threadId).toBe('t1')
    // The message text itself is never stored.
    const everything = JSON.stringify([
      db.prepare('SELECT * FROM insights').all(),
      db.prepare('SELECT * FROM insight_runs').all(),
      db.prepare('SELECT * FROM kv').all()
    ])
    expect(everything).not.toContain('Unique-body-marker-XYZ')
    // A second pass finds nothing new to read.
    expect(await insightsFromMail(deps(db), fetchBodies, 'me@x.com')).toBe(0)
    expect(fetched).toBe(1)
  })
})
