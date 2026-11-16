import { afterEach, describe, expect, it } from 'vitest'
import { defaultClientId, defaultClientSecret, effectiveClientId } from './defaults'

afterEach(() => {
  delete process.env['NM_GOOGLE_CLIENT_ID']
  delete process.env['NM_GOOGLE_CLIENT_SECRET']
})

describe('the company Google sign-in client', () => {
  it('is used for everyone when built in (a pasted client no longer wins)', () => {
    process.env['NM_GOOGLE_CLIENT_ID'] = 'company.apps.googleusercontent.com'
    process.env['NM_GOOGLE_CLIENT_SECRET'] = 'GOCSPX-x'
    expect(defaultClientId()).toBe('company.apps.googleusercontent.com')
    expect(defaultClientSecret()).toBe('GOCSPX-x')
    expect(effectiveClientId('mine.apps.googleusercontent.com')).toBe(
      'company.apps.googleusercontent.com'
    )
  })

  it('without one, an older pasted client keeps working; otherwise there is no sign-in', () => {
    expect(defaultClientId()).toBe('')
    expect(effectiveClientId('  old.apps.googleusercontent.com ')).toBe(
      'old.apps.googleusercontent.com'
    )
    expect(effectiveClientId('')).toBe('')
  })
})
