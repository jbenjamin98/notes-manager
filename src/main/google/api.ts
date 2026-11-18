import type { CalEvent, RsvpStatus } from '../calendar/parse'
import { textOfPayload, type GmailPart, type MailBody } from './mailBody'
import type { ChatIn } from '../chat/types'
import type { Guest } from '../calendar/detail'
import type { RawRow } from '../gmail/parse'
import type { GmailScrape } from '../gmail/sync'
import { wallClock } from '../../shared/tz'

/** Everything except bulk categories and drafts (the same filter the Apps Script bridge uses). */
export const MAIL_QUERY = '-category:promotions -category:social -category:forums -in:drafts'

/**
 * Thin clients for the official Google APIs. Same output shapes as the Apps Script bridge,
 * so Calendar / Gmail sync code does not care which source fed it. Mail metadata here; thread text is fetched separately (fetchMailBodies) and not stored.
 */
export interface ApiBases {
  calendar: string
  gmail: string
  drive: string
  docs: string
  chat: string
  userinfo: string
}
export const DEFAULT_BASES: ApiBases = {
  calendar: 'https://www.googleapis.com/calendar/v3',
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  drive: 'https://www.googleapis.com/drive/v3',
  docs: 'https://docs.googleapis.com/v1',
  chat: 'https://chat.googleapis.com/v1',
  userinfo: 'https://www.googleapis.com/oauth2/v3/userinfo'
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public reason: 'auth' | 'scope' | 'rate' | 'other'
  ) {
    super(message)
  }
}

export class GoogleApi {
  constructor(
    private deps: {
      token: (force?: boolean) => Promise<string | null>
      fetchImpl?: typeof fetch
      bases?: Partial<ApiBases>
    }
  ) {}

  base(k: keyof ApiBases): string {
    return this.deps.bases?.[k] ?? DEFAULT_BASES[k]
  }

  /** One retry for an expired token and, separately, one for a rate limit (each has its own flag). */
  async get<T>(url: string, tried: { auth?: boolean; rate?: boolean } = {}): Promise<T> {
    const f = this.deps.fetchImpl ?? fetch
    const token = await this.deps.token(!!tried.auth)
    if (!token) throw new ApiError(401, 'Not connected to Google.', 'auth')
    const res = await f(url, { headers: { authorization: `Bearer ${token}` } })
    if (res.ok) return (await res.json()) as T
    if (res.status === 401 && !tried.auth) return this.get<T>(url, { ...tried, auth: true })
    const body = await res.text().catch(() => '')
    if (res.status === 429 || res.status === 503) {
      if (!tried.rate) {
        const wait = Number(res.headers.get('retry-after')) || 2
        await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000))
        return this.get<T>(url, { ...tried, rate: true })
      }
      throw new ApiError(
        res.status,
        'Google is limiting how fast requests can be made right now. It will try again in a minute or two.',
        'rate'
      )
    }
    if (
      res.status === 403 &&
      /insufficient|scope|accessNotConfigured|has not been used|disabled/i.test(body)
    ) {
      throw new ApiError(403, scopeMessage(url, body), 'scope')
    }
    if (res.status === 401)
      throw new ApiError(401, 'Google access has expired. Connect again in Settings.', 'auth')
    throw new ApiError(res.status, `Google API error ${res.status}: ${body.slice(0, 200)}`, 'other')
  }
}

function scopeMessage(url: string, body: string): string {
  const api = /calendar/.test(url)
    ? 'Google Calendar API'
    : /gmail/.test(url)
      ? 'Gmail API'
      : /drive/.test(url)
        ? 'Google Drive API'
        : /docs/.test(url)
          ? 'Google Docs API'
          : /chat/.test(url)
            ? 'Google Chat API'
            : 'that Google API'
  return /accessNotConfigured|has not been used|disabled/i.test(body)
    ? `The ${api} is not enabled on your Google Cloud project. Enable it, then try again.`
    : `Google did not grant permission for the ${api}. Disconnect and connect again, approving everything it asks.`
}

const p2 = (n: number): string => String(n).padStart(2, '0')
const isoDay = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const hm = (d: Date): string => `${p2(d.getHours())}:${p2(d.getMinutes())}`

/**
 * Google Calendar's web app identifies an event as base64("<eventId> <calendarEmail>") without
 * padding. Producing the same id keeps notes linked when switching between sources.
 */
export const webEventId = (eventId: string, calendarEmail: string): string =>
  Buffer.from(`${eventId} ${calendarEmail}`).toString('base64').replace(/=+$/, '')

