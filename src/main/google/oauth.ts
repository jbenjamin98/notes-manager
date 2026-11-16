import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/**
 * OAuth 2.0 for a desktop app (PKCE + loopback redirect), the way Google documents it. The user
 * brings their own OAuth client (created in Google Cloud Console). Only the refresh token is kept,
 * encrypted; access tokens live in memory. Nothing here knows about calendars or mail.
 */
export interface OAuthDeps {
  clientId: () => string
  clientSecret: () => string | null
  /** Persisted, encrypted. */
  loadRefreshToken: () => string | null
  saveRefreshToken: (t: string | null) => void
  /** Opens the consent page in the user's own browser. */
  openExternal: (url: string) => void
  fetchImpl?: typeof fetch
  authUrl?: string
  tokenUrl?: string
  now?: () => number
}

export const SCOPES = {
  base: [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.readonly'
  ],
  meet: [
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/documents.readonly'
  ],
  chat: [
    'https://www.googleapis.com/auth/chat.spaces.readonly',
    'https://www.googleapis.com/auth/chat.messages.readonly'
  ]
}

export class OAuthError extends Error {
  constructor(
    public code: 'no-client' | 'denied' | 'timeout' | 'token' | 'not-connected',
    message: string
  ) {
    super(message)
  }
}

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export class GoogleOAuth {
  private access: { token: string; expiresAt: number } | null = null
  private scopesGranted: string[] = []

  constructor(private deps: OAuthDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  connected(): boolean {
    return !!this.deps.loadRefreshToken()
  }

  grantedScopes(): string[] {
    return this.scopesGranted
  }

  disconnect(): void {
    this.deps.saveRefreshToken(null)
    this.access = null
    this.scopesGranted = []
  }

  /**
   * Runs the consent flow: a one-shot local listener receives the code, the system browser shows
   * Google's page. Resolves once the refresh token is stored. Rejects on denial or after 5 minutes.
   */
  async connect(scopes: string[], timeoutMs = 5 * 60_000): Promise<void> {
    const clientId = this.deps.clientId()
    if (!clientId) throw new OAuthError('no-client', 'Add your Google OAuth client ID first.')
    const verifier = b64url(randomBytes(48))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(16))

    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (u.pathname !== '/') {
          res.statusCode = 404
          res.end()
          return
        }
        const err = u.searchParams.get('error')
        const got = u.searchParams.get('code')
        const ok = got && u.searchParams.get('state') === state
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(
          `<!doctype html><title>Note Manager</title><body style="font-family:system-ui;padding:40px;text-align:center">` +
            (ok
              ? '<h2>Connected.</h2><p>You can close this tab and go back to Note Manager.</p>'
              : '<h2>Not connected.</h2><p>Go back to Note Manager and try again.</p>') +
            '</body>'
        )
        clearTimeout(timer)
        server.close()
        if (ok) resolve(got)
        else
          reject(
            new OAuthError(
              'denied',
              err === 'access_denied'
                ? 'Google access was declined.'
                : 'Google did not return a code.'
            )
          )
      })
      const timer = setTimeout(() => {
        server.close()
        reject(new OAuthError('timeout', 'The sign-in took too long. Try again.'))
      }, timeoutMs)
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port
        const q = new URLSearchParams({
          client_id: clientId,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: 'code',
          scope: scopes.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
          state
        })
        this.redirectPort = port
        this.deps.openExternal(
          `${this.deps.authUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth'}?${q}`
        )
      })
    })

    const tok = await this.tokenRequest({
      code,
      client_id: clientId,
      ...(this.deps.clientSecret() ? { client_secret: this.deps.clientSecret()! } : {}),
      redirect_uri: `http://127.0.0.1:${this.redirectPort}`,
      grant_type: 'authorization_code',
      code_verifier: verifier
    })
    if (!tok.refresh_token)
      throw new OAuthError(
        'token',
        'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.'
      )
    this.deps.saveRefreshToken(tok.refresh_token)
    this.scopesGranted = (tok.scope ?? scopes.join(' ')).split(' ')
    this.access = {
      token: tok.access_token,
      expiresAt: this.now() + (tok.expires_in ?? 3600) * 1000 - 60_000
    }
  }
  private redirectPort = 0

  /** A valid access token, refreshing when needed. Null when not connected. */
  async accessToken(force = false): Promise<string | null> {
    if (!force && this.access && this.access.expiresAt > this.now()) return this.access.token
    const refresh = this.deps.loadRefreshToken()
    if (!refresh) return null
    const tok = await this.tokenRequest({
      refresh_token: refresh,
      client_id: this.deps.clientId(),
      ...(this.deps.clientSecret() ? { client_secret: this.deps.clientSecret()! } : {}),
      grant_type: 'refresh_token'
    })
    if (tok.scope) this.scopesGranted = tok.scope.split(' ')
    this.access = {
      token: tok.access_token,
      expiresAt: this.now() + (tok.expires_in ?? 3600) * 1000 - 60_000
    }
    return tok.access_token
  }

  private async tokenRequest(form: Record<string, string>): Promise<{
    access_token: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  }> {
    const f = this.deps.fetchImpl ?? fetch
    const res = await f(this.deps.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString()
    })
    const j = (await res.json().catch(() => ({}))) as {
      error?: string
      error_description?: string
      access_token?: string
    }
    if (!res.ok || !j.access_token) {
      if (j.error === 'invalid_grant') {
        // The refresh token was revoked or expired: forget it so the UI asks to reconnect.
        this.deps.saveRefreshToken(null)
        this.access = null
        throw new OAuthError(
          'not-connected',
          'Google access has expired. Connect again in Settings.'
        )
      }
      throw new OAuthError(
        'token',
        `Google sign-in failed: ${j.error_description ?? j.error ?? `HTTP ${res.status}`}`
      )
    }
    return j as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }
  }
}
