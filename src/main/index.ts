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
import { mkdirSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { openDb, type Db } from './db'
import { registerIpc } from './ipc'
import { Vault } from './vault/vault'
import { getSettings, updateSettings } from './services/settings'
import { CalendarSync } from './calendar/sync'
import { scrapeCalendar, scrapeGmail } from './services/google'
import { GmailSync, overview as mailOverview } from './gmail/sync'
import { NudgeEngine, type Nudge } from './nudges/engine'
import { LlmRouter } from './llm/router'
import { routerConfig } from './llm/config'
import { createSecretStore } from './services/secrets'
import { Assistant } from './assistant/assistant'
import { CaptureWindow } from './capture'

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
    (paths) => mainWindow?.webContents.send('vault:changed', { paths })
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
export function applyAppSettings(): void {
  const s = getSettings()
  capture?.apply()
  if (s.runInBackground && !tray) {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
    tray.setToolTip('notes-manager')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open notes-manager', click: showMainWindow },
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

function deliverToasts(list: Nudge[]): void {
  if (!engine || !Notification.isSupported() || !engine.shouldToast()) return
  const show = (title: string, body: string, id: string | null): void => {
    const t = new Notification({ title, body, silent: false })
    liveToasts.add(t)
    t.on('click', () => {
      showMainWindow()
      mainWindow?.webContents.send('nudges:focus', { id })
    })
    t.on('close', () => liveToasts.delete(t))
    t.show()
  }
  for (const n of list.slice(0, 3)) show(n.title, n.body.split('\n').slice(0, 3).join('\n'), n.id)
  if (list.length > 3)
    show(`${list.length - 3} more nudges`, 'Open notes-manager to see them.', null)
}

// One instance only: two instances would fight over the SQLite file and the vault.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.notesmanager.app')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    mkdirSync(app.getPath('userData'), { recursive: true })
    const dbPath = join(app.getPath('userData'), 'index.db')
    db = openDb(dbPath)
    const send = (ch: string, payload: unknown): void => mainWindow?.webContents.send(ch, payload)

    engine = new NudgeEngine(db, {
      getSettings: () => getSettings(),
      getTasks: () => vault?.listTasks() ?? [],
      getMail: () => (db ? mailOverview(db, getSettings().gmailLabels) : null),
      onNew: deliverToasts,
      onChanged: () => send('nudges:changed', { unread: engine?.unread() ?? 0 })
    })

    calendar = new CalendarSync(
      db,
      scrapeCalendar,
      (st) => send('calendar:changed', st),
      () => {
        send('calendar:changed', calendar?.getStatus())
        engine?.tick() // fresh events can make a prep/capture nudge due right now
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
      scrapeGmail,
      (st) => send('gmail:changed', st),
      () => getSettings().gmailEnabled,
      () => getSettings().gmailDays
    )
    capture = new CaptureWindow({ icon, getSettings: () => getSettings().quickCapture })
    const secrets = createSecretStore(join(app.getPath('userData'), 'secrets.json'), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (p) => safeStorage.encryptString(p),
      decrypt: (b) => safeStorage.decryptString(b)
    })
    const llm = new LlmRouter({
      db,
      getKey: (p) => secrets.get('llm.' + p),
      getConfig: () => routerConfig(getSettings().llm)
    })
    const assistant = new Assistant({
      db,
      llm,
      vault: () => {
        if (!vault) throw new Error('Vault not ready')
        return vault
      },
      addReminder: (text, at) => engine!.addReminder(text, at),
      getSettings: () => getSettings()
    })
    registerIpc({
      db,
      calendar,
      gmail,
      engine,
      assistant,
      llm,
      secrets,
      capture: capture!,
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