export interface CalendarApiResult {
  events: CalEvent[]
  details: { id: string; guests: Guest[]; meetUrl: string | null }[]
  owner: string | null
  selfEmail: string | null
  attachments: { eventId: string; fileId: string; title: string }[]
}

interface ApiEvent {
  id: string
  status?: string
  summary?: string
  eventType?: string
  recurringEventId?: string
  hangoutLink?: string
  attachments?: { fileId?: string; title?: string; mimeType?: string }[]
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  attendees?: {
    email?: string
    displayName?: string
    self?: boolean
    responseStatus?: string
    resource?: boolean
  }[]
}

export async function fetchCalendar(
  api: GoogleApi,
  opts: { daysBack: number; daysAhead: number; tz?: string; now?: Date }
): Promise<CalendarApiResult> {
  const now = opts.now ?? new Date()
  const me = await api.get<{ email?: string; name?: string }>(api.base('userinfo'))
  const selfEmail = me.email?.toLowerCase() ?? null
  const timeMin = new Date(now.getTime() - opts.daysBack * 86_400_000).toISOString()
  const timeMax = new Date(now.getTime() + opts.daysAhead * 86_400_000).toISOString()
  const events: CalEvent[] = []
  const details: CalendarApiResult['details'] = []
  const attachments: CalendarApiResult['attachments'] = []
  let pageToken: string | undefined
  do {
    const q = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: '250',
      fields:
        'nextPageToken,items(id,status,summary,eventType,hangoutLink,attachments(fileId,title,mimeType),start,end,attendees(email,displayName,self,responseStatus,resource))'
    })
    if (pageToken) q.set('pageToken', pageToken)
    const page = await api.get<{ items?: ApiEvent[]; nextPageToken?: string }>(
      `${api.base('calendar')}/calendars/primary/events?${q}`
    )
    for (const e of page.items ?? []) {
      if (e.status === 'cancelled') continue
      const id = webEventId(e.id, selfEmail ?? 'primary')
      const allDay = !!e.start?.date
      const start = e.start?.dateTime ? wallClock(new Date(e.start.dateTime), opts.tz) : null
      const end = e.end?.dateTime ? wallClock(new Date(e.end.dateTime), opts.tz) : null
      const date = allDay ? e.start!.date! : start ? isoDay(start) : null
      if (!date) continue
      const mine = e.attendees?.find((a) => a.self)
      const status = ((): RsvpStatus | null => {
        switch (mine?.responseStatus) {
          case 'accepted':
            return 'accepted'
          case 'declined':
            return 'declined'
          case 'tentative':
            return 'tentative'
          case 'needsAction':
            return 'needs_action'
          default:
            return null
        }
      })()
      events.push({
        id,
        date,
        startTime: start ? hm(start) : null,
        endTime: end ? hm(end) : null,
        allDay,
        title: (e.summary ?? '(No title)').trim(),
        status,
        kind:
          e.eventType === 'workingLocation' ? 'working_location' : allDay ? 'allday' : 'meeting',
        seriesId: e.recurringEventId ?? null
      })
      for (const f of e.attachments ?? [])
        if (f.fileId && (!f.mimeType || f.mimeType === 'application/vnd.google-apps.document'))
          attachments.push({ eventId: id, fileId: f.fileId, title: f.title ?? '' })
      details.push({
        id,
        guests: (e.attendees ?? [])
          .filter((a) => a.email && !a.self && !a.resource)
          .map((a) => ({ email: a.email!, name: a.displayName ?? null })),
        meetUrl: e.hangoutLink ?? null
      })
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return { events, details, owner: me.name ?? null, selfEmail, attachments }
}

// ------------------------------------------------------------------------------------ Gmail

interface ApiMessage {
  id: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: { headers?: { name: string; value: string }[] }
}

const header = (m: ApiMessage, name: string): string =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

/** "Jane Doe <jane@x.com>" or "jane@x.com" -> { name, email } */
export function parseAddress(v: string): { name: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v)
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() }
  const e = v.trim().replace(/^<|>$/g, '')
  return { name: e, email: e.toLowerCase() }
}

/** The time string the row parser already understands ("Fri, Nov 13, 2026, 10:47 AM"), in the user's zone. */
export function gmailTimeTitle(ms: number, tz?: string): string {
  const d = wallClock(new Date(ms), tz)
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++
      out[k] = await fn(items[k])
    }
  })
  await Promise.all(workers)
  return out
}

