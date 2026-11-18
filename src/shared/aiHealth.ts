import type { LlmStatus } from './contract'

export type AiTone = 'ok' | 'warn' | 'bad'

export interface AiHealth {
  /** Nothing to show (AI is off, or there is no key to use). */
  hidden: boolean
  tone: AiTone
  /** Short text for the sidebar chip. */
  label: string
  /** One sentence for the tooltip and the Co-Pilot banner. */
  detail: string
  /** 0 to 1 share of today's budget used (0 when there is no budget). */
  budgetShare: number
}

/** Seconds until a time, as "45s" or "3 min". */
export function untilText(until: number, now: number): string {
  const s = Math.max(1, Math.ceil((until - now) / 1000))
  return s < 90 ? `${s}s` : `${Math.ceil(s / 60)} min`
}

const kTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

/**
 * One answer to "is the AI okay right now?" from the router's status: out of budget, every provider
 * cooling down or rejected, nearly out of budget, or fine. The sidebar chip, the Co-Pilot banner and
 * Settings all read this so they never disagree.
 */
export function aiHealth(s: LlmStatus | null, now: number): AiHealth {
  const hidden: AiHealth = { hidden: true, tone: 'ok', label: '', detail: '', budgetShare: 0 }
  if (!s || !s.enabled) return hidden
  const live = s.providers.filter((p) => p.hasKey && p.enabled)
  if (live.length === 0) return hidden

  const { used, limit } = s.budget
  const share = limit > 0 ? Math.min(1, used / limit) : 0
  const base = { hidden: false, budgetShare: share }

  if (limit > 0 && used >= limit)
    return {
      ...base,
      tone: 'bad',
      label: 'AI budget used',
      detail: `Today's AI budget (${limit.toLocaleString()} tokens) is used up, so the Co-Pilot is working on your computer until tomorrow. Raise it in Settings.`
    }

  const ready = live.filter((p) => p.state === 'ready')
  if (ready.length === 0) {
    const rejected = live.every((p) => p.state === 'auth-failed')
    if (rejected)
      return {
        ...base,
        tone: 'bad',
        label: 'AI key rejected',
        detail: 'The AI provider rejected its key. Paste a new one in Settings.'
      }
    const next = live
      .map((p) => p.until)
      .filter((u): u is number => typeof u === 'number' && u > now)
      .sort((a, b) => a - b)[0]
    return {
      ...base,
      tone: 'warn',
      label: next ? `AI resting ${untilText(next, now)}` : 'AI resting',
      detail: next
        ? `The AI provider is rate-limited or busy. It resumes in about ${untilText(next, now)}; meanwhile the Co-Pilot works on your computer.`
        : 'The AI provider is rate-limited or busy. It resumes by itself.'
    }
  }

  // A provider reporting almost nothing left in its window is worth a heads-up too.
  const low = ready.find((p) => {
    const l = p.limits
    if (!l || now - l.seenAt > 120_000) return false
    const r = l.limitRequests ? (l.remainingRequests ?? Infinity) / l.limitRequests : 1
    const t = l.limitTokens ? (l.remainingTokens ?? Infinity) / l.limitTokens : 1
    return Math.min(r, t) < 0.1
  })
  if (low)
    return {
      ...base,
      tone: 'warn',
      label: 'AI nearly at its limit',
      detail: `${low.label} reports less than 10% of its current rate limit left. The Co-Pilot will switch providers or wait if it runs out.`
    }

  if (share >= 0.8)
    return {
      ...base,
      tone: 'warn',
      label: `AI ${Math.round(share * 100)}% of budget`,
      detail: `${used.toLocaleString()} of ${limit.toLocaleString()} tokens used today. At the limit the Co-Pilot works on your computer until tomorrow.`
    }

  return {
    ...base,
    tone: 'ok',
    label: limit > 0 ? `AI ${kTokens(used)} / ${kTokens(limit)}` : 'AI ready',
    detail:
      limit > 0
        ? `${used.toLocaleString()} of ${limit.toLocaleString()} tokens used today.`
        : `${used.toLocaleString()} tokens used today (no daily limit).`
  }
}

/** Plain names for what tokens were spent on. One map for Settings, the Co-Pilot and the sidebar. */
export function featureLabel(f: string): string {
  if (f.startsWith('action:')) return f.slice(7).replace(/-/g, ' ')
  switch (f) {
    case 'ask':
      return 'Questions'
    case 'capture':
      return 'Brain-dumps'
    case 'names':
      return 'Name cleanup'
    case 'autotag':
      return 'Auto-tagging'
    case 'insights':
      return 'Reading mail and meetings'
    case 'proactive':
      return 'Proactive nudges'
    default:
      return 'Other'
  }
}
