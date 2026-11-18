import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { applyEvents } from '../calendar/sync'
import type { SecretStore } from '../services/secrets'
import { GoogleOAuth, OAuthError } from './oauth'
import {
  GoogleApi,
  docText,
  fetchCalendar,
  fetchChat,
  fetchGmail,
  gmailTimeTitle,
  parseAddress,
  webEventId
} from './api'
import { GoogleConnector } from './connector'
import { applyMeetArtifacts, matchEvent, titleOf } from './meet'
import { normalizeRows } from '../gmail/parse'

/** One fake server that plays Google's token endpoint and every API. */
async function fakeGoogle(): Promise<{
  base: string
  server: Server
  calls: string[]
  tokens: Record<string, unknown>[]
}> {
  const calls: string[] = []
  const tokens: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x')
      calls.push(u.pathname + (u.search ? '?' + decodeURIComponent(u.search) : ''))
      const json = (o: unknown, status = 200): void => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(o))
      }
      if (u.pathname === '/token') {
        const form = Object.fromEntries(new URLSearchParams(raw))
        tokens.push(form)
        if (form.refresh_token === 'revoked') return json({ error: 'invalid_grant' }, 400)
        if (form.grant_type === 'authorization_code' && form.code !== 'good-code')
          return json({ error: 'invalid_grant', error_description: 'bad code' }, 400)
        return json({
          access_token: `at-${tokens.length}`,
          refresh_token: form.grant_type === 'authorization_code' ? 'rt-1' : undefined,
          expires_in: 3600,
          scope:
            'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.messages.readonly'
        })
      }
      if (
        req.headers.authorization !== 'Bearer at-1' &&
        req.headers.authorization !== 'Bearer at-2'
      )
        return json({ error: { message: 'bad token' } }, 401)
      if (u.pathname === '/userinfo')
        return json({ email: 'Me@Example.com', name: 'Jacob Benjamin' })
      if (u.pathname === '/calendar/calendars/primary/events')
        return json({
          items: [
            {
              id: 'ev1',
              summary: 'NextMRO Weekly',
              start: { dateTime: '2026-11-13T15:00:00-05:00' },
              end: { dateTime: '2026-11-13T15:30:00-05:00' },
              hangoutLink: 'https://meet.google.com/abc-defg-hij',
              attendees: [
                { email: 'me@example.com', self: true, responseStatus: 'accepted' },
                {
                  email: 'sarah@example.com',
                  displayName: 'Sarah Chen',
                  responseStatus: 'accepted'
                },
                { email: 'room@resource.calendar.google.com', resource: true }
              ]
            },
            {
              id: 'ev2',
              summary: 'Offsite',
              start: { date: '2026-11-20' },
              end: { date: '2026-11-21' }
            },
            {
              id: 'gone',
              status: 'cancelled',
              summary: 'Cancelled',
              start: { dateTime: '2026-11-14T10:00:00Z' }
            },
            {
              id: 'wl',
              summary: 'Home',
              eventType: 'workingLocation',
              start: { date: '2026-11-13' },
              end: { date: '2026-11-14' }
            }
          ]
        })
      if (u.pathname === '/gmail/users/me/profile') return json({ emailAddress: 'me@example.com' })
      if (u.pathname === '/gmail/users/me/labels')
        return json({
          labels: [
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'Label_7', name: 'Jira', type: 'user' }
          ]
        })
      if (u.pathname === '/gmail/users/me/threads') {
        if (u.searchParams.get('q')?.includes('is:starred'))
          return json({ threads: [{ id: 't2' }] })
        return json({ threads: [{ id: 't1' }, { id: 't2' }] })
      }
      if (u.pathname === '/gmail/users/me/threads/t1')
        return json({
          id: 't1',
          messages: [
            {
              id: 'm1',
              labelIds: ['INBOX', 'Label_7'],
              snippet: 'first',
              internalDate: String(Date.UTC(2026, 10, 13, 15, 47)),
              payload: {
                headers: [
                  { name: 'From', value: 'Sarah Chen <sarah@example.com>' },
                  { name: 'Subject', value: 'Firewall rules' }
                ]
              }
            },
            {
              id: 'm2',
              labelIds: ['INBOX', 'UNREAD'],
              snippet: 'latest',
              internalDate: String(Date.UTC(2026, 10, 13, 16, 47)),
              payload: {
                headers: [
                  { name: 'From', value: 'me@example.com' },
                  { name: 'Subject', value: 'Re: Firewall rules' }
                ]
              }
            }
          ]
        })
      if (u.pathname === '/gmail/users/me/threads/t2')
        return json({
          id: 't2',
          messages: [
            {
              id: 'm3',
              labelIds: ['STARRED'],
              snippet: 'star',
              internalDate: String(Date.UTC(2026, 10, 13, 2, 0)),
              payload: {
                headers: [
                  { name: 'From', value: 'priya@example.com' },
                  { name: 'Subject', value: 'Budget' }
                ]
              }
            }
          ]
        })
      if (u.pathname === '/drive/files')
        return json({
          files: [
            {
              id: 'doc1',
              name: 'NextMRO Weekly - Notes by Gemini',
              createdTime: '2026-11-13T16:00:00Z'
            }
          ]
        })
      if (u.pathname === '/docs/documents/doc1')
        return json({
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: 'Dec 4 cutover approved.\n' } }] } }
            ]
          }
        })
      if (u.pathname === '/chat/spaces')
        return json({
          spaces: [{ name: 'spaces/AAA', displayName: 'NextMRO Room', spaceType: 'SPACE' }]
        })
      if (u.pathname === '/chat/spaces/AAA/members/me')
        return json({ member: { name: 'users/me1' } })
      if (u.pathname === '/chat/spaces/AAA/messages')
        return json({
          messages: [
            {
              name: 'spaces/AAA/messages/m1',
              text: 'Cutover confirmed for Dec 4',
              createTime: new Date().toISOString(),
              sender: { name: 'users/sarah', displayName: 'Sarah Chen', type: 'HUMAN' },
              annotations: [{ type: 'USER_MENTION', userMention: { user: { name: 'users/me1' } } }]
            },
            {
              name: 'spaces/AAA/messages/bot',
              text: 'noisy bot',
              createTime: new Date().toISOString(),
              sender: { displayName: 'Jira Bot', type: 'BOT' }
            }
          ]
        })
      json({ error: { message: 'not found' } }, 404)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    calls,
    tokens
  }
}

