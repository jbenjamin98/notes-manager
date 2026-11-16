/**
 * Extractive helpers: the useful 80% of "summarize" and "find action items" with no AI. They only
 * select and rearrange sentences already in the note, so they can never invent anything.
 */
const clean = (s: string): string =>
  s
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

interface Block {
  heading: string
  lines: string[]
}

function blocks(md: string): Block[] {
  const out: Block[] = [{ heading: '', lines: [] }]
  for (const raw of md.split('\n')) {
    const h = /^#{1,6}\s+(.*)$/.exec(raw)
    if (h) out.push({ heading: h[1].trim(), lines: [] })
    else if (raw.trim() && !/^<!--/.test(raw.trim())) out[out.length - 1].lines.push(raw)
  }
  return out
}

const under = (bs: Block[], re: RegExp): string[] =>
  bs
    .filter((b) => re.test(b.heading))
    .flatMap((b) => b.lines.map(clean))
    .filter((l) => l.length > 2)
    .slice(0, 8)

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(clean)
    .filter((s) => s.length >= 25 && s.length <= 220)

export interface QuickSummary {
  tldr: string
  decisions: string[]
  questions: string[]
  nextSteps: string[]
}

export function quickSummary(md: string): QuickSummary | null {
  const bs = blocks(md)
  const decisions = under(bs, /decision|agreed|outcome/i)
  const questions = under(bs, /question|open|unknown|risk/i)
  const nextSteps = under(bs, /next step|action|follow[- ]?up|to ?do/i)
  // Decisions and questions also appear inline as "Decision: ..." / "Q: ..." lines.
  const inline = md.split('\n').map(clean)
  for (const l of inline) {
    if (/^(decision|decided|agreed)\s*[:-]/i.test(l))
      decisions.push(l.replace(/^[^:-]+[:-]\s*/, ''))
    else if (/^(q|question|open question)\s*[:-]/i.test(l))
      questions.push(l.replace(/^[^:-]+[:-]\s*/, ''))
  }
  const body = bs
    .filter((b) => !/decision|question|open|next step|action|follow|to ?do|risk/i.test(b.heading))
    .flatMap((b) => b.lines)
    .join('\n')
  const lead = sentences(body).slice(0, 2).join(' ')
  const nothing = !lead && !decisions.length && !questions.length && !nextSteps.length
  if (nothing) return null
  return {
    tldr: lead || 'Key points from the note:',
    decisions: [...new Set(decisions)].slice(0, 6),
    questions: [...new Set(questions)].slice(0, 6),
    nextSteps: [...new Set(nextSteps)].slice(0, 8)
  }
}

export function renderQuickSummary(s: QuickSummary): string {
  const sec = (t: string, xs: string[]): string =>
    xs.length ? `\n\n${t}\n${xs.map((x) => `• ${x}`).join('\n')}` : ''
  return (
    s.tldr +
    sec('Decisions', s.decisions) +
    sec('Open questions', s.questions) +
    sec('Next steps', s.nextSteps)
  )
}

const ACTION_CUE =
  /\b(will|to do|todo|action|need to|needs to|should|must|follow up|send|schedule|review|update|confirm|share|prepare|draft|check|finalize|book|ask|circle back)\b/i

/** Lines that read like something someone has to do and are not already tracked checkboxes. */
export function actionCandidates(md: string): string[] {
  const out: string[] = []
  for (const raw of md.split('\n')) {
    if (/^\s*[-*]\s+\[[ xX]\]/.test(raw)) continue
    if (!/^\s*(?:[-*•]|\d+[.)])\s+/.test(raw)) continue
    const l = clean(raw)
    if (l.length >= 8 && l.length <= 200 && ACTION_CUE.test(l) && !/\?$/.test(l)) out.push(l)
  }
  return [...new Set(out)].slice(0, 12)
}

export function quickFollowup(title: string, s: QuickSummary): { subject: string; body: string } {
  const list = (xs: string[]): string => xs.map((x) => `- ${x}`).join('\n')
  const parts = [
    'Hi all,',
    `Thanks for meeting about ${title}. A quick recap:`,
    s.tldr.endsWith(':') ? '' : s.tldr,
    s.decisions.length ? `Decisions\n${list(s.decisions)}` : '',
    s.nextSteps.length ? `Next steps\n${list(s.nextSteps)}` : '',
    s.questions.length ? `Still open\n${list(s.questions)}` : '',
    'Let me know if I missed anything.\n\nThanks,'
  ].filter(Boolean)
  return { subject: `Follow-up: ${title}`, body: parts.join('\n\n') }
}
