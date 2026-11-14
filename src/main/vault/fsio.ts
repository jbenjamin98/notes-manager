import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { sha256 } from './ids'

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE'])
const DELAYS = [50, 100, 200, 400, 800, 1600]

/** Retry on Windows sharing violations (Drive/AV briefly holding a handle). */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i <= DELAYS.length; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      const code = (err as NodeJS.ErrnoException).code
      if (!code || !RETRYABLE.has(code) || i === DELAYS.length) throw err
      await new Promise((r) => setTimeout(r, DELAYS[i]))
    }
  }
  throw last
}

export const readText = (abs: string): Promise<string> => withRetry(() => fs.readFile(abs, 'utf8'))

export const TMP_SUFFIX = '.nm-tmp'

/** Write via temp file + rename in the SAME directory (atomic on one volume). */
export async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(dirname(abs), { recursive: true })
  const tmp = abs + TMP_SUFFIX
  await withRetry(() => fs.writeFile(tmp, content, 'utf8'))
  try {
    await withRetry(() => fs.rename(tmp, abs))
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export interface PatchResult {
  changed: boolean
  content: string
}

/**
 * Compare-and-swap line edit: read, compute the minimal change, and only write
 * if the file is still byte-identical to what we read (a newer Drive copy may
 * have landed meanwhile). On mismatch, re-read and re-apply the same edit.
 * `edit` returns null to signal "target not found" (-> throws).
 */
export async function patchFile(
  abs: string,
  edit: (content: string) => string | null,
  attempts = 5
): Promise<PatchResult> {
  for (let i = 0; i < attempts; i++) {
    const before = await readText(abs)
    const next = edit(before)
    if (next === null) throw new Error('PATCH_TARGET_NOT_FOUND')
    if (next === before) return { changed: false, content: before }
    const recheck = await readText(abs)
    if (sha256(recheck) !== sha256(before)) continue // changed underneath us: redo
    await atomicWrite(abs, next)
    return { changed: true, content: next }
  }
  throw new Error('PATCH_CONFLICT')
}
