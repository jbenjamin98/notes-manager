/**
 * One answer to "is Google connected, and if not, what do I do?", shared by the sidebar, Settings,
 * Home and the first-run guide so they can never disagree.
 */
export type ConnState =
  | 'ok'
  | 'syncing'
  | 'not-set-up'
  | 'missing-key'
  | 'needs-login'
  | 'needs-update'
  | 'busy'
  | 'error'

/** What the main button does: open setup, sign in, re-copy the script, or refresh. */
export type ConnAction = 'setup' | 'sign-in' | 'copy-script' | 'refresh' | null

export interface Connection {
  source: 'api' | 'bridge' | 'none'
  state: ConnState
  /** Short status for the sidebar ("Synced 5 min ago", "Google not set up"). */
  label: string
  /** One sentence: what is wrong and how to fix it. */
  detail: string
  action: ConnAction
  actionLabel: string | null
  email: string | null
  lastSyncAt: string | null
}

export interface ConnInputs {
  apiActive: boolean
  /** The Google sign-in was revoked or expired and the user has not signed in again yet. */
  apiRevoked?: boolean
  apiEmail: string | null
  bridgeUrl: string
  hasToken: boolean
  selfTest: { code: string | null; message: string | null; email: string | null } | null
  cal: { state: string; error: string | null; lastSyncAt: string | null }
  mail: { state: string; error: string | null; lastSyncAt: string | null }
}

const QUOTA = /quota|rate.?limit|slow(ing)? down|try again in a minute|busy/i

export function connectionState(i: ConnInputs): Connection {
  const lastSyncAt = [i.cal.lastSyncAt, i.mail.lastSyncAt].filter(Boolean).sort().pop() ?? null
  const revoked = !!i.apiRevoked && !i.apiActive
  const source = i.apiActive || revoked ? 'api' : i.bridgeUrl.trim() ? 'bridge' : 'none'
  const email = i.apiActive ? i.apiEmail : (i.selfTest?.email ?? null)
  const base = { source, email, lastSyncAt } as const
  const r = (
    state: ConnState,
    label: string,
    detail: string,
    action: ConnAction = null,
    actionLabel: string | null = null
  ): Connection => ({ ...base, state, label, detail, action, actionLabel })

  if (source === 'none')
    return r(
      'not-set-up',
      'Google not set up',
      'Connect Google to see your meetings, mail follow-ups and meeting notes.',
      'setup',
      'Set Up Google'
    )

  if (source === 'bridge') {
    if (!i.hasToken)
      return r(
        'missing-key',
        'Script key missing',
        'The script address is saved, but this computer no longer has its key. Copy the script again, paste it over the old one and deploy a new version.',
        'copy-script',
        'Copy Script Again'
      )
    const code = i.selfTest?.code ?? null
    if (code === 'bad-token')
      return r(
        'missing-key',
        'Script key does not match',
        'The deployed script has a different key from this computer. Copy the script again and deploy a new version.',
        'copy-script',
        'Copy Script Again'
      )
    if (code === 'needs-update')
      return r(
        'needs-update',
        'Script out of date',
        (i.selfTest?.message ?? 'The script is older than this app.') +
          ' Copy it again and deploy a new version.',
        'copy-script',
        'Copy Script Again'
      )
  }

  if (revoked)
    return r(
      'needs-login',
      'Sign in to Google',
      'Your Google sign-in has expired. Sign in again; your data is kept meanwhile.',
      'sign-in',
      'Sign In to Google'
    )

  const states = [i.cal.state, i.mail.state]
  if (states.includes('syncing')) return r('syncing', 'Syncing…', 'Reading your calendar and mail.')

  const needsLogin =
    states.includes('needs-auth') || (source === 'bridge' && i.selfTest?.code === 'needs-login')
  if (needsLogin)
    return r(
      'needs-login',
      'Sign in to Google',
      source === 'api'
        ? 'Your Google sign-in has expired. Sign in again; your data is kept meanwhile.'
        : 'The script could not reach your Google account from this app. Sign in to Google in the window that opens, then refresh.',
      'sign-in',
      'Sign In to Google'
    )

  const err = i.cal.state === 'error' ? i.cal.error : i.mail.state === 'error' ? i.mail.error : null
  if (err && QUOTA.test(err))
    return r(
      'busy',
      'Google is busy',
      'Google asked us to slow down. Retrying automatically in a minute or two.',
      'refresh',
      'Refresh Now'
    )
  if (err)
    return r('error', 'Sync failed', err + ' Showing the last good data.', 'refresh', 'Try Again')

  return r(
    'ok',
    lastSyncAt ? 'Synced' : 'Connected',
    source === 'api'
      ? `Signed in${email ? ` as ${email}` : ''} with Google.`
      : `Connected through your private script${email ? ` (${email})` : ''}.`,
    'refresh',
    'Refresh Now'
  )
}
