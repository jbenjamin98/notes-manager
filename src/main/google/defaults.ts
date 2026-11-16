/**
 * Google sign-in uses ONE OAuth client for the whole company: an Internal Desktop client that IT
 * creates once (see docs/IT-GOOGLE-SIGN-IN.md). Its ID is built into the installer from
 * build/google-client.json, so colleagues only press "Sign in with Google". Nobody creates a
 * project or pastes a key. A desktop client ID (and its "secret") are public by design (PKCE).
 *
 * NM_GOOGLE_CLIENT_ID / NM_GOOGLE_CLIENT_SECRET override it in development and tests only.
 */
const devOverride = (k: string): string =>
  !import.meta.env.PROD ? (process.env[k] ?? '').trim() : ''

export const defaultClientId = (): string =>
  devOverride('NM_GOOGLE_CLIENT_ID') || (import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? '').trim()

export const defaultClientSecret = (): string =>
  devOverride('NM_GOOGLE_CLIENT_SECRET') ||
  (import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? '').trim()

/**
 * The client to sign in with. The company's built-in client always; a value pasted in an older
 * version's Settings is only used when this build has none (so nobody is left signed out).
 */
export const effectiveClientId = (legacyUserValue: string): string =>
  defaultClientId() || legacyUserValue.trim()
