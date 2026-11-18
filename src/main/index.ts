import {
  app,
  shell,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  safeStorage,
  Tray
} from 'electron'
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import trayDark16 from '../../resources/tray-dark16.png?asset'
import trayDark32 from '../../resources/tray-dark32.png?asset'
import trayLight16 from '../../resources/tray-light16.png?asset'
import trayLight32 from '../../resources/tray-light32.png?asset'
import { openDb, type Db } from './db'
import { registerIpc } from './ipc'
import { Vault } from './vault/vault'
import { getSettings, updateSettings } from './services/settings'
import { CalendarSync } from './calendar/sync'
import { openCompose, googleFetch } from './services/google'
import { BridgeClient } from './google/bridge'
import { GoogleHub } from './google/hub'
import { scheduleSelfTest } from './google/health'
import { insightsFromChat, insightsFromMeeting, type PipelineDeps } from './insights/pipeline'
import { insightsFromMail } from './insights/mail'
import type { MeetingRead } from './google/meet'
import { GmailSync, guessEmail } from './gmail/sync'
import { smartOverview } from './gmail/extra'
import { NudgeEngine, type Nudge } from './nudges/engine'
import { LlmRouter } from './llm/router'
import { routerConfig } from './llm/config'
import { createSecretStore } from './services/secrets'
import { AutoTagger } from './assistant/autotag'
import { PROVIDERS } from './llm/providers'
import { Assistant } from './assistant/assistant'
import { personaFor } from '../shared/personas'
import { parseHm } from './nudges/rules'
import { makeSources } from './assistant/sources'
import { GoogleConnector } from './google/connector'
import { CaptureWindow } from './capture'
import { initLogger } from './services/logger'

let mainWindow: BrowserWindow | null = null
let db: Db | null = null
let vault: Vault | null = null
let calendar: CalendarSync | null = null
let gmail: GmailSync | null = null
let engine: NudgeEngine | null = null
let tray: Tray | null = null
/** True once the user really chose to quit (tray menu, Ctrl+Q, installer): closing the window otherwise hides it. */
let quitting = false
/** Launched by "start when I sign in": stay in the tray instead of opening a window. */
const startHidden = process.argv.includes('--hidden')
/** Keep toast objects alive until clicked/closed (Electron drops handlers if they are collected). */
const liveToasts = new Set<Notification>()

/** (Re)start the vault. Switching folders drops the derived index and rebuilds it from files. */
async function startVault(root: string): Promise<void> {
  if (!db) return
  await vault?.close()
  if (vault && vault.root !== root) {
    db.exec('DELETE FROM notes; DELETE FROM file_state;')
  }
  vault = new Vault(
    db,
    root,
    () => getSettings().meAliases,
    (paths) => mainWindow?.webContents.send('vault:changed', { paths }),
    () => getSettings().autoTag.hidden ?? []
  )
  await vault.init()
  mainWindow?.webContents.send('vault:changed', { paths: [] })
}

let capture: CaptureWindow | null = null
const vaultRoot = (): string => process.env['NM_VAULT'] || getSettings().vaultPath

function showMainWindow(): void {
  if (!mainWindow) createWindow(true)
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function createWindow(show = !startHidden): void {
  mainWindow = new BrowserWindow({
    title: 'Note Manager',
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0c13' : '#eef1fb',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (show) mainWindow?.show()
  })
  // Closing the window keeps the app (and its nudges) alive in the tray, if the user wants that.
  mainWindow.on('close', (e) => {
    if (!quitting && getSettings().runInBackground) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // Without a tray, closing the window quits: the hidden capture window must not keep us alive.
    if (!getSettings().runInBackground) capture?.dispose()
  })

  // Only http(s) links leave the app, and only in the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!(dev && url.startsWith(dev)) && !url.startsWith('file://')) e.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Tray icon and start-at-login follow the settings. Per-user only: no admin rights needed. */
/** A glyph for the tray that suits the taskbar: light for a dark bar, dark for a light bar. */
function trayImage(): Electron.NativeImage {
  const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
  const img = nativeImage.createFromPath(dark ? trayDark16 : trayLight16)
  img.addRepresentation({
    scaleFactor: 2,
    width: 32,
    height: 32,
    buffer: readFileSync(dark ? trayDark32 : trayLight32)
  })
  return img
}

export function applyAppSettings(): void {
  const s = getSettings()
  capture?.apply()
  if (s.runInBackground && !tray) {
    tray = new Tray(trayImage())
    // The taskbar can be dark or light (and can change): swap to the picture that shows on it.
    nativeTheme.on('updated', () => tray?.setImage(trayImage()))
    tray.setToolTip('Note Manager')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Note Manager', click: showMainWindow },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            quitting = true
            app.quit()
          }
        }
      ])
    )
    tray.on('click', showMainWindow)
  } else if (!s.runInBackground && tray) {
    tray.destroy()
    tray = null
  }
  // Registering the dev (unpackaged) electron.exe as a login item would be wrong.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: s.startAtLogin, args: ['--hidden'] })
  }
}

