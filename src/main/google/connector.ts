import type { Db } from '../db'
import type { MailBody } from './mailBody'
import { ingestChat } from '../chat/ingest'
import { defaultClientId, defaultClientSecret, effectiveClientId } from './defaults'
import type { Vault } from '../vault/vault'
import type { CalendarScrape } from '../calendar/sync'
import type { CrawlOptions, GmailScrape } from '../gmail/sync'
import type { SecretStore } from '../services/secrets'
import { GoogleOAuth, OAuthError, SCOPES } from './oauth'
import {
  ApiError,
  GoogleApi,
  fetchCalendar,
  fetchChat,
  fetchGmail,
  fetchMailBodies,
  fetchMeetArtifacts,
  type ApiBases
} from './api'
import { applyMeetArtifacts, knownArtifacts, type MeetingRead } from './meet'

export interface GoogleSettings {
  /** 'script' = your Apps Script web app. 'oauth' = Google sign-in with the official APIs. */
  method: 'script' | 'oauth'
  clientId: string
  meetNotes: boolean
  meetFullText?: boolean
  chat: boolean
}

export interface ConnectorStatus {
  method: 'script' | 'oauth'
  hasClient: boolean
  defaultClient: boolean
  connected: boolean
  email: string | null
  scopes: { calendar: boolean; gmail: boolean; meet: boolean; chat: boolean }
  lastError: string | null
  meet: { files: number; lastAt: string | null }
  chat: { messages: number; lastAt: string | null }
}

const kvGet = (db: Db, k: string): string | null =>
  (db.prepare('SELECT value FROM kv WHERE key = ?').get(k) as { value: string } | undefined)
    ?.value ?? null
const kvSet = (db: Db, k: string, v: string): void => {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(k, v)
}

/**
 * The official-API path to Google. It produces exactly what the browser-session scrapers produce,
 * so CalendarSync and GmailSync do not know which one fed them. Meet notes and Chat only exist here.
 */
export class GoogleConnector {
  readonly oauth: GoogleOAuth
  readonly api: GoogleApi
  private lastError: string | null = null

  constructor(
    private deps: {
      db: Db
      secrets: SecretStore
      getSettings: () => GoogleSettings
      /** Called for each meeting document read, to look for what matters in it. */
      onMeeting?: (m: MeetingRead) => Promise<unknown>
      tz: () => string | undefined
      openExternal: (url: string) => void
      fetchImpl?: typeof fetch
      bases?: Partial<ApiBases>
      authUrl?: string
      tokenUrl?: string
    }
  ) {
    this.oauth = new GoogleOAuth({
      clientId: () => effectiveClientId(deps.getSettings().clientId),
      // The company client's secret when built in; an older pasted one otherwise.
      clientSecret: () =>
        (defaultClientId() ? defaultClientSecret() : '') || deps.secrets.get('google.clientSecret'),
      loadRefreshToken: () => deps.secrets.get('google.refreshToken'),
      saveRefreshToken: (t) =>
        t ? deps.secrets.set('google.refreshToken', t) : deps.secrets.delete('google.refreshToken'),
      openExternal: deps.openExternal,
      fetchImpl: deps.fetchImpl,
      authUrl: deps.authUrl,
      tokenUrl: deps.tokenUrl
    })
    this.api = new GoogleApi({
      token: (force) => this.oauth.accessToken(force),
      fetchImpl: deps.fetchImpl,
      bases: deps.bases
    })
  }

  /** True when syncs should go through the APIs rather than the browser session. */
  active(): boolean {
    return this.oauth.connected()
  }

  status(): ConnectorStatus {
    const s = this.deps.getSettings()
    const granted = new Set(this.oauth.grantedScopes())
    const has = (xs: string[]): boolean =>
      granted.size === 0 ? this.oauth.connected() : xs.every((x) => granted.has(x))
    return {
      method: s.method,
      hasClient: !!effectiveClientId(s.clientId),
      defaultClient: !!defaultClientId(),
      connected: this.oauth.connected(),
      email: kvGet(this.deps.db, 'google.email'),
      scopes: {
        calendar: has([SCOPES.base[3]]),
        gmail: has([SCOPES.base[4]]),
        meet:
          this.oauth.connected() && granted.size > 0
            ? SCOPES.meet.every((x) => granted.has(x))
            : s.meetNotes,
        chat:
          this.oauth.connected() && granted.size > 0
            ? SCOPES.chat.every((x) => granted.has(x))
            : s.chat
      },
      lastError: this.lastError,
      meet: {
        files: (
          this.deps.db.prepare('SELECT count(*) AS c FROM meet_artifacts').get() as { c: number }
        ).c,
        lastAt: kvGet(this.deps.db, 'meet.lastAt')
      },
      chat: {
        messages: (
          this.deps.db.prepare('SELECT count(*) AS c FROM chat_messages').get() as { c: number }
        ).c,
        lastAt: kvGet(this.deps.db, 'chat.lastAt')
      }
    }
  }