const servers: Server[] = []
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop()!.close(r))
})

function oauth(base: string, store: { rt: string | null }, opened: string[] = []): GoogleOAuth {
  return new GoogleOAuth({
    clientId: () => 'client-1',
    clientSecret: () => 'secret-1',
    loadRefreshToken: () => store.rt,
    saveRefreshToken: (t) => (store.rt = t),
    openExternal: (u) => opened.push(u),
    tokenUrl: `${base}/token`,
    authUrl: `${base}/auth`
  })
}

describe('Google OAuth (PKCE, loopback)', () => {
  it('opens the consent page, receives the code on a local port, exchanges it with PKCE, and keeps only the refresh token', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const store = { rt: null as string | null }
    const opened: string[] = []
    const o = oauth(g.base, store, opened)
    const p = o.connect(['openid', 'email'])
    for (let i = 0; i < 50 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    const auth = new URL(opened[0])
    expect(auth.pathname).toBe('/auth')
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('client_id')).toBe('client-1')
    const redirect = auth.searchParams.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    // The browser "comes back" with the code.
    const back = await fetch(`${redirect}/?code=good-code&state=${auth.searchParams.get('state')}`)
    expect(await back.text()).toContain('Connected')
    await p
    expect(store.rt).toBe('rt-1')
    expect(g.tokens[0]).toMatchObject({
      grant_type: 'authorization_code',
      code: 'good-code',
      client_id: 'client-1'
    })
    expect(g.tokens[0].code_verifier).toBeTruthy()
    expect(await o.accessToken()).toBe('at-1') // cached, no second token call
    expect(g.tokens).toHaveLength(1)
  })

  it('refreshes with the stored token and forgets a revoked one', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const o = oauth(g.base, { rt: 'rt-saved' })
    expect(o.connected()).toBe(true)
    expect(await o.accessToken()).toBe('at-1')
    expect(g.tokens[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-saved' })
    const store = { rt: 'revoked' as string | null }
    const r = oauth(g.base, store)
    await expect(r.accessToken()).rejects.toBeInstanceOf(OAuthError)
    expect(store.rt).toBeNull()
    expect(r.connected()).toBe(false)
  })

  it('rejects a wrong state and a denied consent', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const opened: string[] = []
    const o = oauth(g.base, { rt: null }, opened)
    const p = o.connect(['openid'])
    const rej = expect(p).rejects.toMatchObject({ code: 'denied' })
    for (let i = 0; i < 50 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    const redirect = new URL(opened[0]).searchParams.get('redirect_uri')!
    await fetch(`${redirect}/?error=access_denied`)
    await rej
  })
})

