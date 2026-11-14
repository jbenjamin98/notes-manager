import { BrowserWindow, session, type Session } from 'electron'
import type { RawChip } from '../calendar/parse'
import { parseGmailTime, selfEmailFromTitle, type RawRow } from '../gmail/parse'
import type { CrawlOptions, GmailScrape } from '../gmail/sync'
import { composeUrl, pageHash, threadUrl } from '../gmail/urls'
import { cleanMeetUrl, type Guest } from '../calendar/detail'

/**
 * Isolated, persistent Chromium session for Google Workspace. Cookies live in
 * userData (never in the vault). Pages loaded here get NO preload and NO node
 * access; data is extracted with executeJavaScript returning plain values.
 */
export const PARTITION = 'persist:work-google'
const CALENDAR_URL = 'https://calendar.google.com/calendar/r/agenda'

function googleSession(): Session {
  const ses = session.fromPartition(PARTITION)
  // Google/Okta may reject "Electron/x" user agents. Present as plain Chrome.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|notes-manager)\/\S+/g, ''))
  // Calendar and Gmail never need the camera, microphone, location or notifications: deny every request.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  return ses
}

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
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
}

export const isGoogleApp = (url: string): boolean => {
  try {
    const h = new URL(url).hostname
    return h === 'calendar.google.com' || h === 'mail.google.com'
  } catch {
    return false
  }
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
  void win.loadURL(CALENDAR_URL)
}

async function loadHidden(
  url: string,
  readyScript: string,
  timeoutMs = 25000
): Promise<BrowserWindow> {
  const win = newWindow(false)
  await win.loadURL(url).catch(() => undefined)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !win.isDestroyed()) {
    const ready = await win.webContents.executeJavaScript(readyScript).catch(() => false)
    if (ready) break
    await new Promise((r) => setTimeout(r, 500))
  }
  return win
}

export interface CalendarScrape {
  signedIn: boolean
  chips: RawChip[]
}

// NOTE: this script runs inside a template literal in the page. Avoid backslashes:
// newlines are split with String.fromCharCode(10) so no escape sequences are needed.
const EXTRACT_SCRIPT = `(() => {
  const NL = String.fromCharCode(10);
  const out = [];
  for (const g of document.querySelectorAll('[role=rowgroup][data-datekey]')) {
    const datekey = Number(g.getAttribute('data-datekey'));
    for (const e of g.querySelectorAll('[data-eventid]')) {
      out.push({ id: e.getAttribute('data-eventid'), datekey, lines: (e.innerText || '').split(NL) });
    }
  }
  return out;
})()`

/**
 * Loads the agenda in a hidden window and returns raw event chips. `signedIn`
 * is false when Calendar bounced us to SSO (session expired): the caller should
 * ask the user to reconnect.
 */