/** What Windows told us about the last notification we tried to show (for the Settings test). */
const toastState = { shown: false, error: null as string | null }

let assistantRef: Assistant | null = null

/** The assistant speaking up: a Windows notification titled with its name; click opens the Co-Pilot. */
function deliverAssistant(
  items: { message: { content: string; kind: string }; urgent: boolean }[]
): void {
  if (!Notification.isSupported() || !engine) return
  const name = personaFor(getSettings().assistant.persona).name
  const allowed = engine.shouldToast()
  for (const { message, urgent } of items.slice(0, 2)) {
    if (!urgent && !allowed) continue
    const t = new Notification({ title: name, body: message.content.slice(0, 220), silent: false })
    liveToasts.add(t)
    t.on('show', () => {
      toastState.shown = true
    })
    t.on('failed', (_e, error) => {
      toastState.error = String(error)
      console.warn('[notify] assistant failed', error)
    })
    t.on('click', () => {
      showMainWindow()
      mainWindow?.webContents.send('assistant:focus', null)
    })
    t.on('close', () => liveToasts.delete(t))
    t.show()
  }
}

function deliverToasts(list: Nudge[], opts: { force?: boolean } = {}): void {
  if (!engine) return
  if (!Notification.isSupported()) {
    toastState.error = 'Windows notifications are not available to this app.'
    return
  }
  // Time-critical nudges always notify; the rest follow work hours / the after-hours setting.
  const allowed = opts.force || engine.shouldToast()
  const picked = list.filter((n) => opts.force || allowed || NudgeEngine.ALWAYS.includes(n.rule))
  if (picked.length === 0) return
  const show = (title: string, body: string, id: string | null): void => {
    const t = new Notification({ title, body, silent: false })
    liveToasts.add(t)
    t.on('show', () => {
      toastState.shown = true
    })
    t.on('failed', (_e, error) => {
      toastState.error = String(error)
      console.warn('[notify] failed', error)
    })
    t.on('click', () => {
      showMainWindow()
      mainWindow?.webContents.send('nudges:focus', { id })
    })
    t.on('close', () => liveToasts.delete(t))
    t.show()
  }
  for (const n of picked.slice(0, 3)) show(n.title, n.body.split('\n').slice(0, 3).join('\n'), n.id)
  if (picked.length > 3)
    show(`${picked.length - 3} more nudges`, 'Open Note Manager to see them.', null)
}

// Keep one data folder (settings, API keys, Google session, index) whatever the app is named, so
// upgrades never lose anything. Tests pass --user-data-dir and are left alone.
if (!app.commandLine.hasSwitch('user-data-dir'))
  app.setPath('userData', join(app.getPath('appData'), 'notes-manager'))

