import * as chrono from 'chrono-node'
import { sentences } from './clean'
import type { Candidate, ExtractCtx, InsightKind, Utterance } from './types'

/**
 * Rule-based reading of text for the things that matter. It is the free, offline path and the
 * "gate" that decides what is worth showing a language model. It looks at the *meaning shape* of a
 * sentence (a commitment, a request, a settled choice, a moved date...) rather than a few phrases,
 * and at the *conversation shape* (a proposal followed by agreement is a decision).
 */
const DECISION: RegExp[] = [
  /\b(decided|agreed|resolved|concluded|settled)\b/i,
  /\b(approved|signed[- ]off|sign[- ]off|green[- ]?light(?:ed)?|go[- ]ahead|got the nod)\b/i,
  /\b(?:going|go|went|gone) with\b/i,
  /\blet'?s (?:go|proceed|move forward|use|do|stick|keep|ship|launch|plan)\b/i,
  /\b(?:we|i|they)(?:'ll| will| are going to|'re going to|'re) (?:go|proceed|move forward|stick|use|take|keep|launch)\b/i,
  /\bthe (?:plan|decision|call|approach|direction|answer|outcome) is\b/i,
  /\b(?:confirmed|finali[sz]ed|locked in|final(?:ly)? (?:going|using))\b/i,
  /\b(?:chose|chosen|selected|picked|opted)\b/i,
  /\b(?:no longer|not going to|won'?t be|will not be|dropping|scrapped|cancel(?:l)?ed)\b/i,
  /\bwe(?:'re| are) (?:good|set|clear) to\b/i
]
const CHANGE =
  /\b(moved|pushed|postponed|rescheduled|delayed|slipp(?:ed|ing)|extended|brought forward|pulled in|re-?baselined|now (?:due|scheduled|targeting))\b/i
const RISK =
  /\b(risks?|at risk|blockers?|blocked|blocking|concerns?|dependenc(?:y|ies)|depends? on|behind schedule|unable to|won'?t (?:make|be able|be ready)|might slip|may slip|could slip|escalat\w+|showstopper|not ready|no owner|unresolved|waiting (?:on|for))\b/i
const REQUEST =
  /\b(?:can|could|would|will) you\b|\bplease\b|\bneed (?:you|your)\b|\bwe need\b|\bmake sure\b|\bdon'?t forget\b|\bremind\b|\bI need\b|\bcan we get\b|\bwould love\b|\bany chance\b|\blet me know\b/i
const COMMIT =
  /\b(?:i|we)(?:'ll| will| am going to|'m going to| can take| will take| should be able to| plan to| intend to)\b|\blet me\b|\bon it\b|\bwill do\b|\bi can\b/i
const NAMED_WILL =
  /^(@?[A-Z][\p{L}'-]+(?: [A-Z][\p{L}'-]+)?)(?:,)? (?:will|to|needs to|should|must|is going to|is to|has to|agreed to|is on the hook to)\b/u
const IMPERATIVE =
  /^(?:send|schedule|review|update|confirm|share|prepare|draft|check|finali[sz]e|book|ask|follow up|circle back|set up|create|fix|test|deploy|investigate|reach out|call|email|ping|write|add|remove|upload|verify|escalate|document|submit|order|arrange|organi[sz]e|coordinate|chase|raise|log|file)\b/i
const ACTION_LEAD =
  /^(?:action items?|todo|to-?do|next steps?|follow[- ]?ups?|takeaways?|owner)\s*[:-]\s*/i
const ROLE =
  /^((?:[A-Z][\p{L}'-]+)(?: [A-Z][\p{L}'-]+){0,2}) (?:is|will be|has been|was|remains) (?:now )?(?:the |our |their |a |an )?([a-z][\w -]{2,40}?(?:sponsor|owner|lead|manager|contact|approver|architect|champion|stakeholder|director|engineer|analyst|decision[- ]maker|point of contact|PM|VP|CTO|CIO|CEO))\b/u
const OWNS =
  /^((?:[A-Z][\p{L}'-]+)(?: [A-Z][\p{L}'-]+){0,2}) (?:owns|leads|manages|is responsible for|is accountable for|is driving|is running) (.{3,80})/u
const PROPOSAL =
  /\b(?:option [a-z0-9]\b|proposal|propos(?:e|ing)|how about|what if|shall we|should we|i suggest|i'?d suggest|my vote|i recommend|we could|let'?s|i think (?:we|option|[ab]\b)|what do you think|thoughts)\b/i
const AGREE =
  /^(?:\+1|\+\+|agree(?:d)?\b|yes\b|yep\b|yeah\b|sounds good|works for me|lgtm|approved|ok(?:ay)?\b|let'?s do it|go for it|makes sense|i'?m (?:good|fine|happy) with|that works|do it|perfect|great,? (?:let'?s|go)|ship it|👍|✅)/i

const LABEL: [RegExp, InsightKind][] = [
  [/^(?:risks?|issues?|blockers?|concerns?|dependenc(?:y|ies))\s*[:-]/i, 'risk'],
  [/^(?:decisions?|decided|agreed|outcomes?)\s*[:-]/i, 'decision'],
  [/^(?:open )?questions?\s*[:-]/i, 'question'],
  [/^(?:changes?|updated?)\s*[:-]/i, 'change']
]
/** "has not confirmed", "hasn't approved", "yet to decide": the opposite of a decision. */
const NEGATED =
  /\b(?:not|n't|never|yet to|still waiting (?:on|for)|no)\b[^.]{0,20}\b(?:confirm\w*|approv\w*|decid\w*|agree\w*|final\w*|sign\w*)/i

const clip = (s: string, n = 300): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function dateIn(text: string, now: Date): string | null {
  const r = chrono.parse(text, now, { forwardDate: true })[0]
  if (!r) return null
  const d = r.start.date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const isMe = (name: string, me: string[]): boolean => {
  const n = name.replace(/^@/, '').toLowerCase()
  return me.some((m) => m.toLowerCase() === n)
}

/** What kind of thing is this sentence, if any? One kind per sentence, strongest first. */
export function classify(
  sentence: string,
  speaker: { who: string; fromMe: boolean },
  ctx: ExtractCtx
): Omit<Candidate, 'text' | 'evidence'> | null {
  const s = sentence.trim()
  const asks = s.endsWith('?')
  const due = dateIn(s, ctx.now)
  const mk = (
    kind: InsightKind,
    owner: string | null,
    confidence: number
  ): Omit<Candidate, 'text' | 'evidence'> => ({
    kind,
    owner,
    due: kind === 'decision' || kind === 'fact' || kind === 'question' ? null : due,
    confidence: Math.min(0.95, confidence + (due ? 0.05 : 0))
  })

  if (s.length < 12) return null
  for (const [re, kind] of LABEL) {
    const m = re.exec(s)
    if (m && s.length - m[0].length >= 6) return mk(kind, null, 0.75)
  }
  if (
    !asks &&
    !NEGATED.test(s) &&
    DECISION.some((r) => r.test(s)) &&
    !/^(if|when|once|unless)\b/i.test(s)
  )
    return mk('decision', null, 0.7)
  if (!asks && CHANGE.test(s) && (due || /\b(to|until|from|by)\b/i.test(s)))
    return mk('change', null, 0.7)
  const role = ROLE.exec(s)
  if (role && !asks) return mk('fact', role[1], 0.6)
  const owns = OWNS.exec(s)
  if (owns && !asks) return mk('fact', owns[1], 0.55)

  const lead = ACTION_LEAD.exec(s)
  const body = lead ? s.slice(lead[0].length) : s
  const named = NAMED_WILL.exec(body)
  if (named && !asks) {
    const owner = isMe(named[1], ctx.me) ? 'Me' : named[1].replace(/^@/, '')
    return mk(owner === 'Me' && !speaker.fromMe ? 'ask' : 'action', owner, 0.7)
  }
  if (!asks && COMMIT.test(s)) {
    if (speaker.fromMe) return mk('promise', 'Me', 0.65)
    return mk('action', speaker.who || null, 0.6)
  }
  if (REQUEST.test(s) && !speaker.fromMe) return mk('ask', 'Me', asks ? 0.65 : 0.6)
  if (REQUEST.test(s) && speaker.fromMe) return mk('action', null, 0.5)
  if (lead || IMPERATIVE.test(body)) return mk('action', null, lead ? 0.65 : 0.55)
  if (!asks && (RISK.test(s) || NEGATED.test(s))) return mk('risk', null, 0.6)
  if (asks && s.length >= 18 && ctx.source !== 'chat') return mk('question', null, 0.5)
  return null
}

/** Insights from a block of text (a meeting note or an email body). */
export function extractFromText(text: string, ctx: ExtractCtx, who = ''): Candidate[] {
  return extractFromUtterances([{ who, text, fromMe: false }], ctx, false)
}

/** Insights from a conversation: sentence by sentence, plus patterns that span messages. */
export function extractFromUtterances(
  us: Utterance[],
  ctx: ExtractCtx,
  threadLogic = true
): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const push = (c: Candidate): void => {
    const k = `${c.kind}:${c.text.toLowerCase().replace(/\W+/g, ' ').trim()}`
    if (seen.has(k)) return
    seen.add(k)
    out.push(c)
  }

  us.forEach((u, i) => {
    const list = sentences(u.text)
    list.forEach((sent) => {
      const c = classify(sent, u, ctx)
      if (!c) return
      // A question in chat only matters if nobody answered it.
      push({ ...c, text: clip(sent), evidence: clip(sent) })
    })
    if (!threadLogic) return

    // A proposal that someone else then agrees with is a decision, however it was worded.
    const first = list.find((x) => PROPOSAL.test(x)) ?? null
    if (first) {
      const agree = us.slice(i + 1, i + 5).find((n) => n.who !== u.who && AGREE.test(n.text.trim()))
      if (agree)
        push({
          kind: 'decision',
          text: clip(first.replace(/\?$/, '')),
          owner: null,
          due: null,
          confidence: 0.7,
          evidence: clip(`${u.who}: ${first} / ${agree.who}: ${agree.text}`)
        })
    }
    // A question that got an answer is not open any more.
    const last = list[list.length - 1]
    if (
      last?.endsWith('?') &&
      last.length >= 18 &&
      ctx.source === 'chat' &&
      !classify(last, u, ctx)
    ) {
      const answered = us.slice(i + 1).some((n) => n.who !== u.who)
      if (!answered)
        push({
          kind: 'question',
          text: clip(last),
          owner: null,
          due: null,
          confidence: 0.5,
          evidence: clip(last)
        })
    }
  })
  return out
}

/** The sentences worth showing a model (with one sentence of context around each), capped. */
export function gateForModel(us: Utterance[], ctx: ExtractCtx, maxChars = 6000): string {
  const lines: string[] = []
  for (const u of us) {
    const list = sentences(u.text)
    const keep = new Set<number>()
    list.forEach((s, i) => {
      if (classify(s, u, ctx) || PROPOSAL.test(s) || AGREE.test(s)) {
        keep.add(i - 1)
        keep.add(i)
        keep.add(i + 1)
      }
    })
    const picked = list.filter((_, i) => keep.has(i))
    if (picked.length)
      lines.push(`${u.who || 'Note'}${u.fromMe ? ' (me)' : ''}: ${picked.join(' ')}`)
  }
  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars)
  return text
}
