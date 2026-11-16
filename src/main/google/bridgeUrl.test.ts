import { describe, expect, it } from 'vitest'
import { isBridgeUrl } from './bridge'

describe('bridge address check', () => {
  it('accepts personal and Workspace web app addresses', () => {
    expect(isBridgeUrl('https://script.google.com/macros/s/AKfycbxABC-_123/exec')).toBe(true)
    expect(isBridgeUrl('https://script.google.com/a/macros/appian.com/s/AKfycbxABC/exec')).toBe(
      true
    )
    expect(isBridgeUrl('https://script.google.com/a/appian.com/macros/s/AKfycbxABC/exec')).toBe(
      true
    )
  })
  it('rejects the editor link, the /dev test URL and other sites', () => {
    expect(isBridgeUrl('https://script.google.com/home/projects/123/edit')).toBe(false)
    expect(isBridgeUrl('https://script.google.com/macros/s/AKfycbxABC/dev')).toBe(false)
    expect(isBridgeUrl('https://evil.example.com/macros/s/AKfycbxABC/exec')).toBe(false)
    expect(isBridgeUrl('http://script.google.com/macros/s/AKfycbxABC/exec')).toBe(false)
  })
})