// One instance only: two instances would fight over the SQLite file and the vault.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.notesmanager.app')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    mkdirSync(app.getPath('userData'), { recursive: true })
    initLogger(join(app.getPath('userData'), 'logs'))
    const dbPath = join(app.getPath('userData'), 'index.db')
    db = openDb(dbPath)
    const send = (ch: string, payload: unknown): void => mainWindow?.webContents.send(ch, payload)

    engine = new NudgeEngine(db, {
      getSettings: () => getSettings(),
      getTasks: () => vault?.listTasks() ?? [],
      getMail: () => (db ? smartOverview(db, vault, getSettings()) : null),
      onNew: deliverToasts,
      onChanged: () => send('nudges:changed', { unread: engine?.unread() ?? 0 })
    })

    const secrets = createSecretStore(join(app.getPath('userData'), 'secrets.json'), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (p) => safeStorage.encryptString(p),
      decrypt: (b) => safeStorage.decryptString(b)
    })
    // Set once the insight pipeline exists (it needs the AI router, which is created later).
    const hooks: { meeting?: (m: MeetingRead) => Promise<unknown> } = {}
    const google = new GoogleConnector({
      db,
      secrets,
      getSettings: () => getSettings().google,
      onMeeting: (m) => hooks.meeting?.(m) ?? Promise.resolve(),
      tz: () => getSettings().timezone,
      openExternal: (u) => void shell.openExternal(u),
      ...(process.env['NM_GOOGLE_API_BASE']
        ? {
            bases: Object.fromEntries(
              ['calendar', 'gmail', 'drive', 'docs', 'chat', 'userinfo'].map((k) => [
                k,
                `${process.env['NM_GOOGLE_API_BASE']}/${k}`
              ])
            ),
            tokenUrl: `${process.env['NM_GOOGLE_API_BASE']}/token`,
            authUrl: `${process.env['NM_GOOGLE_API_BASE']}/auth`
          }
        : {})
    })
    // Tests point the script at a local fake (NM_BRIDGE_BASE); real installs always talk to Google.
    const bridgeBase = !app.isPackaged ? process.env['NM_BRIDGE_BASE'] : undefined
    const bridge = new BridgeClient({
      url: () => getSettings().google.bridgeUrl,
      token: () => secrets.get('bridge.token'),
      fetchImpl: bridgeBase
        ? (u, init) => fetch(u.replace('https://script.google.com', bridgeBase), init)
        : googleFetch,
      tz: () => getSettings().timezone
    })
    const hub = new GoogleHub(google, bridge, {
      db,
      settings: () => getSettings().google,
      onMeeting: (m) => onMeeting(m)
    })
    scheduleSelfTest(bridge, db, () => !google.active())
    // What matters from chat, meetings and mail: read what changed, keep the insights.
    let llmRef: LlmRouter | null = null
    let insightsRun: Promise<number> | null = null
    const insightDeps = (d: NonNullable<typeof db>): PipelineDeps => ({
      db: d,
      llm: getSettings().llm.enabled ? llmRef : null,
      me: () => getSettings().meAliases,
      headroom: () => llmRef?.hasHeadroom() ?? true
    })
    const onMeeting = async (m: MeetingRead): Promise<void> => {
      if (db) await insightsFromMeeting(insightDeps(db), m).catch(() => 0)
    }
    hooks.meeting = onMeeting
    const runInsights = (): Promise<number> => {
      if (insightsRun) return insightsRun
      const d = db
      if (!d) return Promise.resolve(0)
      insightsRun = (async () => {
        // At most 10 model reads per run; the rest wait for the next one (and for budget headroom).
        const deps = { ...insightDeps(d), modelRuns: { left: 10 }, stats: { deferred: 0 } }
        let n = await insightsFromChat(deps)
        if (getSettings().google.readMailBodies && hub.mailAvailable()) {
          const self = (
            d.prepare("SELECT value FROM kv WHERE key = 'gmail.selfEmail'").get() as
              { value: string } | undefined
          )?.value
          n += await insightsFromMail(deps, (ids) => hub.mailBodies(ids), self ?? null)
        }
        return n
      })()
        .catch((e) => {
          console.error('[insights]', e)
          return 0
        })
        .finally(() => {
          insightsRun = null
        })
      return insightsRun
    }
    calendar = new CalendarSync(
      db,
      () => hub.calendar(),
      (st) => send('calendar:changed', st),
      () => {
        send('calendar:changed', calendar?.getStatus())
        engine?.tick() // fresh events can make a prep/capture nudge due right now
        void assistantRef?.proactiveTick()
        void hub.extras(vault).then(() => {
          mainWindow?.webContents.send('vault:changed', { paths: [] })
          return runInsights()
        })
      },
      // First sync learns who "me" is, unless the user already set their names in Settings.
      (name) => {
        const cur = getSettings().meAliases
        if (cur.length === 1 && cur[0].toLowerCase() === 'me') {
          const first = name.split(/\s+/)[0]
          updateSettings({ meAliases: [...new Set(['Me', name, first])] })
          void vault?.reindexAll()
        }
      }
    )
    gmail = new GmailSync(
      db,
      (o) => hub.mail(o),
      (st) => send('gmail:changed', st),
      () => getSettings().gmailEnabled,
      () => getSettings().gmailDays
    )
    capture = new CaptureWindow({
      icon,
      getSettings: () => getSettings().quickCapture,
      keepOnBlur: !app.isPackaged && !!process.env['NM_SHOW_CAPTURE']
    })
    const llm = new LlmRouter({
      db,
      dailyBudget: () => getSettings().llm.dailyTokenBudget,
      getKey: (p) => secrets.get('llm.' + p),
      getConfig: () => routerConfig(getSettings().llm),
      onChange: () => mainWindow?.webContents.send('llm:changed', null)
    })
    llmRef = llm
    const tagger = new AutoTagger({
      db,
      llm,
      vault: () => {
        if (!vault) throw new Error('Vault not ready')
        return vault
      },
      settings: () => getSettings(),
      // Keep five calls a minute free for the Co-Pilot.
      headroom: () => {
        const p = llm.status().providers.find((x) => x.hasKey && x.enabled && x.state === 'ready')
        return !!p && p.usage.lastMinute < Math.max(2, PROVIDERS[p.id].rpm - 5)
      }
    })
    const assistant = new Assistant({
      tagText: (t) => tagger.tagOnSubmit(t),
      db,
      llm,
      vault: () => {
        if (!vault) throw new Error('Vault not ready')
        return vault
      },
      addReminder: (text, at) => engine!.addReminder(text, at),
      getSettings: () => getSettings(),
      zone: () => getSettings().timezone,
      sources: makeSources({
        db,
        vault: () => {
          if (!vault) throw new Error('Vault not ready')
          return vault
        },
        zone: () => getSettings().timezone
      }),
      guessEmail: (n) => guessEmail(db!, n),
      compose: (d) => openCompose(d),
      mailBodies: (ids) => hub.mailBodies(ids),
      readMail: () => getSettings().google.readMailBodies && hub.mailAvailable(),
      onProgress: (label) => send('assistant:progress', { label }),
      proactive: {
        enabled: () => getSettings().assistant.proactive,
        persona: () => getSettings().assistant.persona,
        tasks: () => vault?.listTasks() ?? [],
        awaiting: () =>
          (db ? smartOverview(db, vault, getSettings()).awaitingMe : []).map((t) => ({
            id: t.id,
            subject: t.subject,
            sender: t.senderName ?? t.senderEmail ?? '',
            lastMessageAt: t.lastMessageAt
          })),
        hours: () => {
          const s = getSettings()
          return {
            start: parseHm(s.workHours.start, 480),
            end: parseHm(s.workHours.end, 1080),
            eod: parseHm(s.nudges.eodTime, 1005)
          }
        },
        onNew: (items) => {
          send('assistant:changed', { unread: assistant.unread() })
          deliverAssistant(items)
        }
      }
    })
    // The assistant checks for something worth saying once a minute (and after every calendar sync).
    setInterval(() => void assistant.proactiveTick(), 60_000)
    setTimeout(() => void assistant.proactiveTick(), 20_000)
    assistantRef = assistant
    registerIpc({
      tagger,
      db,
      calendar,
      gmail,
      engine,
      assistant,
      llm,
      secrets,
      bridge,
      hub,
      runInsights,
      capture: capture!,
      google,
      notifyStatus: () => ({
        supported: Notification.isSupported(),
        shown: toastState.shown,
        error: toastState.error
      }),
      notifyReset: () => {
        toastState.shown = false
        toastState.error = null
      },
      dbPath,
      getWindow: () => mainWindow,
      getVault: () => vault,
      switchVault: (r) => startVault(process.env['NM_VAULT'] || r),
      applyAppSettings
    })
    calendar.start()
    gmail.start()
    engine.start()
    applyAppSettings()
    startVault(vaultRoot()).catch((e) => console.error('[vault] init failed', e))

    // A sleeping laptop misses ticks: on wake, catch up immediately and refresh the data first.
    powerMonitor.on('resume', () => {
      void calendar?.sync().then(() => engine?.tick())
      void gmail?.sync()
      engine?.tick()
    })

    // Test hook: lets an automated UI test see the capture window without pressing a global hotkey.
    if (process.env['NM_SHOW_CAPTURE']) setTimeout(() => capture?.show(), 3000)

    createWindow()
    app.on('activate', showMainWindow)
  })

  app.on('before-quit', () => {
    quitting = true
    calendar?.stop()
    gmail?.stop()
    engine?.stop()
    tray?.destroy()
    capture?.dispose()
    void vault?.close()
    db?.close()
  })
  app.on('window-all-closed', () => {
    // Normally the window only hides. If it is truly closed (background mode off), quit.
    if (process.platform !== 'darwin' && !getSettings().runInBackground) app.quit()
  })
}