/** What the headers say about a thread: sent to me or only copied, bulk or automated, marked important. */
export function signalsOf(
  msgs: { labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } }[],
  selfEmail: string | null
): NonNullable<RawRow['signals']> {
  const h = (m: (typeof msgs)[number], n: string): string =>
    m.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? ''
  const self = (selfEmail ?? '').toLowerCase()
  const theirs = msgs.filter((m) => !self || !h(m, 'From').toLowerCase().includes(self))
  const lastTheirs = theirs[theirs.length - 1]
  const has = (s: string): boolean => !!self && s.toLowerCase().includes(self)
  return {
    toMe: lastTheirs ? has(h(lastTheirs, 'To')) : undefined,
    ccMe: lastTheirs ? has(h(lastTheirs, 'Cc')) : undefined,
    bulk: msgs.some(
      (m) =>
        !!h(m, 'List-Unsubscribe') ||
        /^(bulk|list|junk)$/i.test(h(m, 'Precedence').trim()) ||
        (!!h(m, 'Auto-Submitted') && !/^no$/i.test(h(m, 'Auto-Submitted').trim()))
    ),
    important: msgs.some((m) => (m.labelIds ?? []).includes('IMPORTANT')),
    msgCount: msgs.length
  }
}

export async function fetchGmail(
  api: GoogleApi,
  opts: { days: number; maxThreads?: number; tz?: string }
): Promise<GmailScrape> {
  const base = api.base('gmail')
  const me = await api.get<{ emailAddress?: string }>(`${base}/users/me/profile`)
  const selfEmail = me.emailAddress?.toLowerCase() ?? null
  const labels = await api.get<{ labels?: { id: string; name: string; type: string }[] }>(
    `${base}/users/me/labels`
  )
  const labelName = new Map(
    (labels.labels ?? []).map((l) => [l.id, { name: l.name, user: l.type === 'user' }])
  )

  const listThreads = async (q: string, cap: number): Promise<string[]> => {
    const ids: string[] = []
    let pageToken: string | undefined
    do {
      const p = new URLSearchParams({ q, maxResults: '100', fields: 'nextPageToken,threads(id)' })
      if (pageToken) p.set('pageToken', pageToken)
      const page = await api.get<{ threads?: { id: string }[]; nextPageToken?: string }>(
        `${base}/users/me/threads?${p}`
      )
      for (const t of page.threads ?? []) ids.push(t.id)
      pageToken = page.nextPageToken
    } while (pageToken && ids.length < cap)
    return ids.slice(0, cap)
  }

  const toRow = async (id: string): Promise<RawRow | null> => {
    const p = new URLSearchParams({
      format: 'metadata',
      fields: 'id,messages(id,labelIds,snippet,internalDate,payload/headers)'
    })
    for (const h of [
      'From',
      'Subject',
      'To',
      'Cc',
      'List-Unsubscribe',
      'Precedence',
      'Auto-Submitted'
    ])
      p.append('metadataHeaders', h)
    const t = await api.get<{ id: string; messages?: ApiMessage[] }>(
      `${base}/users/me/threads/${id}?${p}`
    )
    const msgs = (t.messages ?? []).filter((m) => !(m.labelIds ?? []).includes('DRAFT'))
    if (msgs.length === 0) return null
    const last = msgs[msgs.length - 1]
    const byEmail = new Map<string, RawRow['senders'][number]>()
    for (const m of msgs) {
      const a = parseAddress(header(m, 'From'))
      if (a.email) {
        byEmail.delete(a.email)
        byEmail.set(a.email, { name: a.email === selfEmail ? 'me' : a.name, email: a.email })
      }
    }
    const senders = [...byEmail.values()]
    const all = new Set(msgs.flatMap((m) => m.labelIds ?? []))
    const chips: string[] = []
    if (all.has('INBOX')) chips.push('Inbox')
    for (const l of all) {
      const info = labelName.get(l)
      if (info?.user) chips.push(info.name)
    }
    return {
      legacyId: id,
      threadId: null,
      senders, // oldest→newest so senders.at(-1) is the last message's sender (matching Gmail DOM & normalizeRows)
      subject: header(msgs[0], 'Subject') || header(last, 'Subject'),
      snippet: last.snippet ?? '',
      timeTitle: gmailTimeTitle(Number(last.internalDate ?? Date.now()), opts.tz),
      unread: msgs.some((m) => (m.labelIds ?? []).includes('UNREAD')),
      starred: msgs.some((m) => (m.labelIds ?? []).includes('STARRED')),
      labels: chips,
      signals: signalsOf(msgs, selfEmail)
    }
  }

  const ids = await listThreads(`${MAIL_QUERY} newer_than:${opts.days}d`, opts.maxThreads ?? 3000)
  const starredIds = await listThreads('is:starred', 200)
  const rows = (await mapLimit(ids, 6, toRow)).filter((r): r is RawRow => !!r)
  const starred = (
    await mapLimit(
      starredIds.filter((s) => !ids.includes(s)),
      6,
      toRow
    )
  ).filter((r): r is RawRow => !!r)
  return {
    signedIn: true,
    selfEmail,
    rows,
    starred: [...rows.filter((r) => r.starred), ...starred],
    pages: Math.ceil(ids.length / 100),
    reachedCutoff: ids.length < (opts.maxThreads ?? 3000)
  }
}

