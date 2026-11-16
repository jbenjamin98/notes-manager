import { BrowserWindow, globalShortcut, screen, nativeTheme } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

/**
 * Global quick-capture: press the hotkey anywhere in Windows, type a task, press Enter.
 * The small window is created on first use and thrown away after a while idle, so it costs no
 * memory for people who rarely use it.
 */
export interface CaptureSettings {
  enabled: boolean
  hotkey: string
}

const IDLE_DESTROY_MS = 10 * 60_000
const BASE_HEIGHT = 172
const MAX_HEIGHT = 340

export class CaptureWindow {
  private win: BrowserWindow | null = null
  private idle: NodeJS.Timeout | null = null
  private registered: string | null = null
  private ok = false

  constructor(
    private deps: {
      icon: string
      getSettings: () => CaptureSettings
      /** Show the in-app Co-Pilot / main window afterwards, if wanted. */
      onSubmitted?: () => void
      /** Tests only: do not hide when another window takes focus. */
      keepOnBlur?: boolean
    }
  ) {}

  /** Whether the hotkey is currently registered (it can fail if another app owns it). */
  status(): { registered: boolean; hotkey: string } {
    return { registered: this.ok, hotkey: this.deps.getSettings().hotkey }
  }

  /** Re-apply settings: (un)register the shortcut. Returns whether it is now active. */
  apply(): boolean {
    const s = this.deps.getSettings()
    if (this.registered) {
      globalShortcut.unregister(this.registered)
      this.registered = null
    }
    this.ok = false
    if (!s.enabled || !s.hotkey) return false
    try {
      this.ok = globalShortcut.register(s.hotkey, () => this.toggle())
      if (this.ok) this.registered = s.hotkey
    } catch {
      this.ok = false // an invalid accelerator string
    }
    return this.ok
  }

  dispose(): void {
    if (this.registered) globalShortcut.unregister(this.registered)
    this.registered = null
    this.win?.destroy()
    this.win = null
  }

  hide(): void {
    this.win?.hide()
  }

  /** Grow or shrink with the text, keeping the top edge where it is. */
  resize(height: number): void {
    const w = this.win
    if (!w || w.isDestroyed()) return
    const h = Math.max(BASE_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)))
    const b = w.getBounds()
    if (Math.abs(b.height - h) > 2) w.setBounds({ ...b, height: h })
  }

  toggle(): void {
    if (this.win?.isVisible()) return this.hide()
    this.show()
  }

  private create(): BrowserWindow {
    const w = new BrowserWindow({
      width: 560,
      height: BASE_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#12141f' : '#f4f6ff',
      icon: this.deps.icon,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    // Click anywhere else and it goes away (test runs keep it up so it can be driven and captured).
    if (!this.deps.keepOnBlur) w.on('blur', () => w.hide())
    w.on('hide', () => this.armIdle())
    w.on('closed', () => {
      if (this.win === w) this.win = null
    })
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void w.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#capture')
    } else {
      void w.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'capture' })
    }
    return w
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      if (this.win && !this.win.isVisible()) {
        this.win.destroy()
        this.win = null
      }
    }, IDLE_DESTROY_MS)
  }

  show(): void {
    if (this.idle) clearTimeout(this.idle)
    const first = !this.win
    const w = this.win ?? (this.win = this.create())
    const place = (): void => {
      // Centred near the top of whichever screen the mouse is on.
      const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const { x, y, width } = d.workArea
      const [ww] = w.getSize()
      w.setBounds({
        x: Math.round(x + (width - ww) / 2),
        y: Math.round(y + 140),
        width: ww,
        height: BASE_HEIGHT
      })
      w.show()
      w.focus()
      w.webContents.send('capture:shown', null)
    }
    if (first) w.webContents.once('did-finish-load', place)
    else place()
  }
}
