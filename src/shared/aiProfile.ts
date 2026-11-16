/**
 * How much AI to use. One switch (Light / Normal / Heavy) sets every token-related knob at once, so
 * people on a free tier can stretch it and people on a paid key can get richer answers.
 */
export type AiMode = 'light' | 'normal' | 'heavy'
export type AiTier = 'extract' | 'chat'

export interface AiProfile {
  mode: AiMode
  label: string
  /** One line for the settings screen. */
  summary: string
  /** A rough, honest guide to what one request costs. */
  estimate: string
  /** Note snippets sent with a question, and the length of each. */
  retrieveK: number
  snippetChars: number
  /** Earlier chat turns included so follow-up questions make sense. */
  historyTurns: number
  /** Which model size answers questions / runs actions. */
  askTier: AiTier
  actionTier: AiTier
  /** Longest answer the model may write (output tokens). */
  maxOut: number
  /** Most text from notes, meetings or tasks packed into one action. */
  contextChars: number
  /** How many rounds of "look something up" the assistant may take before answering (0 = none). */
  agentSteps: number
  /** Ask the model to suggest follow-up questions after an answer. */
  followups: boolean
  /** Allow one repair attempt when the model's JSON is invalid. */
  repair: boolean
  /** Do useful things before being asked (an automatic day brief on Home). */
  proactive: boolean
}

export const AI_PROFILES: Record<AiMode, AiProfile> = {
  light: {
    mode: 'light',
    label: 'Quick',
    summary: 'Fewest tokens. Short answers from the smaller model, nothing automatic.',
    estimate: 'about 0.5 to 1.5k tokens per request',
    retrieveK: 4,
    snippetChars: 450,
    historyTurns: 2,
    askTier: 'extract',
    actionTier: 'extract',
    maxOut: 700,
    contextChars: 3500,
    agentSteps: 0,
    followups: false,
    repair: false,
    proactive: false
  },
  normal: {
    mode: 'normal',
    label: 'Standard',
    summary:
      'Balanced. Talks things through, looks things up when it needs to, remembers the conversation.',
    estimate: 'about 2 to 5k tokens per request (a second call when it needs to look something up)',
    retrieveK: 8,
    snippetChars: 900,
    historyTurns: 6,
    askTier: 'chat',
    actionTier: 'extract',
    maxOut: 1500,
    contextChars: 9000,
    agentSteps: 2,
    followups: false,
    repair: true,
    proactive: false
  },
  heavy: {
    mode: 'heavy',
    label: 'Detailed',
    summary:
      'Most thorough. More notes read, the larger model everywhere, suggested follow-ups, and an automatic day brief.',
    estimate: 'about 5 to 15k tokens per request (it may look things up up to four times)',
    retrieveK: 12,
    snippetChars: 1200,
    historyTurns: 12,
    askTier: 'chat',
    actionTier: 'chat',
    maxOut: 3000,
    contextChars: 18000,
    agentSteps: 4,
    followups: true,
    repair: true,
    proactive: true
  }
}

export const AI_MODES: AiMode[] = ['light', 'normal', 'heavy']

export function profileFor(mode: string | undefined): AiProfile {
  return AI_PROFILES[(mode as AiMode) in AI_PROFILES ? (mode as AiMode) : 'normal']
}

/** Trim text to a budget at a paragraph or sentence edge, marking the cut. */
export function fitContext(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const edge = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '))
  return (edge > max * 0.6 ? cut.slice(0, edge) : cut).trimEnd() + '\n[…shortened]'
}
