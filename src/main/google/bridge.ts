import { z } from 'zod'
import type { MailBody } from './mailBody'
import type { CalendarScrape } from '../calendar/sync'
import type { CrawlOptions, GmailScrape } from '../gmail/sync'
import type { RawRow } from '../gmail/parse'
import type { ChatIn } from '../chat/types'
import type { MeetArtifact } from './api'
import { gmailTimeTitle } from './api'

/**
 * Client for the Apps Script bridge (google-bridge/Code.gs). The call goes through the signed-in
 * Google session (cookies) as a plain HTTPS request: no window, nothing rendered, no screen-reading.
 * Every response is validated; anything unexpected becomes a typed BridgeError with a plain remedy.
 */
export const MIN_BRIDGE_VERSION = 5
export const CONTRACT = 1

/**
 * A deployed web app address. Personal accounts get /macros/s/ID/exec; Workspace accounts get
 * /a/macros/DOMAIN/s/ID/exec (older domains /a/DOMAIN/macros/s/ID/exec).
 */
export const isBridgeUrl = (u: string): boolean =>
  /^https:\/\/script\.google\.com\/(?:macros\/s|a\/macros\/[^/\s]+\/s|a\/[^/\s]+\/macros\/s)\/[\w-]+\/exec$/.test(
    u
  )

export type BridgeErrorCode =
  | 'not-configured'
  | 'needs-login'
  | 'blocked'
  | 'needs-update'
  | 'bad-token'
  | 'timeout'
  | 'network'
  | 'invalid'
  | 'rate-limited'
  | 'error'

/** Google's "too many requests this minute" answers, in the words its APIs use. */
export const QUOTA_RE =
  /quota exceeded|rate[- ]?limit|too many requests|user-?rate-?limit|units per minute|resource_exhausted/i

/** Actions that read a lot of mail: only one at a time, a moment apart, so we stay under the quota. */
const HEAVY = new Set(['mail', 'mailBodies', 'chat', 'snapshot'])

export class BridgeError extends Error {
  constructor(
    public code: BridgeErrorCode,
    message: string
  ) {
    super(message)
  }
}

const Ping = z.object({
  ok: z.literal(true),
  version: z.number(),
  contract: z.number(),
  email: z.string()
})

const Guest = z.object({ email: z.string(), name: z.string().nullable() })
const CalendarData = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      startTime: z.string().nullable(),
      endTime: z.string().nullable(),
      allDay: z.boolean(),
      title: z.string(),
      status: z.enum(['accepted', 'declined', 'tentative', 'needs_action']).nullable(),
      kind: z.enum(['meeting', 'working_location', 'task', 'allday'])
    })
  ),
  details: z.array(
    z.object({ id: z.string(), guests: z.array(Guest), meetUrl: z.string().nullable() })
  ),
  owner: z.string().nullable(),
  selfEmail: z.string().nullable(),
  attachments: z
    .array(z.object({ eventId: z.string(), fileId: z.string(), title: z.string() }))
    .default([])
})
const MailData = z.object({
  rows: z.array(
    z.object({
      legacyId: z.string().nullable(),
      threadId: z.string().nullable(),
      senders: z.array(z.object({ name: z.string(), email: z.string() })),
      subject: z.string(),
      snippet: z.string(),
      lastMs: z.number(),
      unread: z.boolean(),
      starred: z.boolean(),
      labels: z.array(z.string())
    })
  ),
  nextPageToken: z.string().nullable(),
  historyId: z.string().nullable(),
  resync: z.boolean().default(false),
  selfEmail: z.string().nullable()
})
const MeetData = z.object({
  files: z.array(
    z.object({
      fileId: z.string(),
      name: z.string(),
      kind: z.enum(['notes', 'transcript']),
      createdAt: z.string(),
      eventId: z.string().nullable(),
      text: z.string()
    })
  )
})
const ChatData = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      space: z.string(),
      spaceType: z.enum(['dm', 'group', 'space']),
      sender: z.string(),
      text: z.string(),
      createdAt: z.string(),
      mentionsMe: z.boolean(),
      fromMe: z.boolean(),
      thread: z.string().nullable()
    })
  ),
  coverage: z.string().optional()
})

const MailBodies = z.object({
  threads: z.array(
    z.object({
      threadId: z.string(),
      subject: z.string(),
      messages: z.array(
        z.object({
          id: z.string(),
          from: z.string(),
          fromEmail: z.string().default(''),
          at: z.string(),
          text: z.string()
        })
      )
    })
  )
})

const SelfTest = z.object({
  ok: z.literal(true),
  version: z.number(),
  email: z.string(),
  sections: z.record(
    z.string(),
    z.object({ ok: z.boolean(), ms: z.number().optional(), error: z.string().optional() })
  )
})

export interface BridgeDeps {
  url: () => string
  token: () => string | null
  /** Authenticated (session cookies) fetch. */
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  tz: () => string | undefined
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Pause between big reads (default 1.5 s) and between mail pages (default 3.5 s). */
  gapMs?: number
  paceMs?: number
}

