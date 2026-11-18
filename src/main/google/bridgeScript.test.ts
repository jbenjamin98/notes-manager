import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

/**
 * Runs the REAL google-bridge/Code.gs in a sandbox with fake Google services, so what ships to the
 * user's Apps Script project is exactly what is tested.
 */
const CODE = readFileSync(join(process.cwd(), 'google-bridge', 'Code.gs'), 'utf8')
const TOKEN = 'tok-123'

interface Fakes {
  events?: object[]
  threads?: Record<string, object>
  threadIds?: string[]
  chatThreadIds?: string[]
  historyThrows?: boolean
  docs?: { id: string; name: string; created: Date }[]
  docText?: Record<string, string>
  sheet?: unknown[][] | null
  calendarThrows?: boolean
  activeEmail?: string
  effectiveEmail?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(f: Fakes = {}): (params: Record<string, string>) => any {
  const email = f.activeEmail ?? 'Me@Example.com'
  const ctx: Record<string, unknown> = {
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s: string) => ({
        s,
        setMimeType() {
          return this
        },
        getContent: () => s
      })
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => email }),
      getEffectiveUser: () => ({ getEmail: () => f.effectiveEmail ?? email }),
      getScriptTimeZone: () => 'America/New_York'
    },
    Utilities: {
      base64Encode: (s: string) => Buffer.from(s).toString('base64'),
      newBlob: (bytes: Buffer) => ({ getDataAsString: () => bytes.toString('utf8') }),
      base64DecodeWebSafe: (s: string) => Buffer.from(s, 'base64url'),
      formatDate: (d: Date, tz: string, fmt: string) => {
        const p = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        }).formatToParts(d)
        const g = (t: string): string => p.find((x) => x.type === t)!.value
        return fmt === 'yyyy-MM-dd'
          ? `${g('year')}-${g('month')}-${g('day')}`
          : `${g('hour')}:${g('minute')}`
      }
    },
    Calendar: {
      Settings: { get: () => ({ value: 'America/New_York' }) },
      Events: {
        list: () => {
          if (f.calendarThrows) throw new Error('Calendar is off')
          return { items: f.events ?? [] }
        }
      }
    },
    Gmail: {
      Users: {
        getProfile: () => ({ emailAddress: email.toLowerCase(), historyId: '999' }),
        Labels: {
          list: () => ({
            labels: [
              { id: 'INBOX', name: 'INBOX', type: 'system' },
              { id: 'L7', name: 'Jira', type: 'user' }
            ]
          })
        },
        Threads: {
          list: (_u: string, o: { q: string }) => ({
            threads: (/chat-noreply/.test(o.q)
              ? (f.chatThreadIds ?? [])
              : (f.threadIds ?? Object.keys(f.threads ?? {}))
            ).map((id) => ({ id }))
          })
        },
        History: {
          list: () => {
            if (f.historyThrows) throw new Error('404 history too old')
            return {
              history: [{ messagesAdded: [{ message: { threadId: 't1' } }] }],
              historyId: '1001'
            }
          }
        }
      }
    },
    ScriptApp: { getOAuthToken: () => 'oauth' },
    UrlFetchApp: {
      fetchAll: (reqs: { url: string }[]) =>
        reqs.map((r) => {
          const id = /threads\/([^?]+)/.exec(r.url)![1]
          const t = f.threads?.[id]
          return {
            getResponseCode: () => (t ? 200 : 404),
            getContentText: () => JSON.stringify(t ?? {})
          }
        })
    },
    DocumentApp: {
      openById: (id: string) => ({ getBody: () => ({ getText: () => f.docText?.[id] ?? '' }) })
    },
    DriveApp: {
      searchFiles: () => {
        const list = [...(f.docs ?? [])]
        return {
          hasNext: () => list.length > 0,
          next: () => {
            const d = list.shift()!
            return { getId: () => d.id, getName: () => d.name, getDateCreated: () => d.created }
          }
        }
      },
      getFilesByName: () => ({ hasNext: () => !!f.sheet, next: () => ({}) })
    },
    SpreadsheetApp: {
      open: () => ({ getSheets: () => [{ getDataRange: () => ({ getValues: () => f.sheet }) }] })
    },
    console
  }
  vm.createContext(ctx)
  vm.runInContext(CODE.replace('__NOTE_MANAGER_TOKEN__', TOKEN), ctx)
  return (params) =>
    JSON.parse(
      (vm.runInContext('doGet', ctx) as (e: object) => { s: string })({ parameter: params }).s
    )
}