// ----------------------------------------------------------------------- Meet notes (Drive + Docs)

export interface MeetArtifact {
  /** The calendar event it was attached to, when the source knows (exact match). */
  eventId?: string | null
  fileId: string
  name: string
  kind: 'notes' | 'transcript'
  createdAt: string
  text: string
}

interface DocNode {
  paragraph?: { elements?: { textRun?: { content?: string } }[] }
  table?: { tableRows?: { tableCells?: { content?: DocNode[] }[] }[] }
}

/** Plain text of a Google Doc body (paragraphs and table cells). */
export function docText(body: { content?: DocNode[] } | undefined): string {
  const out: string[] = []
  const walk = (nodes: DocNode[] | undefined): void => {
    for (const n of nodes ?? []) {
      if (n.paragraph)
        out.push((n.paragraph.elements ?? []).map((e) => e.textRun?.content ?? '').join(''))
      if (n.table)
        for (const row of n.table.tableRows ?? [])
          for (const cell of row.tableCells ?? []) walk(cell.content)
    }
  }
  walk(body?.content)
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Gemini's "Notes by Gemini" and "Transcript" docs that Meet saves to Drive, newer than `since`. */
const MEET_TITLE = /notes by gemini|gemini notes|transcript/i

export async function fetchMeetArtifacts(
  api: GoogleApi,
  opts: {
    sinceIso: string
    known: Set<string>
    max?: number
    /** Documents attached to calendar events: exact links, fetched even if the name is unusual. */
    attached?: { eventId: string; fileId: string; title: string }[]
  }
): Promise<MeetArtifact[]> {
  const q = `mimeType='application/vnd.google-apps.document' and trashed=false and modifiedTime > '${opts.sinceIso}' and (name contains 'Notes by Gemini' or name contains 'Transcript' or name contains 'Gemini')`
  const p = new URLSearchParams({
    q,
    orderBy: 'modifiedTime desc',
    pageSize: String(opts.max ?? 25),
    fields: 'files(id,name,createdTime,modifiedTime)'
  })
  const list = await api.get<{ files?: { id: string; name: string; createdTime: string }[] }>(
    `${api.base('drive')}/files?${p}`
  )
  const out: MeetArtifact[] = []
  const eventOf = new Map((opts.attached ?? []).map((x) => [x.fileId, x.eventId]))
  const seen = new Set<string>()
  for (const x of opts.attached ?? []) {
    if (opts.known.has(x.fileId) || seen.has(x.fileId) || !MEET_TITLE.test(x.title)) continue
    seen.add(x.fileId)
    const doc = await api.get<{ body?: { content?: DocNode[] } }>(
      `${api.base('docs')}/documents/${x.fileId}?fields=body`
    )
    out.push({
      fileId: x.fileId,
      name: x.title,
      kind: /transcript/i.test(x.title) ? 'transcript' : 'notes',
      createdAt: new Date().toISOString(),
      eventId: x.eventId,
      text: docText(doc.body)
    })
  }
  for (const f of list.files ?? []) {
    if (opts.known.has(f.id) || seen.has(f.id)) continue
    const kind: MeetArtifact['kind'] = /transcript/i.test(f.name) ? 'transcript' : 'notes'
    const doc = await api.get<{ body?: { content?: DocNode[] } }>(
      `${api.base('docs')}/documents/${f.id}?fields=body`
    )
    out.push({
      fileId: f.id,
      name: f.name,
      kind,
      createdAt: f.createdTime,
      eventId: eventOf.get(f.id) ?? null,
      text: docText(doc.body)
    })
  }
  return out
}

// ------------------------------------------------------------------------------------- Chat

export type ChatMsg = ChatIn

type ChatSpace = { name: string; displayName?: string; spaceType?: string; spaceDetails?: unknown }
type ApiChatMsg = {
  name: string
  text?: string
  createTime: string
  thread?: { name?: string }
  sender?: { name?: string; displayName?: string; type?: string }
  annotations?: { type?: string; userMention?: { user?: { name?: string } } }[]
}

/** Every space I can read (DMs, group chats, spaces), with messages since `sinceIso`. */
export async function fetchChat(
  api: GoogleApi,
  opts: { sinceIso: string; perSpace?: number }
): Promise<ChatIn[]> {
  const base = api.base('chat')
  const spaces: ChatSpace[] = []
  let token = ''
  do {
    const page = await api.get<{ spaces?: ChatSpace[]; nextPageToken?: string }>(
      `${base}/spaces?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}&fields=spaces(name,displayName,spaceType),nextPageToken`
    )
    spaces.push(...(page.spaces ?? []))
    token = page.nextPageToken ?? ''
  } while (token && spaces.length < 500)

  // My own user id, to know which messages are mine and which mention me.
  let myId: string | null = null
  for (const s of spaces.slice(0, 3)) {
    try {
      const m = await api.get<{ member?: { name?: string } }>(`${base}/${s.name}/members/me`)
      if (m.member?.name) {
        myId = m.member.name
        break
      }
    } catch {
      /* try the next space */
    }
  }

  const out: ChatIn[] = []
  for (const s of spaces) {
    const type: ChatIn['spaceType'] =
      s.spaceType === 'DIRECT_MESSAGE' ? 'dm' : s.spaceType === 'GROUP_CHAT' ? 'group' : 'space'
    const p = new URLSearchParams({
      pageSize: String(opts.perSpace ?? 50),
      orderBy: 'createTime desc',
      filter: `createTime > "${opts.sinceIso}"`,
      fields: 'messages(name,text,createTime,thread/name,sender(name,displayName,type),annotations)'
    })
    let page: { messages?: ApiChatMsg[] }
    try {
      page = await api.get(`${base}/${s.name}/messages?${p}`)
    } catch (err) {
      if (err instanceof ApiError && err.reason === 'other') continue // a space we cannot read
      throw err
    }
    for (const m of page.messages ?? []) {
      if (m.sender?.type === 'BOT') continue
      out.push({
        id: m.name,
        space: s.name,
        spaceName:
          s.displayName ||
          (type === 'dm' ? 'Direct message' : type === 'group' ? 'Group chat' : s.name),
        spaceType: type,
        sender: m.sender?.displayName || 'Someone',
        senderId: m.sender?.name ?? null,
        text: (m.text ?? '').replace(/\s+/g, ' ').slice(0, 4000),
        createdAt: m.createTime,
        thread: m.thread?.name ?? null,
        fromMe: !!myId && m.sender?.name === myId,
        mentionsMe:
          !!myId &&
          (m.annotations ?? []).some(
            (a) => a.type === 'USER_MENTION' && a.userMention?.user?.name === myId
          )
      })
    }
  }
  return out
}

// ------------------------------------------------------------------- Email text (read, not kept)

/** The last few messages of each given thread, as text. Used only to find actions and decisions. */
export async function fetchMailBodies(api: GoogleApi, ids: string[]): Promise<MailBody[]> {
  const out: MailBody[] = []
  for (const id of ids.slice(0, 25)) {
    let t: {
      id: string
      messages?: {
        id: string
        internalDate?: string
        payload?: GmailPart & { headers?: { name: string; value: string }[] }
      }[]
    }
    try {
      t = await api.get(`${api.base('gmail')}/users/me/threads/${id}?format=full`)
    } catch (err) {
      if (err instanceof ApiError && err.reason === 'other') continue
      throw err
    }
    const msgs = (t.messages ?? []).slice(-4)
    if (!msgs.length) continue
    const hdr = (m: (typeof msgs)[number], n: string): string =>
      m.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? ''
    out.push({
      threadId: t.id,
      subject: hdr(msgs[0], 'Subject'),
      messages: msgs.map((m) => {
        const from = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(hdr(m, 'From'))
        return {
          id: m.id,
          from: (from?.[1] || from?.[2] || hdr(m, 'From')).trim(),
          fromEmail: from?.[2] ?? '',
          at: new Date(Number(m.internalDate ?? Date.now())).toISOString(),
          text: textOfPayload(m.payload).slice(0, 20000)
        }
      })
    })
  }
  return out
}
