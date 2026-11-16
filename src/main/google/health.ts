import type { Db } from '../db'
import { BridgeError, QUOTA_RE, type BridgeClient } from './bridge'

/**
 * The bridge's self-test, run on demand (Verify, Repair) and once a day in the background, with the
 * result remembered so the health rows can say what is wrong without another round trip.
 */
export interface SelfTestResult {
  at: string
  ok: boolean
  code: string | null
  message: string | null
  email: string | null
  version: number | null
  sections: { name: string; ok: boolean; error: string | null }[]
}

const KEY = 'google.selftest'

export function lastSelfTest(db: Db): SelfTestResult | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(KEY) as
    { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value) as SelfTestResult
  } catch {
    return null
  }
}

export async function runSelfTest(bridge: BridgeClient, db: Db): Promise<SelfTestResult> {
  const base = { at: new Date().toISOString(), email: null, version: null, sections: [] }
  let r: SelfTestResult
  try {
    const p = await bridge.ping()
    const t = await bridge.selfTest()
    // Google asking us to slow down is not a fault in the script: say so, and count it as working.
    const sections = Object.entries(t.sections).map(([name, v]) => {
      const busy = !v.ok && !!v.error && QUOTA_RE.test(v.error)
      return {
        name,
        ok: v.ok || busy,
        error: busy
          ? 'Google is busy right now (a big read is in progress). Try again in a minute.'
          : (v.error ?? null)
      }
    })
    r = {
      ...base,
      ok: sections.every((s) => s.ok),
      code: null,
      message: null,
      email: p.email,
      version: p.version,
      sections
    }
  } catch (err) {
    r = {
      ...base,
      ok: false,
      code: err instanceof BridgeError ? err.code : 'error',
      message: (err as Error).message
    }
  }
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(KEY, JSON.stringify(r))
  return r
}

/** Once a day (and shortly after launch), only when the script is the active source. */
export function scheduleSelfTest(
  bridge: BridgeClient,
  db: Db,
  active: () => boolean,
  onResult?: (r: SelfTestResult) => void
): () => void {
  const run = (): void => {
    if (!active() || !bridge.configured()) return
    const last = lastSelfTest(db)
    if (last && Date.now() - Date.parse(last.at) < 20 * 3_600_000) return
    void runSelfTest(bridge, db).then((r) => onResult?.(r))
  }
  const first = setTimeout(run, 90_000)
  const t = setInterval(run, 3_600_000)
  return () => {
    clearTimeout(first)
    clearInterval(t)
  }
}