const msg = (
  id: string,
  from: string,
  subject: string,
  labels: string[],
  ms: number,
  snippet = 'snip'
): object => ({
  id,
  labelIds: labels,
  snippet,
  internalDate: String(ms),
  payload: {
    headers: [
      { name: 'From', value: from },
      { name: 'Subject', value: subject }
    ]
  }
})

describe('Apps Script bridge (the real Code.gs)', () => {
  it('refuses anything without the token, or from another user, or unknown actions', () => {
    const get = load()
    expect(get({ action: 'ping' })).toEqual({ ok: false, error: 'bad-token' })
    expect(get({ action: 'ping', token: 'nope' })).toEqual({ ok: false, error: 'bad-token' })
    expect(get({ action: 'zzz', token: TOKEN })).toEqual({ ok: false, error: 'unknown-action' })
    expect(load({ effectiveEmail: 'other@x.com' })({ action: 'ping', token: TOKEN })).toEqual({
      ok: false,
      error: 'wrong-user'
    })
    // The shipped placeholder token must never work.
    const raw = load()
    expect(raw({ token: '__NOTE_MANAGER_TOKEN__' }).ok).toBe(false)
  })

  it('ping reports version, contract and who it runs as', () => {
    expect(load()({ action: 'ping', token: TOKEN })).toMatchObject({
      ok: true,
      version: 8,
      contract: 1,
      email: 'Me@Example.com'
    })
  })

  it('calendar: events in the calendar timezone, guests, Meet link, web-compatible ids, attachments', () => {
    const get = load({
      events: [
        {
          id: 'ev1',
          summary: 'NextMRO Weekly',
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
          start: { dateTime: '2026-11-13T15:00:00-05:00' },
          end: { dateTime: '2026-11-13T15:30:00-05:00' },
          attendees: [
            {
              email: 'me@example.com',
              self: true,
              responseStatus: 'accepted',
              displayName: 'Jacob Benjamin'
            },
            { email: 'sarah@example.com', displayName: 'Sarah Chen' },
            { email: 'room@resource.calendar.google.com', resource: true }
          ],
          attachments: [
            {
              fileId: 'F1',
              title: 'NextMRO Weekly - Notes by Gemini',
              mimeType: 'application/vnd.google-apps.document'
            }
          ]
        },
        {
          id: 'ev2',
          summary: 'Offsite',
          start: { date: '2026-11-20' },
          end: { date: '2026-11-21' }
        },
        {
          id: 'x',
          status: 'cancelled',
          summary: 'Gone',
          start: { dateTime: '2026-11-14T10:00:00Z' }
        }
      ]
    })
    const r = get({ action: 'calendar', token: TOKEN })
    expect(r.events.map((e: { title: string }) => e.title)).toEqual(['NextMRO Weekly', 'Offsite'])
    expect(r.events[0]).toMatchObject({
      date: '2026-11-13',
      startTime: '15:00',
      endTime: '15:30',
      status: 'accepted',
      kind: 'meeting'
    })
    expect(r.events[1]).toMatchObject({ allDay: true, kind: 'allday' })
    expect(Buffer.from(r.events[0].id + '==', 'base64').toString()).toBe('ev1 me@example.com')
    expect(r.details[0].guests).toEqual([{ email: 'sarah@example.com', name: 'Sarah Chen' }])
    expect(r.details[0].meetUrl).toBe('https://meet.google.com/abc-defg-hij')
    expect(r.owner).toBe('Jacob Benjamin')
    expect(r.attachments).toEqual([
      { eventId: r.events[0].id, fileId: 'F1', title: 'NextMRO Weekly - Notes by Gemini' }
    ])
  })

  it('mail: metadata rows with labels, unread/starred, senders oldest to newest, and never a body', () => {
    const get = load({
      threads: {
        t1: {
          id: 't1',
          messages: [
            msg(
              'm1',
              'Sarah Chen <sarah@example.com>',
              'Firewall rules',
              ['INBOX', 'L7'],
              1763047620000
            ),
            msg(
              'm2',
              'me@example.com',
              'Re: Firewall rules',
              ['INBOX', 'UNREAD', 'STARRED'],
              1763051220000,
              'latest'
            )
          ]
        },
        t2: { id: 't2', messages: [msg('m3', 'x@y.com', 'Draft only', ['DRAFT'], 1763000000000)] }
      }
    })
    const r = get({ action: 'mail', token: TOKEN, days: '30' })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({
      legacyId: 't1',
      subject: 'Firewall rules',
      snippet: 'latest',
      unread: true,
      starred: true,
      labels: ['Inbox', 'Jira'],
      lastMs: 1763051220000
    })
    // Sarah wrote first and I replied last, so I am the last entry.
    expect(r.rows[0].senders.map((s: { email: string }) => s.email)).toEqual([
      'sarah@example.com',
      'me@example.com'
    ])
    expect(r.historyId).toBe('999')
    expect(JSON.stringify(r)).not.toMatch(/"body"|"parts"/)
  })

  it('mail: the last sender is whoever wrote last, even when I started the thread', () => {
    const get = load({
      threads: {
        t1: {
          id: 't1',
          messages: [
            msg('m1', 'me@example.com', 'Plan', ['INBOX'], 1763047620000),
            msg('m2', 'Sarah Chen <sarah@example.com>', 'Re: Plan', ['INBOX'], 1763051220000),
            msg('m3', 'me@example.com', 'Re: Plan', ['INBOX'], 1763054820000),
            msg('m4', 'Sarah Chen <sarah@example.com>', 'Re: Plan', ['INBOX'], 1763058420000)
          ]
        }
      }
    })
    const r = get({ action: 'mail', token: TOKEN, days: '30' })
    expect(r.rows[0].senders.map((s: { email: string }) => s.email)).toEqual([
      'me@example.com',
      'sarah@example.com'
    ])
  })

  it('mail: incremental by history id, and asks for a full resync when the history is too old', () => {
    const threads = {
      t1: { id: 't1', messages: [msg('m1', 'a@b.com', 'S', ['INBOX'], 1763047620000)] }
    }
    const inc = load({ threads })({ action: 'mail', token: TOKEN, sinceHistoryId: '500' })
    expect(inc.rows.map((x: { legacyId: string }) => x.legacyId)).toEqual(['t1'])
    expect(inc.historyId).toBe('1001')
    const stale = load({ threads, historyThrows: true, threadIds: [] })({
      action: 'mail',
      token: TOKEN,
      sinceHistoryId: '1'
    })
    expect(stale.resync).toBe(true)
  })

  it('meet: Gemini notes from event attachments (exact) and by name in Drive, skipping known files', () => {
    const get = load({
      events: [
        {
          id: 'ev1',
          summary: 'NextMRO Weekly',
          start: { dateTime: '2026-11-13T15:00:00-05:00' },
          end: { dateTime: '2026-11-13T15:30:00-05:00' },
          attachments: [
            {
              fileId: 'F1',
              title: 'NextMRO Weekly - Notes by Gemini',
              mimeType: 'application/vnd.google-apps.document'
            },
            { fileId: 'F9', title: 'Agenda', mimeType: 'application/vnd.google-apps.document' }
          ]
        }
      ],
      docs: [
        { id: 'F2', name: 'Budget - Transcript', created: new Date('2026-11-12T10:00:00Z') },
        { id: 'F1', name: 'dup', created: new Date() }
      ],
      docText: { F1: 'Cutover moves to Dec 4.', F2: 'Alice: hello' }
    })
    const r = get({ action: 'meet', token: TOKEN })
    expect(r.files.map((f: { fileId: string; kind: string }) => [f.fileId, f.kind])).toEqual([
      ['F1', 'notes'],
      ['F2', 'transcript']
    ])
    expect(r.files[0].text).toBe('Cutover moves to Dec 4.')
    expect(r.files[0].eventId).toBeTruthy()
    expect(
      get({ action: 'meet', token: TOKEN, known: 'F1' }).files.map(
        (f: { fileId: string }) => f.fileId
      )
    ).toEqual(['F2'])
  })

  it('chat (partial by design): notification emails and the optional flow sheet become messages', () => {
    const get = load({
      chatThreadIds: ['c1', 'c2'],
      threads: {
        c1: {
          id: 'c1',
          messages: [
            msg(
              'n1',
              'Google Chat <chat-noreply@google.com>',
              'Priya Nair: can you review the budget by 3?',
              ['INBOX'],
              1763047620000,
              'can you review the budget by 3?'
            )
          ]
        },
        c2: {
          id: 'c2',
          messages: [
            msg(
              'n2',
              'Google Chat <chat-noreply@google.com>',
              'Joe Cardone mentioned you in Cutover Team',
              ['INBOX'],
              1763051220000,
              '@Jacob the rules are late'
            )
          ]
        }
      },
      sheet: [
        ['time', 'space', 'sender', 'text', 'mentioned'],
        [new Date().toISOString(), 'Navy Space', 'Sarah Chen', 'Plan is ready', 'yes']
      ]
    })
    const r = get({ action: 'chat', token: TOKEN, days: '3650' })
    expect(r.coverage).toBe('partial')
    const byId = Object.fromEntries(r.messages.map((m: { id: string }) => [m.id, m]))
    expect(byId['gmail:n1']).toMatchObject({
      sender: 'Priya Nair',
      space: 'dm:Priya Nair', // every person gets their own space
      spaceType: 'dm',
      text: 'can you review the budget by 3?',
      mentionsMe: false
    })
    expect(byId['gmail:n2']).toMatchObject({
      sender: 'Joe Cardone',
      space: 'Cutover Team',
      mentionsMe: true,
      spaceType: 'space'
    })
    expect(
      r.messages.some(
        (m: { id: string; mentionsMe: boolean }) => m.id.startsWith('sheet:') && m.mentionsMe
      )
    ).toBe(true)
  })

  it('snapshot gives every section its own result, so one failure never hides the others', () => {
    const r = load({ calendarThrows: true, threads: {}, sheet: null })({
      action: 'snapshot',
      token: TOKEN
    })
    expect(r.sections.calendar).toMatchObject({ ok: false, error: 'Calendar is off' })
    expect(r.sections.mail.ok).toBe(true)
    expect(r.sections.chat.ok).toBe(true)
    expect(r.version).toBe(8)
  })

  it('selfTest runs each section briefly', () => {
    const r = load({ events: [], threads: {} })({ action: 'selfTest', token: TOKEN })
    expect(Object.keys(r.sections).sort()).toEqual(['calendar', 'chat', 'mail', 'meet'])
    expect(r.sections.mail.data).toEqual({ rows: 0 })
  })
})