  async connect(): Promise<ConnectorStatus> {
    const s = this.deps.getSettings()
    const scopes = [
      ...SCOPES.base,
      ...(s.meetNotes ? SCOPES.meet : []),
      ...(s.chat ? SCOPES.chat : [])
    ]
    this.lastError = null
    try {
      await this.oauth.connect(scopes)
      const me = await this.api.get<{ email?: string }>(this.api.base('userinfo'))
      if (me.email) kvSet(this.deps.db, 'google.email', me.email)
    } catch (err) {
      this.lastError = (err as Error).message
      throw err
    }
    return this.status()
  }

  disconnect(): ConnectorStatus {
    this.oauth.disconnect()
    this.deps.db
      .prepare("DELETE FROM kv WHERE key IN ('google.email','meet.lastAt','chat.lastAt')")
      .run()
    this.lastError = null
    return this.status()
  }

  private fail(err: unknown): never {
    this.lastError = (err as Error).message
    throw err
  }

  /** Same shape as the browser scraper, plus ready-made events and guests (no detail page needed). */
  /** Thread text for the insight reader (read in memory, never stored). */
  async mailBodies(ids: string[]): Promise<MailBody[]> {
    return fetchMailBodies(this.api, ids)
  }

  async calendar(): Promise<CalendarScrape> {
    try {
      const r = await fetchCalendar(this.api, { daysBack: 30, daysAhead: 60, tz: this.deps.tz() })
      this.lastError = null
      return {
        signedIn: true,
        events: r.events,
        details: r.details,
        owner: r.owner,
        selfEmail: r.selfEmail,
        attachments: r.attachments
      }
    } catch (err) {
      if (err instanceof OAuthError || (err instanceof ApiError && err.reason === 'auth'))
        return { signedIn: false, events: [], details: [], owner: null, selfEmail: null }
      return this.fail(err)
    }
  }

  async gmail(opts: CrawlOptions): Promise<GmailScrape> {
    try {
      const r = await fetchGmail(this.api, {
        days: opts.days,
        maxThreads: opts.maxPages * 50,
        tz: this.deps.tz()
      })
      this.lastError = null
      return r
    } catch (err) {
      if (err instanceof OAuthError || (err instanceof ApiError && err.reason === 'auth'))
        return {
          signedIn: false,
          selfEmail: null,
          rows: [],
          starred: [],
          pages: 0,
          reachedCutoff: false
        }
      return this.fail(err)
    }
  }

  /** Meet notes into the vault, and recent Chat messages into the index. Errors are reported, not thrown. */
  async extras(vault: Vault | null): Promise<void> {
    const s = this.deps.getSettings()
    if (!this.active()) return
    if (s.meetNotes && vault) {
      try {
        const since =
          kvGet(this.deps.db, 'meet.lastAt') ?? new Date(Date.now() - 14 * 86_400_000).toISOString()
        const arts = await fetchMeetArtifacts(this.api, {
          sinceIso: since,
          known: knownArtifacts(this.deps.db),
          attached: this.deps.db
            .prepare('SELECT event_id AS eventId, file_id AS fileId, title FROM event_attachments')
            .all() as { eventId: string; fileId: string; title: string }[]
        })
        await applyMeetArtifacts(this.deps.db, vault, arts, {
          fullText: s.meetFullText,
          onMeeting: this.deps.onMeeting
        })
        kvSet(this.deps.db, 'meet.lastAt', new Date(Date.now() - 6 * 3600_000).toISOString()) // overlap: Drive timestamps lag
      } catch (err) {
        this.lastError = `Meet notes: ${(err as Error).message}`
      }
    }
    {
      try {
        const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
        const msgs = await fetchChat(this.api, { sinceIso: since })
        ingestChat(this.deps.db, msgs)
        kvSet(this.deps.db, 'chat.lastAt', new Date().toISOString())
      } catch (err) {
        this.lastError = `Chat: ${(err as Error).message}`
      }
    }
  }
}
