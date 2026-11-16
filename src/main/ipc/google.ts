import { openLogin } from '../services/google'
import { getSettings, updateSettings } from '../services/settings'
import { MIN_BRIDGE_VERSION, isBridgeUrl } from '../google/bridge'
import { runSelfTest, lastSelfTest } from '../google/health'
import { bridgeExtras } from '../google/hub'
import { randomBytes } from 'node:crypto'
import bridgeScript from '../../../google-bridge/Code.gs?raw'
import bridgeManifest from '../../../google-bridge/appsscript.json?raw'
import { connectionState, type Connection } from '../google/connection'
import { localDate } from '../calendar/sync'
import type { Ctx, Handlers } from './types'

/** The one connection state, from everything main knows. */
export function connectionFor(ctx: Ctx): Connection {
  const api = ctx.google.status()
  const t = lastSelfTest(ctx.db)
  return connectionState({
    apiActive: ctx.google.active(),
    apiEmail: api.email,
    bridgeUrl: getSettings().google.bridgeUrl,
    hasToken: !!ctx.secrets.get('bridge.token'),
    selfTest: t ? { code: t.code, message: t.message, email: t.email } : null,
    cal: ctx.calendar.getStatus(),
    mail: ctx.gmail.getStatus()
  })
}

/** Tell every screen the connection changed (after setup, verify, sign-in or a sync). */
export function pushConnection(ctx: Ctx): void {
  ctx.getWindow()?.webContents.send('google:changed', connectionFor(ctx))
}

export function googleHandlers(
  ctx: Ctx
): Pick<
  Handlers,
  | 'google:api-status'
  | 'google:api-configure'
  | 'google:health'
  | 'google:bridge-status'
  | 'google:bridge-configure'
  | 'google:bridge-script'
  | 'google:bridge-verify'
  | 'google:repair'
  | 'google:api-connect'
  | 'google:api-disconnect'
  | 'google:open-login'
  | 'google:connection'
  | 'google:refresh'