describe('bridge: mail text', () => {
  const b64 = (s: string): string => Buffer.from(s).toString('base64url')
  const full = (id: string, from: string, text: string): object => ({
    id,
    internalDate: String(1763047620000),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: 'SOW approval' }
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64(text) } },
        { mimeType: 'text/html', body: { data: b64('<p>' + text + '</p>') } }
      ]
    }
  })

  it('returns the text of the asked threads without quoted history or signatures', () => {
    const get = load({
      threads: {
        t9: {
          id: 't9',
          messages: [
            full(
              'm1',
              'Dana Cole <dana@acme.com>',
              'Please send the signed SOW by Thursday.\n\nThanks\n--\nDana\nOn Mon, Nov 9, 2026 at 9:00 AM Jacob wrote:\n> old quoted text'
            )
          ]
        }
      }
    })
    const r = get({ action: 'mailBodies', token: TOKEN, ids: 't9' })
    expect(r.threads).toHaveLength(1)
    expect(r.threads[0]).toMatchObject({ threadId: 't9', subject: 'SOW approval' })
    expect(r.threads[0].messages[0].from).toBe('Dana Cole')
    expect(r.threads[0].messages[0].text).toContain('signed SOW by Thursday')
    expect(r.threads[0].messages[0].text).not.toContain('old quoted text')
    expect(r.threads[0].messages[0].text).not.toContain('Dana\nOn')
  })

  it('asks for nothing when no ids are given, and caps at 25 threads', () => {
    const get = load({})
    expect(get({ action: 'mailBodies', token: TOKEN, ids: '' }).threads).toEqual([])
    const many = Array.from({ length: 40 }, (_, i) => `x${i}`).join(',')
    expect(get({ action: 'mailBodies', token: TOKEN, ids: many }).threads).toEqual([])
  })
})