export class BridgeClient {
  private inflight = new Map<string, Promise<unknown>>()
  private gate: Promise<unknown> = Promise.resolve()
  private sleep = (ms: number): Promise<void> =>
    (this.deps.sleep ?? ((n) => new Promise<void>((r) => setTimeout(r, n))))(ms)
  constructor(private deps: BridgeDeps) {}

  configured(): boolean {
    return !!this.deps.url().trim() && !!this.deps.token()
  }

  /** One request, with a retry on transient failures. Identical simultaneous calls share one request. */
  private async call(
    action: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<unknown> {
    const key = action + JSON.stringify(params)
    const running = this.inflight.get(key)
    if (running) return running
    const run = (): Promise<unknown> => this.callOnce(action, params)
    let p: Promise<unknown>
    if (HEAVY.has(action)) {
      // One heavy read at a time, with a short gap, whatever part of the app asked.
      const turn = this.gate.then(run, run)
      this.gate = turn.then(
        () => this.sleep(this.deps.gapMs ?? 1500),
        () => this.sleep(this.deps.gapMs ?? 1500)
      )
      p = turn.finally(() => this.inflight.delete(key))
    } else p = run().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async callOnce(
    action: string,
    params: Record<string, string | number | undefined>
  ): Promise<unknown> {
    if (!this.configured())
      throw new BridgeError('not-configured', 'The Google bridge is not set up yet.')
    const u = new URL(this.deps.url().trim())
    u.searchParams.set('action', action)
    u.searchParams.set('token', this.deps.token()!)
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v))
    let lastErr: BridgeError | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.once(u.toString())
      } catch (err) {
        if (!(err instanceof BridgeError)) throw err
        lastErr = err
        // Only network blips and timeouts are worth retrying; everything else will not change.
        if (err.code !== 'network' && err.code !== 'timeout') throw err
        await (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
          300 * 2 ** attempt + Math.random() * 200
        )
      }
    }
    throw lastErr!
  }

  private async once(url: string): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.deps.timeoutMs ?? 60_000)
    let res: Response
    try {
      res = await this.deps.fetchImpl(url, { redirect: 'follow', signal: ctrl.signal })
    } catch (err) {
      throw new BridgeError(
        (err as Error).name === 'AbortError' ? 'timeout' : 'network',
        (err as Error).name === 'AbortError'
          ? 'Google took too long to answer.'
          : 'Could not reach Google. Check your connection.'
      )
    } finally {
      clearTimeout(timer)
    }
    const type = res.headers.get('content-type') ?? ''
    const body = await res.text().catch(() => '')
    // A sign-in redirect is HTML from accounts.google.com, not JSON.
    if (
      /accounts\.google\.com/.test(res.url ?? '') ||
      (/html/i.test(type) && /ServiceLogin|signin|Sign in/i.test(body))
    )
      throw new BridgeError('needs-login', 'Sign in to Google again.')
    if (
      res.status === 403 ||
      (/administrator|not allowed|policy/i.test(body.slice(0, 600)) && !/^\s*[{[]/.test(body))
    )
      throw new BridgeError(
        'blocked',
        'Google (or your administrator) blocked the script. Check the deployment settings.'
      )
    if (res.status === 404)
      throw new BridgeError(
        'blocked',
        'The script address was not found. Re-deploy it and paste the new address.'
      )
    if (!res.ok) throw new BridgeError('error', `Google answered with an error (${res.status}).`)
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      throw new BridgeError(
        'invalid',
        'The script returned something unexpected. Re-deploy it as a Web app.'
      )
    }
    const err = (json as { ok?: boolean; error?: string }).error
    if (err === 'bad-token')
      throw new BridgeError(
        'bad-token',
        'The script has a different key. Copy the script again from Settings.'
      )
    if (err === 'wrong-user')
      throw new BridgeError(
        'blocked',
        'The script must be deployed to run as you, accessible only by you.'
      )
    if ((json as { ok?: boolean }).ok === false && err && QUOTA_RE.test(err))
      throw new BridgeError(
        'rate-limited',
        'Google is limiting how fast mail can be read right now. It will try again in a minute or two.'
      )
    if ((json as { ok?: boolean }).ok === false && err) throw new BridgeError('error', err)
    return json
  }

  private parse<T extends z.ZodType>(schema: T, v: unknown, what: string): z.infer<T> {
    const r = schema.safeParse(v)
    if (!r.success)
      throw new BridgeError(
        'invalid',
        `The script's ${what} answer was not in the expected shape. Update the script in Settings.`
      )
    return r.data
  }

  /** Handshake: reachable, signed in, token right, and new enough. */
  async ping(): Promise<{ email: string; version: number }> {
    const p = this.parse(Ping, await this.call('ping'), 'ping')
    if (p.version < MIN_BRIDGE_VERSION || p.contract !== CONTRACT)
      throw new BridgeError(
        'needs-update',
        `The script is out of date (v${p.version}, need v${MIN_BRIDGE_VERSION}). Copy it again and deploy a new version.`
      )
    return { email: p.email, version: p.version }
  }

  async selfTest(): Promise<z.infer<typeof SelfTest>> {
    return this.parse(SelfTest, await this.call('selfTest'), 'self-test')
  }

  async calendar(): Promise<CalendarScrape> {
    const d = this.parse(CalendarData, await this.raw('calendar', {}), 'calendar')
    return {
      signedIn: true,
      events: d.events,
      details: d.details,
      owner: d.owner,
      selfEmail: d.selfEmail,
      attachments: d.attachments
    }
  }

  /** The script returns the handler's object directly (it has no `ok` for sections); accept both shapes. */
  private async raw(
    action: string,
    params: Record<string, string | number | undefined>
  ): Promise<unknown> {
    const j = (await this.call(action, params)) as Record<string, unknown>
    return j && typeof j === 'object' && 'data' in j && j.ok === true ? j.data : j
  }

  /** Mail rows. First read pages until done; with `sinceHistoryId` only what changed is fetched. */
  async mail(
    opts: CrawlOptions & { sinceHistoryId?: string | null }
  ): Promise<GmailScrape & { historyId: string | null; resync: boolean }> {
    const rows: RawRow[] = []
    let page: string | null = null
    let pages = 0
    let selfEmail: string | null = null
    let historyId: string | null = null
    const cap = Math.max(1, Math.min(opts.maxPages, 60))
    let rateLimited = false
    do {
      let d: z.infer<typeof MailData>
      try {
        d = this.parse(
          MailData,
          await this.raw('mail', {
            days: opts.days,
            max: 30,
            pageToken: page ?? undefined,
            sinceHistoryId: pages === 0 ? (opts.sinceHistoryId ?? undefined) : undefined
          }),
          'mail'
        )
      } catch (err) {
        // Google slowed us down after some pages: keep what we have instead of losing it all.
        if (err instanceof BridgeError && err.code === 'rate-limited' && rows.length > 0) {
          rateLimited = true
          break
        }
        throw err
      }
      pages++
      if (pages > 1) await this.sleep(this.deps.paceMs ?? 3500)
      if (d.resync)
        return {
          signedIn: true,
          selfEmail: d.selfEmail,
          rows: [],
          starred: [],
          pages,
          reachedCutoff: false,
          historyId: null,
          resync: true,
          incremental: false
        }
      selfEmail = d.selfEmail ?? selfEmail
      historyId = historyId ?? d.historyId
      for (const r of d.rows)
        rows.push({
          legacyId: r.legacyId,
          threadId: r.threadId,
          senders: r.senders,
          subject: r.subject,
          snippet: r.snippet,
          timeTitle: gmailTimeTitle(r.lastMs, this.deps.tz()),
          unread: r.unread,
          starred: r.starred,
          labels: r.labels
        })
      page = opts.sinceHistoryId ? null : d.nextPageToken
    } while (page && pages < cap)
    return {
      signedIn: true,
      selfEmail,
      rows,
      starred: rows.filter((r) => r.starred),
      pages,
      reachedCutoff: !page && !rateLimited,
      rateLimited,
      historyId: rateLimited ? null : historyId,
      resync: false,
      incremental: !!opts.sinceHistoryId
    }
  }

  async meet(
    known: string[],
    sinceIso?: string
  ): Promise<(MeetArtifact & { eventId: string | null })[]> {
    const d = this.parse(
      MeetData,
      await this.raw('meet', { known: known.slice(0, 200).join(','), since: sinceIso }),
      'meet'
    )
    return d.files.map((f) => ({
      fileId: f.fileId,
      name: f.name,
      kind: f.kind,
      createdAt: f.createdAt,
      text: f.text,
      eventId: f.eventId
    }))
  }

  /** The text of up to 25 threads (read in memory by the caller, never stored). */
  async mailBodies(ids: string[]): Promise<MailBody[]> {
    if (ids.length === 0) return []
    const d = this.parse(
      MailBodies,
      await this.raw('mailBodies', { ids: ids.slice(0, 25).join(',') }),
      'mail text'
    )
    return d.threads
  }

  async chat(days = 7): Promise<ChatIn[]> {
    const d = this.parse(ChatData, await this.raw('chat', { days }), 'chat')
    return d.messages.map((m) => ({
      id: m.id,
      space: m.space,
      spaceName: m.space.startsWith('dm:') ? 'Direct message' : m.space,
      spaceType: m.spaceType,
      sender: m.sender,
      senderId: null,
      text: m.text.slice(0, 4000),
      createdAt: m.createdAt,
      thread: m.thread,
      mentionsMe: m.mentionsMe,
      fromMe: m.fromMe
    }))
  }
}
