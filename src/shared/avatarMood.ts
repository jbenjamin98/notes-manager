/**
 * What the assistant's face is doing, from what is happening in the chat. Pure and clock-driven so
 * it can be tested: the drawer feeds events and a regular `tick`, the avatar draws the mood.
 */
export type Mood =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'happy'
  | 'concerned'
  | 'surprised'
  | 'sleepy'
  | 'waking'

export type MoodEvent =
  | { type: 'typing' }
  | { type: 'send' }
  | { type: 'talk' }
  | { type: 'done' }
  | { type: 'success' }
  | { type: 'error' }
  | { type: 'proactive' }
  | { type: 'tick' }

export interface MoodState {
  mood: Mood
  /** When a passing mood (listening, happy, surprised...) ends; null = until something happens. */
  until: number | null
  /** Waiting on an answer: thinking wins over passing moods until the reply or an error. */
  busy: boolean
  lastActive: number
  lastTalk: number
  lastSurprise: number
}

export const MOOD_MS = {
  listening: 2200,
  happy: 2200,
  concerned: 3200,
  surprised: 1600,
  waking: 1400,
  /** Talking stops this long after the last word appears. */
  talkTail: 600,
  /** Nothing at all for this long and the assistant dozes off. */
  sleepAfter: 120_000,
  /** At most one "surprised" per this long, so a burst of messages is not a jump-scare. */
  surpriseCooldown: 20_000
} as const

export const initialMood = (now: number): MoodState => ({
  mood: 'idle',
  until: null,
  busy: false,
  lastActive: now,
  lastTalk: 0,
  lastSurprise: -Infinity
})

const pass = (s: MoodState, mood: Mood, now: number, ms: number): MoodState => ({
  ...s,
  mood,
  until: now + ms
})

export function stepMood(s: MoodState, e: MoodEvent, now: number): MoodState {
  if (e.type === 'tick') {
    if (s.mood === 'talking' && now - s.lastTalk > MOOD_MS.talkTail)
      return pass({ ...s, busy: false }, 'happy', now, 900)
    if (s.until !== null && now >= s.until)
      return { ...s, mood: s.busy ? 'thinking' : 'idle', until: null }
    if (s.mood === 'idle' && !s.busy && now - s.lastActive > MOOD_MS.sleepAfter)
      return { ...s, mood: 'sleepy', until: null }
    return s
  }

  // Anything that happens wakes a sleeping assistant first (with a stretch).
  const active = { ...s, lastActive: now }
  if (s.mood === 'sleepy' && e.type !== 'talk')
    return e.type === 'send'
      ? { ...active, mood: 'thinking', busy: true, until: null }
      : pass(active, 'waking', now, MOOD_MS.waking)

  switch (e.type) {
    case 'typing':
      if (s.busy || s.mood === 'talking' || s.mood === 'waking') return active
      return pass(active, 'listening', now, MOOD_MS.listening)
    case 'send':
      return { ...active, mood: 'thinking', busy: true, until: null }
    case 'talk':
      return { ...active, mood: 'talking', busy: false, until: null, lastTalk: now }
    case 'done':
      return s.mood === 'thinking' ? { ...active, mood: 'idle', busy: false, until: null } : active
    case 'success':
      return pass({ ...active, busy: false }, 'happy', now, MOOD_MS.happy)
    case 'error':
      return pass({ ...active, busy: false }, 'concerned', now, MOOD_MS.concerned)
    case 'proactive':
      if (s.busy || now - s.lastSurprise < MOOD_MS.surpriseCooldown) return active
      return pass({ ...active, lastSurprise: now }, 'surprised', now, MOOD_MS.surprised)
  }
}

/** Little extra moves; each has a cool-down so they stay charming, not noisy. */
export type Quirk = 'wink' | 'glance' | 'signature' | 'double-blink'
export const QUIRK_COOLDOWN: Record<Quirk, number> = {
  wink: 40_000,
  glance: 9_000,
  signature: 16_000,
  'double-blink': 12_000
}

/** Pick the next quirk that is off cool-down (random among them), or null. Only when relaxed. */
export function pickQuirk(
  mood: Mood,
  last: Partial<Record<Quirk, number>>,
  now: number,
  rand: () => number = Math.random
): Quirk | null {
  if (mood !== 'idle' && mood !== 'listening' && mood !== 'thinking') return null
  const pool = (Object.keys(QUIRK_COOLDOWN) as Quirk[]).filter(
    (q) =>
      now - (last[q] ?? -Infinity) >= QUIRK_COOLDOWN[q] &&
      // no winking at you while you type, no wandering eyes while thinking hard
      !(mood === 'listening' && q === 'wink') &&
      !(mood === 'thinking' && q === 'glance')
  )
  if (pool.length === 0) return null
  return pool[Math.floor(rand() * pool.length)]
}
