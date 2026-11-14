import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { SettingsSchema, type Settings } from '../../shared/contract'

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

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = SettingsSchema.parse({ ...getSettings(), ...patch })
  mkdirSync(app.getPath('userData'), { recursive: true })
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, file())
  cache = next
  return next
}