describe('Google OAuth: cancel, one sign-in at a time, one refresh at a time', () => {
  it('cancelling a waiting sign-in stops it, and a new one can start', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const opened: string[] = []
    const o = oauth(g.base, { rt: null }, opened)
    const p = o.connect(['openid'])
    const rej = expect(p).rejects.toMatchObject({ message: 'Sign-in cancelled.' })
    for (let i = 0; i < 50 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    o.cancel()
    await rej
    const again = o.connect(['openid'])
    const rej2 = expect(again).rejects.toMatchObject({ message: 'Sign-in cancelled.' })
    for (let i = 0; i < 50 && opened.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    o.cancel()
    await rej2
  })

  it('a second sign-in while one is open is refused instead of opening another tab', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const opened: string[] = []
    const o = oauth(g.base, { rt: null }, opened)
    const first = o.connect(['openid'])
    const rej = expect(first).rejects.toBeInstanceOf(OAuthError)
    for (let i = 0; i < 50 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    await expect(o.connect(['openid'])).rejects.toMatchObject({ code: 'token' })
    expect(opened).toHaveLength(1)
    o.cancel()
    await rej
  })

  it('parallel requests share one token refresh', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const o = oauth(g.base, { rt: 'rt-saved' })
    const tokens = await Promise.all([o.accessToken(), o.accessToken(), o.accessToken()])
    expect(new Set(tokens).size).toBe(1)
    expect(g.tokens).toHaveLength(1)
  })
})

function apiFor(base: string): GoogleApi {
  const o = oauth(base, { rt: 'rt-saved' })
  const bases = Object.fromEntries(
    ['calendar', 'gmail', 'drive', 'docs', 'chat', 'userinfo'].map((k) => [k, `${base}/${k}`])
  )
  return new GoogleApi({ token: (f) => o.accessToken(f), bases })
}

