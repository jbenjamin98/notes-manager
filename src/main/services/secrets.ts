import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * API keys never sit on disk in plain text and never leave this machine's userData folder.
 * Encryption is injected: in the app it is Electron's safeStorage (Windows DPAPI, tied to the
 * signed-in Windows user); in tests it is a stand-in.
 */
export interface Crypto {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export interface SecretStore {
  get(name: string): string | null
  has(name: string): boolean
  set(name: string, value: string): void
  delete(name: string): void
  /** False when the OS cannot encrypt: keys are then refused rather than stored in the clear. */
  canStore(): boolean
}

export function createSecretStore(file: string, crypto: Crypto): SecretStore {
  const load = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  const save = (data: Record<string, string>): void => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file)
  }
  return {
    canStore: () => crypto.available(),
    has: (name) => name in load(),
    get(name) {
      const b64 = load()[name]
      if (!b64) return null
      try {
        return crypto.decrypt(Buffer.from(b64, 'base64'))
      } catch {
        return null // unreadable (different Windows user, or corrupted): treat as "no key"
      }
    },
    set(name, value) {
      if (!crypto.available())
        throw new Error('This computer cannot encrypt secrets, so the key was not saved.')
      const data = load()
      data[name] = crypto.encrypt(value.trim()).toString('base64')
      save(data)
    },
    delete(name) {
      const data = load()
      delete data[name]
      save(data)
    }
  }
}
