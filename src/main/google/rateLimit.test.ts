import { describe, it, expect } from 'vitest'
import { ApiError } from './api'
import { BridgeError } from './bridge'
import { isRateLimited } from './rateLimit'

describe('isRateLimited', () => {
  it('recognises the OAuth and script errors by type, not wording', () => {
    expect(isRateLimited(new ApiError(429, 'anything at all', 'rate'))).toBe(true)
    expect(isRateLimited(new BridgeError('rate-limited', 'whatever'))).toBe(true)
    expect(isRateLimited(new ApiError(403, 'no scope', 'scope'))).toBe(false)
    expect(isRateLimited(new BridgeError('needs-login', 'sign in'))).toBe(false)
  })

  it('still understands a plain message that lost its type', () => {
    expect(isRateLimited(new Error('Google is limiting how fast mail can be read'))).toBe(true)
    expect(isRateLimited(new Error('network down'))).toBe(false)
    expect(isRateLimited(undefined)).toBe(false)
  })
})
