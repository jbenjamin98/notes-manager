/** What the user is doing: asking about their notes, or dumping something to capture. */
export type Intent = 'ask' | 'capture'

const QUESTION_START =
  /^(what|when|who|whom|whose|where|why|how|which|did|do|does|is|are|was|were|can|could|should|would|will|show|find|list|summari[sz]e|tell me|remind me what|any )/i

export function classifyIntent(text: string): { intent: Intent; text: string } {
  const t = text.trim()
  // Explicit overrides win.
  const ask = /^\/ask\s+/i.exec(t)
  if (ask) return { intent: 'ask', text: t.slice(ask[0].length).trim() }
  const cap = /^\/(note|capture|add)\s+/i.exec(t)
  if (cap) return { intent: 'capture', text: t.slice(cap[0].length).trim() }
  // A question mark at the end, or a question opener, with no multi-line brain dump.
  const oneLine = !t.includes('\n')
  if (oneLine && (t.endsWith('?') || QUESTION_START.test(t)) && t.split(/\s+/).length <= 40) {
    return { intent: 'ask', text: t }
  }
  return { intent: 'capture', text: t }
}

/** Anything labelled CUI stays on this computer. */
export const mentionsCui = (text: string): boolean =>
  /\bCUI\b|controlled\s+unclassified|\bFOUO\b|for\s+official\s+use\s+only|\bITAR\b|\bEAR99\b/i.test(
    text
  )

/** Strip things that should not leave the machine even for non-CUI text. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[number]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[number]')
}
