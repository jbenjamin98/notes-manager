import { describe, it, expect } from 'vitest'
import { aiHealth, featureLabel, untilText } from './aiHealth'
import type { LlmStatus } from './contract'

const NOW = 1_000_000_000
type P = LlmStatus['providers'][number]

const prov = (over: Partial<P> = {}): P => ({
  id: 'gemini',
  label: 'Google Gemini',
  blurb: '',
  keyUrl: '',
  paid: false,
  hasKey: true,
  enabled: true,
  state: 'ready',
  until: null,
  lastError: null,
  models: { extract: 'a', chat: 'b' },
  modelsCustom: false,
  usage: { lastMinute: 0, today: 0, failedToday: 0, tokensToday: 0 },
  limits: null,
  ...over
})

const status = (over: Partial<LlmStatus> = {}, providers: P[] = [prov()]): LlmStatus => ({
  enabled: true,
  budget: { used: 1000, limit: 60000 },
  usage: [],
  cacheHits: 0,
  history: [],
  events: [],
  canStoreKeys: true,
  providers,
  ...over
})

describe('aiHealth', () => {
  it('is hidden when AI is off or has no key', () => {
    expect(aiHealth(null, NOW).hidden).toBe(true)
    expect(aiHealth(status({ enabled: false }), NOW).hidden).toBe(true)
    expect(aiHealth(status({}, [prov({ hasKey: false, state: 'no-key' })]), NOW).hidden).toBe(true)
  })

  it('is fine, and says how much of the budget is used', () => {
    const h = aiHealth(status(), NOW)
    expect(h).toMatchObject({ hidden: false, tone: 'ok', label: 'AI 1.0k / 60k' })
  })

  it('warns at 80% of the budget and goes red when it is spent', () => {
    expect(aiHealth(status({ budget: { used: 50000, limit: 60000 } }), NOW).tone).toBe('warn')
    const spent = aiHealth(status({ budget: { used: 60000, limit: 60000 } }), NOW)
    expect(spent).toMatchObject({ tone: 'bad', label: 'AI budget used' })
  })

  it('counts down while every provider is cooling off', () => {
    const h = aiHealth(status({}, [prov({ state: 'cooldown', until: NOW + 45_000 })]), NOW)
    expect(h).toMatchObject({ tone: 'warn', label: 'AI resting 45s' })
  })

  it('stays fine if one provider is cooling but another is ready', () => {
    const h = aiHealth(
      status({}, [prov({ state: 'cooldown', until: NOW + 45_000 }), prov({ id: 'groq' })]),
      NOW
    )
    expect(h.tone).toBe('ok')
  })

  it('goes red when every key was rejected', () => {
    const h = aiHealth(status({}, [prov({ state: 'auth-failed' })]), NOW)
    expect(h).toMatchObject({ tone: 'bad', label: 'AI key rejected' })
  })

  it('warns when the provider says under 10% of its window is left', () => {
    const limits = {
      remainingRequests: 1,
      limitRequests: 30,
      remainingTokens: null,
      limitTokens: null,
      seenAt: NOW - 1000
    }
    expect(aiHealth(status({}, [prov({ limits })]), NOW)).toMatchObject({
      tone: 'warn',
      label: 'AI nearly at its limit'
    })
    // An old reading says nothing about now.
    expect(
      aiHealth(status({}, [prov({ limits: { ...limits, seenAt: NOW - 600_000 } })]), NOW).tone
    ).toBe('ok')
  })
})

describe('helpers', () => {
  it('formats a wait', () => {
    expect(untilText(NOW + 30_000, NOW)).toBe('30s')
    expect(untilText(NOW + 300_000, NOW)).toBe('5 min')
  })
  it('names every purpose', () => {
    expect(featureLabel('autotag')).toBe('Auto-tagging')
    expect(featureLabel('insights')).toBe('Reading mail and meetings')
    expect(featureLabel('action:summarize-note')).toBe('summarize note')
    expect(featureLabel('whatever')).toBe('Other')
  })
})