export async function scrapeCalendar(): Promise<CalendarScrape> {
  const ready = `location.hostname !== 'calendar.google.com' ||
    document.querySelectorAll('[role=rowgroup][data-datekey] [data-eventid]').length > 0`
  const win = await loadHidden(CALENDAR_URL, ready)
  try {
    if (win.isDestroyed()) return { signedIn: false, chips: [] }
    const signedIn = isGoogleApp(win.webContents.getURL())
    if (!signedIn) return { signedIn: false, chips: [] }
    const chips = (await win.webContents.executeJavaScript(EXTRACT_SCRIPT)) as RawChip[]
    return { signedIn: true, chips }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

// ------------------------------------------------------------------- Gmail

// NOTE: injected page scripts avoid backslashes (the template literal would eat them).
// They read textContent, not innerText: Gmail skips painting off-screen rows, and innerText of an
// unpainted row is empty while textContent is always there.
const GMAIL_EXTRACT = `(() => {
  const clean = (s) => (s || '').split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(9)).join(' ').replace(/  +/g, ' ').trim();
  const tc = (el) => (el ? clean(el.textContent) : '');
  const rows = [...document.querySelectorAll('tr[role="row"]')].filter(
    (r) => r.offsetParent !== null && r.querySelector('td') &&
           (r.querySelector('[data-thread-id]') || r.querySelector('[data-legacy-thread-id]'))
  );
  return {
    title: document.title,
    rows: rows.map((r) => {
      const t = r.querySelector('[data-thread-id]');
      const l = r.querySelector('[data-legacy-thread-id]');
      const chips = [];
      for (const c of r.querySelectorAll('.ar .at')) chips.push(c.getAttribute('title') || tc(c));
      const time = r.querySelector('.xW span[title]');
      return {
        legacyId: l ? l.getAttribute('data-legacy-thread-id') : null,
        threadId: t ? t.getAttribute('data-thread-id') : null,
        senders: [...r.querySelectorAll('span[email]')].map((s) => ({
          name: s.getAttribute('name') || tc(s),
          email: s.getAttribute('email') || ''
        })),
        subject: tc(r.querySelector('.bog')) || tc(r.querySelector('.bqe')),
        snippet: tc(r.querySelector('.y2')),
        timeTitle: time ? time.getAttribute('title') || '' : '',
        unread: r.classList.contains('zE'),
        starred: !!r.querySelector('[aria-label="Starred"]'),
        labels: chips
      };
    })
  };
})()`

/** Page is showing a NEW list (first row differs from `prev`) whose subjects have painted, or an empty result. */
const listReadyScript = (prev: string | null): string => `(() => {
  if (location.hostname !== 'mail.google.com') return true;
  const rows = [...document.querySelectorAll('tr[role="row"]')].filter(
    (r) => r.offsetParent !== null && r.querySelector('[data-thread-id]')
  );
  if (rows.length === 0) return /No messages matched|did not match any/i.test(document.body ? document.body.textContent || '' : '');
  const first = rows[0].querySelector('[data-legacy-thread-id]') || rows[0].querySelector('[data-thread-id]');
  const id = first.getAttribute(first.hasAttribute('data-legacy-thread-id') ? 'data-legacy-thread-id' : 'data-thread-id');
  const painted = rows.filter((r) => ((r.querySelector('.bog') || r.querySelector('.bqe') || {}).textContent || '').trim()).length;
  return id !== ${JSON.stringify(prev)} && painted >= rows.length * 0.8;
})()`

/**
 * ALL MAIL minus bulk categories, filtered at the source. (Adding `-in:chats` makes Gmail return
 * nothing, so don't.) Spam and Trash are excluded by default; drafts are removed explicitly.
 */
export const MAIL_QUERY = '-category:promotions -category:social -category:forums -in:drafts'

async function waitFor(win: BrowserWindow, script: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !win.isDestroyed()) {
    if (await win.webContents.executeJavaScript(script).catch(() => false)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

const idOfRow = (r: RawRow): string | null => r.legacyId || r.threadId

const localIso = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * One hidden window, no reloads between pages: load All Mail once, then step through pages by
 * changing the URL hash (/p2, /p3, ...) until a row is older than the cutoff. A final hash change
 * reads the (short) starred list, which may reach back beyond the window.
 */
export async function scrapeGmail(opts: CrawlOptions): Promise<GmailScrape> {
  const empty: GmailScrape = {
    signedIn: false,
    selfEmail: null,
    rows: [],
    starred: [],
    pages: 0,
    reachedCutoff: false
  }
  const win = newWindow(false)
  try {
    await win
      .loadURL(`https://mail.google.com/mail/u/0/${pageHash(MAIL_QUERY, 1)}`)
      .catch(() => undefined)
    if (!(await waitFor(win, listReadyScript(null), 30000)) || win.isDestroyed()) return empty
    if (!isGoogleApp(win.webContents.getURL())) return empty // bounced to SSO

    type Extracted = { title: string; rows: RawRow[] }
    const extract = (): Promise<Extracted> =>
      win.webContents.executeJavaScript(GMAIL_EXTRACT) as Promise<Extracted>

    const cutoff = localIso(new Date(Date.now() - opts.days * 86_400_000))
    const seen = new Map<string, RawRow>()
    let selfEmail: string | null = null
    let pages = 0
    let reached = false
    let prev: string | null = null

    for (let p = 1; p <= opts.maxPages && !win.isDestroyed(); p++) {
      if (p > 1) {
        await win.webContents.executeJavaScript(
          `location.hash = ${JSON.stringify(pageHash(MAIL_QUERY, p))}`
        )
        if (!(await waitFor(win, listReadyScript(prev), 15000))) break // stuck: report as partial
      }
      const res = await extract()
      if (res.rows.length === 0) {
        reached = true // past the end of the mailbox
        break
      }
      pages++
      selfEmail = selfEmail ?? selfEmailFromTitle(res.title)
      for (const r of res.rows) {
        const id = idOfRow(r)
        if (id && !seen.has(id)) seen.set(id, r)
      }
      prev = idOfRow(res.rows[0])
      const oldest = res.rows
        .map((r) => parseGmailTime(r.timeTitle))
        .filter((t): t is string => !!t)
        .sort()[0]
      if ((oldest && oldest < cutoff) || res.rows.length < 20) {
        reached = true
        break
      }
    }

    // Starred conversations (complete list; may be older than the window).
    let starred: RawRow[] = []
    if (!win.isDestroyed()) {
      await win.webContents.executeJavaScript(
        `location.hash = ${JSON.stringify('#search/is%3Astarred')}`
      )
      if (await waitFor(win, listReadyScript(prev), 12000)) starred = (await extract()).rows
    }
    return {
      signedIn: true,
      selfEmail,
      rows: [...seen.values()],
      starred,
      pages,
      reachedCutoff: reached
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
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

// ----------------------------------------------------------- event detail (guests, Meet link)

// Avoids backslashes (template literal). Guests carry their address in data-hovercard-id / data-email.
const EVENT_DETAIL_SCRIPT = `(() => {
  const guests = new Map();
  for (const e of document.querySelectorAll('[data-hovercard-id]')) {
    const v = (e.getAttribute('data-hovercard-id') || '').toLowerCase();
    if (v.indexOf('@') > 0) {
      const t = (e.textContent || '').trim();
      const name = t && t.indexOf('@') < 0 && t.length < 80 ? t : null;
      guests.set(v, name || guests.get(v) || null);
    }
  }
  for (const e of document.querySelectorAll('[data-email]')) {
    const v = (e.getAttribute('data-email') || '').toLowerCase();
    if (v.indexOf('@') > 0 && !guests.has(v)) guests.set(v, null);
  }
  const meet = [...document.querySelectorAll('a[href*="meet.google.com/"]')].map((a) => a.href);
  return { guests: [...guests.entries()].map(([email, name]) => ({ email, name })), meet };
})()`

export interface RawEventDetail {
  signedIn: boolean
  guests: Guest[]
  meetUrl: string | null
}

/**
 * Loads one event's edit page in the hidden Google window and reads its guest list and Meet link.
 * Read-only: nothing on the page is clicked or changed. Called on demand (opening a prep sheet),
 * and the result is cached, so the cost is one page load per meeting.
 */
export async function scrapeEventDetail(eventId: string): Promise<RawEventDetail> {
  const win = newWindow(false)
  try {
    await win
      .loadURL(
        `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(eventId)}`
      )
      .catch(() => undefined)
    if (win.isDestroyed() || !isGoogleApp(win.webContents.getURL())) {
      return { signedIn: false, guests: [], meetUrl: null }
    }
    // The form has painted once its "Add guests" field exists; guest chips follow shortly after.
    await waitFor(
      win,
      `!!document.querySelector('input[aria-label*="guest" i]') || !!document.querySelector('[data-hovercard-id]')`,
      15000
    )
    await new Promise((r) => setTimeout(r, 1500))
    if (win.isDestroyed()) return { signedIn: false, guests: [], meetUrl: null }
    const res = (await win.webContents.executeJavaScript(EVENT_DETAIL_SCRIPT)) as {
      guests: Guest[]
      meet: string[]
    }
    const meetUrl = res.meet.map(cleanMeetUrl).find((u): u is string => !!u) ?? null
    return { signedIn: true, guests: res.guests, meetUrl }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
