import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import {
  MERGED_SETTINGS,
  SettingsSchema,
  type Settings,
  type SettingsPatch
} from '../../shared/contract'

/** Machine-local settings live in userData (never in the Drive-synced vault). */
let cache: Settings | null = null
const file = (): string => join(app.getPath('userData'), 'settings.json')

export function defaultVaultPath(): string {
  return join(app.getPath('desktop'), 'NotesManager')
}

export function getSettings(): Settings {
  if (cache) return cache
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    /* first run or unreadable: fall back to defaults */
  }
  const parsed = SettingsSchema.safeParse(raw)
  cache = parsed.success ? parsed.data : SettingsSchema.parse({})
  if (!cache.vaultPath) cache = { ...cache, vaultPath: defaultVaultPath() }
  return cache
}

/** Apply a change: groups (google, llm, ...) are merged field by field, then everything is validated. */
export function mergeSettings(cur: Settings, patch: SettingsPatch): Settings {
  const raw: Record<string, unknown> = { ...cur, ...patch }
  for (const k of MERGED_SETTINGS)
    if (patch[k] && typeof patch[k] === 'object') raw[k] = { ...cur[k], ...patch[k] }
  return SettingsSchema.parse(raw)
}

export function updateSettings(patch: SettingsPatch): Settings {
  const next = mergeSettings(getSettings(), patch)
  mkdirSync(app.getPath('userData'), { recursive: true })
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, file())
  cache = next
  // Every open screen (main window, capture window) sees the change at once.
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send('settings:changed', next)
  return next
}
