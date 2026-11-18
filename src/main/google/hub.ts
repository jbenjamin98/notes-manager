import type { CalendarScrape } from '../calendar/sync'
import type { MailBody } from './mailBody'
import type { CrawlOptions, GmailScrape } from '../gmail/sync'
import type { BridgeClient } from './bridge'
import { BridgeError } from './bridge'
import type { Db } from '../db'
import type { Vault } from '../vault/vault'
import { ingestChat } from '../chat/ingest'
import { applyMeetArtifacts, knownArtifacts, type MeetingRead } from './meet'

/**
 * Picks the source for each section: OAuth first (official, complete), then the Apps Script bridge,
 * otherwise "signed out" so the last-good data stays and the UI shows a reconnect hint.
 */
export interface OAuthLike {
  active(): boolean
  calendar(): Promise<CalendarScrape>
  gmail(o: CrawlOptions): Promise<GmailScrape>
  mailBodies(ids: string[]): Promise<MailBody[]>
  /** Meet notes into the vault and recent Chat into the index. Reports errors, never throws. */
  extras(vault: Vault | null): Promise<void>
}

/** What the script path needs to bring in Meet notes and Chat (the OAuth path has its own). */
export interface ExtrasDeps {
  db: Db
  settings: () => { meetNotes: boolean; meetFullText?: boolean }
  onMeeting?: (m: MeetingRead) => Promise<unknown>
}

const signedOutCal: CalendarScrape = {
  signedIn: false,
  events: [],
  details: [],
  owner: null,
  selfEmail: null
}

export class GoogleHub {
  constructor(
    private oauth: OAuthLike,
    private bridge: BridgeClient,
    private extrasDeps?: ExtrasDeps
  ) {}

  private soft<T>(err: unknown, empty: T): T {
    // Not signed in / not set up are states, not failures; everything else surfaces as an error.
    if (err instanceof BridgeError && (err.code === 'needs-login' || err.code === 'not-configured'))
      return empty
    throw err
  }

  async calendar(): Promise<CalendarScrape> {
    if (this.oauth.active()) return this.oauth.calendar()
    try {
      return await this.bridge.calendar()
    } catch (err) {
      return this.soft(err, signedOutCal)
    }
  }

  /**
   * Meet notes and Chat from whichever source is active (one call, so nobody else has to know which
   * mode is in use). Returns an error message to show, or null.
   */
  async extras(vault: Vault | null): Promise<string | null> {
    if (this.oauth.active()) {
      await this.oauth.extras(vault)
      return null
    }
    const d = this.extrasDeps
    if (!d) return null
    const s = d.settings()
    return bridgeExtras(
      this.bridge,
      d.db,
      vault,
      { meetNotes: s.meetNotes, meetFullText: s.meetFullText, chat: true },
      d.onMeeting
    )
  }

  /** Is any source set up to read mail? */
  mailAvailable(): boolean {
    return this.oauth.active() || this.bridge.configured()
  }

  /** Email text for the insight reader; empty when signed out or not set up. */
  async mailBodies(ids: string[]): Promise<MailBody[]> {
    if (this.oauth.active()) return this.oauth.mailBodies(ids)
    try {
      return await this.bridge.mailBodies(ids)
    } catch (err) {
      return this.soft(err, [])
    }
  }

  async mail(o: CrawlOptions): Promise<GmailScrape> {
    if (this.oauth.active()) return this.oauth.gmail(o)
    try {
      return await this.bridge.mail(o)
    } catch (err) {
      return this.soft(err, {
        signedIn: false,
        selfEmail: null,
        rows: [],
        starred: [],
        pages: 0,
        reachedCutoff: false
      })
    }
  }
}

/** Meet notes and Chat through the bridge (used when OAuth is not connected). Never throws. */
export async function bridgeExtras(
  bridge: BridgeClient,
  db: Db,
  vault: Vault | null,
  s: { meetNotes: boolean; chat: boolean; meetFullText?: boolean },
  onMeeting?: (m: MeetingRead) => Promise<unknown>
): Promise<string | null> {
  if (!bridge.configured()) return null
  let error: string | null = null
  const kvSet = (k: string, v: string): void => {
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(k, v)
  }
  if (s.meetNotes && vault) {
    try {
      const arts = await bridge.meet([...knownArtifacts(db)])
      await applyMeetArtifacts(db, vault, arts, { fullText: s.meetFullText, onMeeting })
    } catch (err) {
      error = `Meet notes: ${(err as Error).message}`
    }
  }
  if (s.chat) {
    try {
      ingestChat(db, await bridge.chat(7))
      kvSet('chat.lastAt', new Date().toISOString())
    } catch (err) {
      error = `Chat: ${(err as Error).message}`
    }
  }
  return error
}
