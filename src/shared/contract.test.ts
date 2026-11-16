import { describe, it, expect } from 'vitest'
import { contract } from './contract'

describe('IPC contract guards', () => {
  it('accepts real ISO dates and null for task due dates, rejects junk', () => {
    const due = contract['tasks:set-due'].input
    expect(due.safeParse({ id: 't1', due: '2026-11-27' }).success).toBe(true)
    expect(due.safeParse({ id: 't1', due: null }).success).toBe(true)
    expect(due.safeParse({ id: 't1', due: 'tomorrow' }).success).toBe(false)
    expect(due.safeParse({ id: 't1', due: '2026-1-5' }).success).toBe(false)
  })
  it('validates new-note dates and titles', () => {
    const create = contract['notes:create'].input
    expect(create.safeParse({ kind: 'adhoc', title: 'x', date: '2026-11-13' }).success).toBe(true)
    expect(create.safeParse({ kind: 'adhoc', title: '', date: '2026-11-13' }).success).toBe(false)
    expect(create.safeParse({ kind: 'adhoc', title: 'x', date: 'today' }).success).toBe(false)
  })
})

describe('older settings files', () => {
  it("read the Google source names from before ('session' and 'api')", async () => {
    const { SettingsSchema } = await import('./contract')
    expect(SettingsSchema.parse({ google: { method: 'session' } }).google.method).toBe('script')
    expect(SettingsSchema.parse({ google: { method: 'api' } }).google.method).toBe('oauth')
    expect(SettingsSchema.parse({}).google.method).toBe('script')
  })
})
