import { describe, expect, it } from 'vitest'
import { isDriveDocUrl } from './urls'

describe('Drive document addresses', () => {
  it('accepts docs, sheets and slides, with or without a trailing path', () => {
    expect(isDriveDocUrl('https://docs.google.com/document/d/1AbC-d_e')).toBe(true)
    expect(isDriveDocUrl('https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0')).toBe(true)
    expect(isDriveDocUrl('https://docs.google.com/presentation/d/1AbC/edit')).toBe(true)
  })
  it('rejects look-alikes and other schemes', () => {
    expect(isDriveDocUrl('http://docs.google.com/document/d/1AbC')).toBe(false)
    expect(isDriveDocUrl('https://docs.google.com.evil.com/document/d/1AbC')).toBe(false)
    expect(isDriveDocUrl('https://evil.com/?u=https://docs.google.com/document/d/1')).toBe(false)
    expect(isDriveDocUrl('javascript:alert(1)')).toBe(false)
  })
})
