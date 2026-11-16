import { describe, it, expect } from 'vitest'
import { AI_MODES, AI_PROFILES, fitContext, profileFor } from './aiProfile'

describe('AI modes', () => {
  it('scale up monotonically from light to heavy', () => {
    const [l, n, h] = AI_MODES.map((m) => AI_PROFILES[m])
    for (const key of [
      'retrieveK',
      'snippetChars',
      'historyTurns',
      'maxOut',
      'contextChars'
    ] as const) {
      expect(l[key]).toBeLessThan(n[key])
      expect(n[key]).toBeLessThan(h[key])
    }
    expect([l.proactive, n.proactive, h.proactive]).toEqual([false, false, true])
    expect([l.followups, n.followups, h.followups]).toEqual([false, false, true])
    expect(l.askTier).toBe('extract') // the cheaper model for light use
    expect(h.actionTier).toBe('chat')
  })

  it('falls back to normal for anything unknown', () => {
    expect(profileFor(undefined).mode).toBe('normal')
    expect(profileFor('turbo').mode).toBe('normal')
    expect(profileFor('heavy').mode).toBe('heavy')
  })

  it('trims context to a budget at a natural edge and says so', () => {
    const text = 'Line one is here.\nLine two is here.\nLine three is here.\nLine four is here.'
    expect(fitContext(text, 1000)).toBe(text)
    const cut = fitContext(text, 45)
    expect(cut.length).toBeLessThan(text.length)
    expect(cut.endsWith('[…shortened]')).toBe(true)
    expect(cut).not.toContain('Line four')
  })
})
