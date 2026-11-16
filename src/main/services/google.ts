import { BrowserWindow, session, type Session } from 'electron'
import { composeUrl, threadUrl } from '../gmail/urls'

/**
 * The signed-in Google session (Okta, security key, daily re-login) lives in an isolated, persistent
 * partition: cookies stay in userData, never in the vault. It is used for two things only:
 *  1. authenticating requests to your own Apps Script bridge (a plain HTTPS fetch, nothing rendered), and
 *  2. visible windows YOU act in: signing in, reading an email thread, composing a draft.
 * Nothing here reads a page's screen.
 */
export const PARTITION = 'persist:work-google'
const SIGN_IN_URL = 'https://script.google.com/home'

export function googleSession(): Session {
  const ses = session.fromPartition(PARTITION)
  // Google/Okta may reject "Electron/x" user agents. Present as plain Chrome.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|notes-manager|Note Manager)\/\S+/g, ''))
  // Nothing here needs the camera, microphone, location or notifications: deny every request.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  return ses
}

/** A request made with the signed-in session's cookies. */
export const googleFetch = (url: string, init?: RequestInit): Promise<Response> =>
  googleSession().fetch(url, init)

function newWindow(show: boolean): BrowserWindow {
  return new BrowserWindow({
    width: 1100,
    height: 800,
    show,
    title: 'Sign in to Google',
    autoHideMenuBar: true,
    webPreferences: {
      session: googleSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
}

let loginWin: BrowserWindow | null = null

/** Visible window so the user can complete Okta + 2FA / YubiKey. `onClosed` lets the caller re-sync. */
export function openLogin(onClosed?: () => void): void {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus()
    return
  }
  const win = newWindow(true)
  loginWin = win
  // Okta/SSO flows sometimes use popups; allow https only.
  win.webContents.setWindowOpenHandler(({ url }) =>
    /^https:\/\//i.test(url) ? { action: 'allow' } : { action: 'deny' }
  )
  win.on('closed', () => {
    loginWin = null
    onClosed?.()
  })
  void win.loadURL(SIGN_IN_URL)
}

function openVisible(url: string): void {
  const win = newWindow(true)
  win.setTitle('Gmail')
  win.webContents.setWindowOpenHandler(({ url: u }) =>
    /^https:\/\//i.test(u) ? { action: 'allow' } : { action: 'deny' }
  )
  void win.loadURL(url)
}

/** Open a thread in a visible Gmail window (to read it or reply). */
export function openThread(linkId: string | null, subject: string): void {
  openVisible(threadUrl(linkId, subject))
}

/**
 * Visible, pre-filled compose window. Nothing is sent: closing it keeps a Gmail draft, and the
 * user reviews and sends (or discards) it themselves.
 */
export function openCompose(p: { to?: string; subject: string; body: string }): void {
  openVisible(composeUrl(p))
}