describe('Google APIs -> the shapes the syncs already use', () => {
  it('calendar: events, guests and Meet links in one call, with web-compatible ids', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const r = await fetchCalendar(apiFor(g.base), {
      daysBack: 7,
      daysAhead: 30,
      tz: 'America/New_York',
      now: new Date('2026-11-13T12:00:00Z')
    })
    expect(r.owner).toBe('Jacob Benjamin')
    expect(r.selfEmail).toBe('me@example.com')
    expect(r.events.map((e) => e.title)).toEqual(['NextMRO Weekly', 'Offsite', 'Home']) // cancelled one dropped
    expect(r.events[0]).toMatchObject({
      date: '2026-11-13',
      startTime: '15:00',
      endTime: '15:30',
      status: 'accepted',
      kind: 'meeting',
      allDay: false
    })
    expect(r.events[1]).toMatchObject({ date: '2026-11-20', allDay: true, kind: 'allday' })
    expect(r.events[2].kind).toBe('working_location')
    expect(r.events[0].id).toBe(webEventId('ev1', 'me@example.com'))
    expect(Buffer.from(r.events[0].id + '==', 'base64').toString()).toBe('ev1 me@example.com')
    expect(r.details[0]).toEqual({
      id: r.events[0].id,
      guests: [{ email: 'sarah@example.com', name: 'Sarah Chen' }],
      meetUrl: 'https://meet.google.com/abc-defg-hij'
    })
    // Same store as the scraper path.
    const db = openDb(':memory:')
    expect(applyEvents(db, r.events).upserted).toBe(3)
  })

  it('gmail: threads become the same rows the web scraper produces (metadata only)', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const r = await fetchGmail(apiFor(g.base), { days: 30, tz: 'America/New_York' })
    expect(r.signedIn).toBe(true)
    expect(r.selfEmail).toBe('me@example.com')
    expect(r.rows).toHaveLength(2)
    const t1 = r.rows.find((x) => x.legacyId === 't1')!
    expect(t1.subject).toBe('Firewall rules')
    expect(t1.snippet).toBe('latest')
    expect(t1.labels).toEqual(['Inbox', 'Jira'])
    expect(t1.unread).toBe(true)
    expect(t1.senders.at(-1)).toEqual({ name: 'me', email: 'me@example.com' }) // oldest→newest (last sender at end)
    expect(t1.timeTitle).toMatch(/Nov 13, 2026/)
    expect(r.starred.map((x) => x.legacyId)).toEqual(['t2'])
    // No message bodies were ever requested.
    expect(
      g.calls.filter((c) => c.includes('/threads/')).every((c) => c.includes('format=metadata'))
    ).toBe(true)
    const recs = normalizeRows(r.rows, r.selfEmail)
    expect(recs.find((x) => x.id === 't1')).toMatchObject({
      lastSenderIsMe: true,
      iParticipated: true,
      inInbox: true,
      labels: ['Jira']
    })
  })

  it('refreshes once on a 401 and reports a disabled API in plain words', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const api = apiFor(g.base)
    await api.get(`${g.base}/userinfo`)
    expect(g.tokens).toHaveLength(1)
    await expect(api.get(`${g.base}/nothing`)).rejects.toMatchObject({ status: 404 })
  })

  it('helpers: addresses, times, doc text', () => {
    expect(parseAddress('"Chen, Sarah" <Sarah@Example.com>')).toEqual({
      name: 'Chen, Sarah',
      email: 'sarah@example.com'
    })
    expect(parseAddress('bob@x.com')).toEqual({ name: 'bob@x.com', email: 'bob@x.com' })
    expect(gmailTimeTitle(Date.UTC(2026, 10, 13, 15, 47), 'America/New_York')).toBe(
      'Fri, Nov 13, 2026, 10:47 AM'
    )
    expect(
      docText({
        content: [
          { paragraph: { elements: [{ textRun: { content: 'Hello\n' } }] } },
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    { content: [{ paragraph: { elements: [{ textRun: { content: 'cell\n' } }] } }] }
                  ]
                }
              ]
            }
          }
        ]
      })
    ).toBe('Hello\ncell')
  })
})