> {
  const bridgeStatus = (): {
    configured: boolean
    url: string
    hasToken: boolean
    bundledVersion: number
  } => ({
    configured: ctx.bridge.configured(),
    url: getSettings().google.bridgeUrl,
    hasToken: !!ctx.secrets.get('bridge.token'),
    bundledVersion: MIN_BRIDGE_VERSION
  })

  /** Self-test the script; with `repair`, also pull everything again so stale data heals now. */
  const verifyBridge = async (
    repair: boolean
  ): Promise<{
    ok: boolean
    email: string | null
    version: number | null
    code: string | null
    message: string | null
    sections: { name: string; ok: boolean; error: string | null }[]
  }> => {
    const r = await runSelfTest(ctx.bridge, ctx.db)
    pushConnection(ctx)
    if (r.sections.some((x) => x.ok) || (repair && !r.code)) {
      void ctx.calendar.sync()
      void ctx.gmail.sync(true)
      void bridgeExtras(ctx.bridge, ctx.db, ctx.getVault(), {
        meetNotes: getSettings().google.meetNotes,
        chat: true
      })
    }
    return {
      ok: !r.code,
      email: r.email,
      version: r.version,
      code: r.code,
      message: r.message,
      sections: r.sections
    }
  }

  return {
    'google:api-status': () => ctx.google.status(),
    'google:api-configure': ({ clientId, clientSecret }) => {
      updateSettings({ google: { clientId: clientId.trim() } })
      if (clientSecret !== undefined) {
        if (clientSecret.trim()) ctx.secrets.set('google.clientSecret', clientSecret)
        else ctx.secrets.delete('google.clientSecret')
      }
      return ctx.google.status()
    },
    'google:health': () => {
      const api = ctx.google.active()
      const source = api
        ? ('api' as const)
        : ctx.bridge.configured()
          ? ('bridge' as const)
          : ('none' as const)
      const kv = (k: string): string | null =>
        (
          ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k) as
            { value: string } | undefined
        )?.value ?? null
      type St = 'healthy' | 'syncing' | 'needs-login' | 'degraded' | 'partial' | 'off'
      const fromSync = (
        s: { state: string; error: string | null },
        ok: string
      ): { state: St; detail: string } =>
        source === 'none'
          ? { state: 'off', detail: 'Not connected yet.' }
          : s.state === 'needs-auth'
            ? {
                state: 'needs-login',
                detail: 'Sign in to Google again. Your data is kept meanwhile.'
              }
            : s.state === 'error'
              ? {
                  state: 'degraded',
                  detail: (s.error ?? 'Last sync failed') + ' Showing the last good data.'
                }
              : s.state === 'syncing'
                ? { state: 'syncing', detail: 'Syncing…' }
                : { state: 'healthy', detail: ok }
      const cal = ctx.calendar.getStatus()
      const mail = ctx.gmail.getStatus()
      const meetLast = (
        ctx.db.prepare('SELECT max(created_at) AS t FROM meet_artifacts').get() as {
          t: string | null
        }
      ).t
      const chatLast = kv('chat.lastAt')
      const meet =
        source === 'none'
          ? { state: 'off' as St, detail: 'Not connected.' }
          : {
              state: 'healthy' as St,
              detail: 'Gemini notes are added to the matching meeting note.'
            }
      const chat =
        source === 'none'
          ? { state: 'off' as St, detail: 'Not connected.' }
          : source === 'bridge'
            ? {
                state: 'partial' as St,
                detail:
                  'Partial: mentions and missed messages only. Full Chat needs Google sign-in (OAuth).'
              }
            : {
                state: 'healthy' as St,
                detail: 'All direct messages, group chats and followed spaces.'
              }
      const test = source === 'bridge' ? lastSelfTest(ctx.db) : null
      const overlay = <T extends { section: string; state: St; detail: string }>(r: T): T => {
        if (!test || r.state === 'off') return r
        if (test.code === 'needs-login')
          return {
            ...r,
            state: 'needs-login' as St,
            detail: 'Sign in to Google again. Your data is kept meanwhile.'
          }
        if (test.code === 'needs-update')
          return {
            ...r,
            state: 'degraded' as St,
            detail: (test.message ?? 'The script is out of date.') + ' Showing the last good data.'
          }
        const bad = test.sections.find((x) => x.name === r.section && !x.ok)
        if (bad)
          return {
            ...r,
            state: 'degraded' as St,
            detail: (bad.error ?? 'The script reported a problem.') + ' Showing the last good data.'
          }
        return r
      }
      const rows = [
        {
          section: 'calendar' as const,
          label: 'Calendar',
          source,
          lastAt: cal.lastSyncAt,
          ...fromSync(cal, 'Events, guests and Meet links.')
        },
        {
          section: 'mail' as const,
          label: 'Mail',
          source,
          lastAt: mail.lastSyncAt,
          ...fromSync(
            mail,
            'Subjects, senders and labels; recent text is read in memory for actions and decisions.'
          )
        },
        { section: 'meet' as const, label: 'Meeting notes', source, lastAt: meetLast, ...meet },
        { section: 'chat' as const, label: 'Chat', source, lastAt: chatLast, ...chat }
      ]
      return { rows: rows.map(overlay) }
    },
    'google:bridge-status': () => bridgeStatus(),
    'google:bridge-configure': ({ url }) => {
      const u = url.trim()
      if (u && !isBridgeUrl(u))
        throw new Error(
          'That does not look like a web app address. It ends in /exec and starts with https://script.google.com/.'
        )
      updateSettings({ google: { bridgeUrl: u } })
      pushConnection(ctx)
      return bridgeStatus()
    },
    'google:bridge-script': () => {
      let token = ctx.secrets.get('bridge.token')
      if (!token) {
        token = randomBytes(24).toString('hex')
        ctx.secrets.set('bridge.token', token)
        pushConnection(ctx)
      }
      return {
        script: bridgeScript.replace('__NOTE_MANAGER_TOKEN__', token),
        manifest: bridgeManifest
      }
    },
    'google:bridge-verify': () => verifyBridge(false),
    'google:repair': async () => {
      if (!ctx.google.active()) return verifyBridge(true)
      const st = await ctx.google.connect().catch(() => null)
      void ctx.calendar.sync()
      void ctx.gmail.sync(true)
      return {
        ok: !!st?.connected,
        email: st?.email ?? null,
        version: null,
        code: st?.connected ? null : 'needs-login',
        message: st?.connected ? null : (st?.lastError ?? 'Sign in to Google again.'),
        sections: []
      }
    },
    'google:api-connect': async () => {
      const st = await ctx.google.connect()
      updateSettings({ google: { method: 'oauth' } })
      void ctx.calendar.sync().then(() => ctx.google.extras(ctx.getVault()))
      void ctx.gmail.sync(true)
      return st
    },
    'google:api-disconnect': () => {
      const st = ctx.google.disconnect()
      updateSettings({ google: { method: 'script' } })
      return st
    },
    'google:connection': () => connectionFor(ctx),
    'google:refresh': async () => {
      const before = connectionFor(ctx)
      if (before.state === 'not-set-up' || before.state === 'missing-key')
        return { ok: false, message: before.detail, connection: before }
      const [cal, mail] = await Promise.all([ctx.calendar.sync(), ctx.gmail.sync()])
      const conn = connectionFor(ctx)
      pushConnection(ctx)
      const fail = [cal, mail].find((s) => s.state === 'error' || s.state === 'needs-auth')
      if (fail) return { ok: false, message: conn.detail, connection: conn }
      const today = localDate()
      const events = (
        ctx.db
          .prepare(
            "SELECT count(*) AS n FROM calendar_events WHERE kind = 'meeting' AND date BETWEEN ? AND date(?, '+7 day')"
          )
          .get(today, today) as { n: number }
      ).n
      return {
        ok: true,
        message: `Refreshed: ${events} meeting${events === 1 ? '' : 's'} this week, ${mail.threads} mail conversation${mail.threads === 1 ? '' : 's'}.`,
        connection: conn
      }
    },
    'google:open-login': () => {
      if (getSettings().google.method === 'oauth' && ctx.google.status().hasClient) {
        void ctx.google
          .connect()
          .then(() => {
            void ctx.calendar.sync().then(() => ctx.google.extras(ctx.getVault()))
            void ctx.gmail.sync(true)
          })
          .catch(() => undefined)
        return null
      }
      // When the sign-in window closes, pull the calendar and mail straight away.
      openLogin(() => {
        void ctx.calendar.sync()
        void ctx.gmail.sync()
      })
      return null
    }
  }
}
