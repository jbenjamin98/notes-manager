/**
 * Getting the useful text out of raw mail, chat and meeting notes: no quoted replies, signatures,
 * footers or boilerplate, then split into sentences.
 */
const FOOTER =
  /^(sent from my|get outlook|unsubscribe|this (e-?mail|message) (is|and any)|confidential|disclaimer|you are receiving this|view (this|in) (email|browser)|to stop receiving)/i

/** An email body without the thread history, signature and footers. */
export function cleanEmail(raw: string): string {
  const lines = raw.replace(/\r/g, '').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    // Everything after "On <date>, X wrote:" or a forwarded/original-message divider is history.
    if (/^on .{8,120}wrote:?$/i.test(t) || /^-{2,}\s*(original|forwarded) message/i.test(t)) break
    // A pasted header block (From: / Sent: / To: / Subject:) also starts the quoted history.
    if (/^from:\s.+/i.test(t) && /^(sent|date|to|subject):/i.test(lines[i + 1]?.trim() ?? '')) break
    if (t.startsWith('>')) continue
    if (t === '--' || t === '-- ') break // signature delimiter
    if (FOOTER.test(t)) break
    out.push(line)
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Chat text: mentions flattened, emoji-only noise dropped. */
export function cleanChat(raw: string): string {
  return raw
    .replace(/<users\/\d+>/g, '@someone')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Meeting notes: Markdown syntax removed, headings kept as their own sentences. */
export function cleanNotes(raw: string): string {
  return raw
    .replace(/^---[\s\S]*?\n---\s*/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s\^[A-Za-z0-9]{3,12}\s*$/gm, '')
    .trim()
}

/** Sentences and list lines, each trimmed; very short or very long ones dropped. */
export function sentences(text: string): string[] {
  const out: string[] = []
  for (const block of text.split(/\n+/)) {
    const b = block.trim()
    if (!b) continue
    // Split on sentence ends but not on "e.g." / "Dr." / decimals.
    const parts = b.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(@])/)
    for (const p of parts) {
      const s = p.replace(/\s+/g, ' ').trim()
      if (s.length >= 8 && s.length <= 400) out.push(s)
    }
  }
  return out
}
