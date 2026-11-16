import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { BridgeError, type BridgeClient } from './bridge'
import { lastSelfTest, runSelfTest } from './health'

const fake = (impl: Partial<Record<'ping' | 'selfTest', () => Promise<unknown>>>): BridgeClient =>
  impl as unknown as BridgeClient

describe('bridge self-test', () => {
  it('remembers per-section results', async () => {
    const db = openDb(':memory:')
    const r = await runSelfTest(
      fake({
        ping: async () => ({ email: 'me@x.com', version: 5 }),
        selfTest: async () => ({
          sections: { calendar: { ok: true }, chat: { ok: false, error: 'Chat is not available' } }
        })
      }),
      db
    )
    expect(r.ok).toBe(false)
    expect(r.sections).toEqual([
      { name: 'calendar', ok: true, error: null },
      { name: 'chat', ok: false, error: 'Chat is not available' }
    ])
    expect(lastSelfTest(db)?.email).toBe('me@x.com')
  })

  it('turns a bridge error into a code and message, and stores it', async () => {
    const db = openDb(':memory:')
    const r = await runSelfTest(
      fake({
        ping: async () => {
          throw new BridgeError('needs-login', 'Sign in to Google again.')
        }
      }),
      db
    )
    expect(r).toMatchObject({ ok: false, code: 'needs-login', message: 'Sign in to Google again.' })
    expect(lastSelfTest(db)?.code).toBe('needs-login')
  })
})