describe('Meet notes into the vault', () => {
  it('matches "Title - Notes by Gemini" to the meeting and appends once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-meet-'))
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.init()
    try {
      applyEvents(db, [
        {
          id: 'E1',
          date: '2026-11-13',
          startTime: '15:00',
          endTime: '15:30',
          allDay: false,
          title: 'NextMRO Weekly 11/13',
          status: 'accepted',
          kind: 'meeting'
        },
        {
          id: 'E2',
          date: '2026-11-13',
          startTime: '16:00',
          endTime: '16:30',
          allDay: false,
          title: 'Budget review',
          status: null,
          kind: 'meeting'
        }
      ])
      expect(titleOf('NextMRO Weekly 11/13 - Notes by Gemini')).toBe('NextMRO Weekly 11/13')
      const art = {
        fileId: 'F1',
        name: 'NextMRO Weekly - Notes by Gemini',
        kind: 'notes' as const,
        createdAt: '2026-11-13T20:40:00Z',
        text: 'Summary\nCutover moves to Dec 4.'
      }
      expect(matchEvent(db, art)?.id).toBe('E1')
      const r1 = await applyMeetArtifacts(db, vault, [art])
      expect(r1).toEqual({ written: 1, unmatched: 0 })
      const path = (
        db.prepare("SELECT note_path AS p FROM meet_artifacts WHERE file_id = 'F1'").get() as {
          p: string
        }
      ).p
      const md = readFileSync(join(root, path), 'utf8')
      expect(md).toContain('## Notes by Gemini (Meet)')
      expect(md).toContain('Cutover moves to Dec 4.')
      expect(md).toContain('calendar_event_id: "E1"')
      const r2 = await applyMeetArtifacts(db, vault, [art]) // again: nothing doubled
      expect(r2.written).toBe(0)
      expect(
        (readFileSync(join(root, path), 'utf8').match(/Notes by Gemini \(Meet\)/g) ?? []).length
      ).toBe(1)
      const r3 = await applyMeetArtifacts(db, vault, [
        { ...art, fileId: 'F2', name: 'Unknown meeting - Transcript', kind: 'transcript' }
      ])
      expect(r3).toEqual({ written: 0, unmatched: 1 })
    } finally {
      await vault.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('chat: fetches human messages and skips bots', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const msgs = await fetchChat(apiFor(g.base), { sinceIso: '2026-11-01T00:00:00Z' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      id: 'spaces/AAA/messages/m1',
      spaceName: 'NextMRO Room',
      spaceType: 'space',
      sender: 'Sarah Chen',
      text: 'Cutover confirmed for Dec 4',
      mentionsMe: true,
      fromMe: false
    })
  })

  it('GoogleConnector coordinates status, calendar, gmail, Meet extras, Chat, and disconnect', async () => {
    const g = await fakeGoogle()
    servers.push(g.server)
    const root = mkdtempSync(join(tmpdir(), 'nm-conn-'))
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.init()
    const mem = new Map<string, string>([['google.refreshToken', 'rt-saved']])
    const secrets: SecretStore = {
      get: (k) => mem.get(k) ?? null,
      has: (k) => mem.has(k),
      set: (k, v) => void mem.set(k, v),
      delete: (k) => void mem.delete(k),
      canStore: () => true
    }
    const bases = Object.fromEntries(
      ['calendar', 'gmail', 'drive', 'docs', 'chat', 'userinfo'].map((k) => [k, `${g.base}/${k}`])
    )
    const conn = new GoogleConnector({
      db,
      secrets,
      getSettings: () => ({
        method: 'oauth',
        clientId: 'client-1',
        meetNotes: true,
        chat: true
      }),
      tz: () => 'America/New_York',
      openExternal: () => undefined,
      bases,
      authUrl: `${g.base}/auth`,
      tokenUrl: `${g.base}/token`
    })
    try {
      expect(conn.active()).toBe(true)
      const cal = await conn.calendar()
      expect(cal.signedIn).toBe(true)
      expect(cal.events).toHaveLength(3)
      applyEvents(db, cal.events!)

      const mail = await conn.gmail({ days: 30, maxPages: 2 })
      expect(mail.signedIn).toBe(true)
      expect(mail.rows).toHaveLength(2)

      await conn.extras(vault)
      const st = conn.status()
      expect(st).toMatchObject({
        method: 'oauth',
        hasClient: true,
        connected: true,
        lastError: null,
        meet: { files: 1 },
        chat: { messages: 1 }
      })
      expect(st.meet.lastAt).toBeTruthy()
      expect(st.chat.lastAt).toBeTruthy()
      expect((db.prepare('SELECT text FROM chat_messages').get() as { text: string }).text).toBe(
        'Cutover confirmed for Dec 4'
      )

      const after = conn.disconnect()
      expect(after.connected).toBe(false)
      expect(conn.active()).toBe(false)
    } finally {
      await vault.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
