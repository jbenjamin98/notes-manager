/**
 * Auto-tagging: write the missing `@` and `#` into what you typed.
 *
 *   "Tell Matt he likes cats"  ->  "Tell @Matt he likes #cats"
 *
 * `@` marks any named thing in your lists (people, companies, projects, systems, places; the
 * registry knows which kind it is) and `#` marks a topic. This file is pure: it finds the words to
 * tag in a piece of text and can apply them. The editor, quick capture and the Co-Pilot all use it.
 *
 * It is deliberately conservative. It never touches: words already tagged, code, links, URLs, emails,
 * the `| @owner | due:` fields of a task line, the user's own names, names shared by two people, or
 * everyday words that are also names.
 */
import { GAZETTEER, GAZETTEER_RE } from './gazetteer'

export interface TagVocabEntry {
  name: string
  /** person | customer | project | system | place | topic */
  category: string
  terms: string[]
  /** Match the exact capitalisation (discovered names); false = case-insensitive. */
  exact: boolean
  /** Tagged, but it is not clear who it is (two people share the name): goes to Review People. */
  review?: boolean
}

export interface CompiledTagVocab {
  ci: RegExp | null
  exact: RegExp | null
  /** term (lowercase unless exact) -> entry */
  byTerm: Map<string, TagVocabEntry>
}

export interface TagHit {
  from: number
  to: number
  sigil: '@' | '#'
  /** The canonical name from your lists (the text itself keeps the words as typed). */
  name: string
  category: string
  /** Needs a review (the name is shared by more than one person). */
  review: boolean
}

export interface TagOptions {
  /** Lowercase words never to tag (the user took the tag off before, or turned it off in Settings). */
  ignore?: ReadonlySet<string>
  /** What the user said a name is (lowercase name -> kind), from corrections. Beats every rule. */
  kinds?: Readonly<Record<string, string>>
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BOUND_L = '(?<![\\p{L}\\p{N}_@#])'
const BOUND_R = '(?![\\p{L}\\p{N}_])'

export const emptyTagVocab: CompiledTagVocab = { ci: null, exact: null, byTerm: new Map() }

export function compileTagVocab(entries: TagVocabEntry[]): CompiledTagVocab {
  const byTerm = new Map<string, TagVocabEntry>()
  const ci: string[] = []
  const exact: string[] = []
  for (const e of entries) {
    for (const t of e.terms) {
      const term = t.trim()
      if (term.length < 2) continue
      // A topic is one word (#firewall-rules would change what you typed).
      if (e.category === 'topic' && /\s/.test(term)) continue
      const key = e.exact ? term : term.toLowerCase()
      if (byTerm.has(key)) continue // the first entry (people before topics) wins
      byTerm.set(key, e)
      ;(e.exact ? exact : ci).push(term)
    }
  }
  const build = (terms: string[], flags: string): RegExp | null =>
    terms.length
      ? new RegExp(
          `${BOUND_L}(?:${[...terms]
            .sort((a, b) => b.length - a.length)
            .map(esc)
            .join('|')})${BOUND_R}`,
          flags
        )
      : null
  return { ci: build(ci, 'giu'), exact: build(exact, 'gu'), byTerm }
}

/** Ranges that must never be tagged: code, links, URLs, emails, and a task line's fields. */
export function protectedRanges(text: string): [number, number][] {
  const out: [number, number][] = []
  const add = (re: RegExp): void => {
    for (const m of text.matchAll(re)) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  }
  add(/`[^`\n]*`/g) // inline code
  add(/\[[^\]\n]*\]\([^)\n]*\)/g) // markdown links (text and address)
  add(/\bhttps?:\/\/[^\s)]+/gi) // URLs
  add(/\bwww\.[^\s)]+/gi)
  add(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) // email addresses
  add(/\^[A-Za-z0-9]{4,12}\s*$/g) // a task's id marker
  // Task line: only the description (before the first " | ") can be tagged.
  const task = /^(\s*(?:[-*]|\d+[.)])\s+\[[ xX]\]\s+)/.exec(text)
  const bar = text.search(/\s\|\s/)
  if (task && bar >= 0) out.push([bar, text.length])
  // A fenced-code line.
  if (/^\s*```/.test(text)) out.push([0, text.length])
  return out
}

const overlaps = (a: number, b: number, ranges: [number, number][]): boolean =>
  ranges.some(([x, y]) => a < y && b > x)

/** The words in `text` that should be tagged, longest names first, with no overlaps. */
export function findTags(text: string, v: CompiledTagVocab, opts: TagOptions = {}): TagHit[] {
  if (!v.ci && !v.exact) return []
  const skip = protectedRanges(text)
  const found: TagHit[] = []
  for (const [re, exact] of [
    [v.ci, false],
    [v.exact, true]
  ] as const) {
    if (!re) continue
    for (const m of text.matchAll(re)) {
      const from = m.index ?? 0
      const to = from + m[0].length
      const e = v.byTerm.get(exact ? m[0] : m[0].toLowerCase())
      if (!e) continue
      if (overlaps(from, to, skip)) continue
      if (opts.ignore?.has(m[0].toLowerCase())) continue
      found.push({
        from,
        to,
        sigil: e.category === 'topic' ? '#' : '@',
        name: e.name,
        category: e.category,
        review: !!e.review
      })
    }
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to)
  const out: TagHit[] = []
  let last = -1
  for (const h of found) {
    if (h.from < last) continue // "Sarah" inside "Sarah Chen"
    last = h.to
    out.push(h)
  }
  return out
}

/** Insert the sigils (right to left so positions stay valid). */
export function applyTags(text: string, hits: TagHit[]): string {
  let out = text
  for (const h of [...hits].sort((a, b) => b.from - a.from))
    out = out.slice(0, h.from) + h.sigil + out.slice(h.from)
  return out
}

export function autoTag(
  text: string,
  v: CompiledTagVocab,
  opts: TagOptions = {}
): { text: string; hits: TagHit[] } {
  const hits = findTags(text, v, opts)
  return { text: hits.length ? applyTags(text, hits) : text, hits }
}

// ------------------------------------------------------------------ names nobody has listed yet

/** Words that are never worth a #, however often they appear. */
export const TOPIC_STOP = new Set(
  'the and but for with from this that they them their there here have has had does did not yes okay will can could should would may might must just also very more most some any all each every one two three new old good bad big small day days week weeks month months year years time today tomorrow yesterday work team meeting meetings call calls note notes task tasks item items thing things people person want need like make made get got going out about into over after before again still only than then when what which who how why'.split(
    ' '
  )
)

/** Everyday words that are also first names: never taken for a person without more evidence. */
const NOT_NAMES = new Set(
  (
    'the a an and or but if then this that these those i we you he she it they my our your his her its their ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august ' +
    'september october november december today tomorrow yesterday please thanks thank'
  ).split(' ')
)

// The cue words are a lookbehind, so a cue followed by an ordinary word ("and ask Joe") does not
// swallow the name that comes after it.
const CUE =
  /(?<=\b(?:tell|ask|remind|email|call|ping|message|text|chat with|meet with|meeting with|speak to|speak with|talk to|talk with|follow up with|waiting on|waiting for|cc|thank|thanks to|intro(?:duce)? to|per|with|from|by|for|to)\s+)([\p{L}][\p{L}'’-]{1,24}(?:\s+[\p{L}][\p{L}'’-]{1,24})?)(?![\p{L}])/giu

const isCapitalised = (w: string): boolean => w[0] !== w[0].toLowerCase()

export interface NewName {
  from: number
  to: number
  /** As written ("Matt Rowe"). */
  text: string
  /** What it looks like, from the words around it. A person when nothing says otherwise. */
  kind: Exclude<Suggested['kind'], 'topic'>
  /** A weak guess ("with Acme", "in Review"): offered as a maybe-tag, not written for you. */
  maybe?: boolean
}

const CAP = String.raw`[\p{Lu}][\p{L}\p{N}&'’-]{1,24}`
const CAP2 = `${CAP}(?:\\s+${CAP})?`
const SUFFIX =
  'Inc|Ltd|LLC|Corp|Corporation|Co|Group|Holdings|Bank|Partners|Technologies|Industries|Labs|GmbH|PLC|Limited|Foods|Airlines|Insurance|Pharma|Health|Energy|Capital'
const SYSTEM_NOUN =
  'system|platform|app|portal|database|server|integration|API|tool|environment|instance|tenant|module|cluster|pipeline'

// Names need a real capital letter, so these are not case-insensitive; the cue words are, via W().
const re = (s: string): RegExp => new RegExp(s, 'gu')
/** A "a|b c" list of words as a regex alternation that ignores case ("b c" allows any spacing). */
const W = (list: string): string =>
  list
    .split('|')
    .map((w) =>
      w.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).replace(/ /g, '\\s+')
    )
    .join('|')

/**
 * Other kinds of names, found without a model from the words around them. Earlier entries win when
 * two overlap ("with Acme Inc" is a company, not a person called "Acme Inc").
 */
const KIND_RULES: { kind: NewName['kind']; re: RegExp; mid?: boolean; weak?: boolean }[] = [
  // Companies: a name ending like one, or labelled as a customer.
  { kind: 'customer', re: re(`\\b(${CAP}(?:\\s+${CAP}){0,2}\\s+(?:${SUFFIX})\\b\\.?)`) },
  {
    kind: 'customer',
    re: re(
      `(?<=\\b(?:${W('customer|client|account|vendor|supplier|partner|prospect')})\\s+)(${CAP2})(?![\\p{L}])`
    )
  },
  {
    kind: 'customer',
    re: re(`\\b(${CAP})(?=\\s+(?:${W('account|contract|renewal|deal|escalation|SOW|QBR')})\\b)`),
    mid: true
  },
  // Systems: CamelCase products, "using X", "X platform".
  { kind: 'system', re: re(`\\b(\\p{Lu}\\p{Ll}+(?:\\p{Lu}\\p{Ll}[\\p{Ll}\\p{N}]*)+)\\b`) },
  {
    kind: 'system',
    re: re(
      `(?<=\\b(?:${W('using|via|migrate to|migrating to|migrated to|deploy to|deployed to|deploying to|integrate with|integrating with|integration with|sync with|syncing with|log into|login to|logging into|logged into|hosted on|running on|set up in|configured in')})\\s+)(${CAP})(?![\\p{L}])`
    )
  },
  {
    kind: 'system',
    re: re(`\\b(${CAP}|[\\p{Lu}]{2,6})(?=\\s+(?:${W(SYSTEM_NOUN)})\\b)`),
    mid: true
  },
  // Projects
  {
    kind: 'project',
    re: re(
      `(?<=\\b(?:${W('project|initiative|program|programme|workstream|epic')})\\s+)(${CAP2})(?![\\p{L}])`
    )
  },
  {
    kind: 'project',
    re: re(
      `\\b(${CAP})(?=\\s+(?:${W('project|initiative|program|workstream|rollout|migration|launch|release|cutover|go-live')})\\b)`
    ),
    mid: true
  },
  // Places
  {
    kind: 'place',
    weak: true,
    re: re(
      `(?<=\\b(?:${W('in|near|visit|visiting|visited|trip to|travel to|travelling to|traveling to|fly to|flying to|flight to|based in|office in|site in|onsite in')})\\s+)(${CAP2})(?![\\p{L}])`
    )
  }
]

/** Capitalised words that are not names where they follow "in" or end a sentence start. */
const NOT_NAMES_AFTER_CUE = new Set(
  (
    'review progress general particular fact case order total practice addition summary short advance place time person ' +
    'next last new this that the all any each every some one two three four five'
  ).split(' ')
)

/** True when the word at `index` begins a sentence (so its capital letter says nothing). */
function startsSentence(text: string, index: number): boolean {
  const head = text.slice(0, index)
  if (/(^|\n)\s*(?:[-*]\s+(?:\[.\]\s+)?)?$/.test(head)) return true
  return /[.!?:]\s*$/.test(head)
}

const PERSON_PREFIX = /^(?:Mc|Mac|De|Di|La|Le|Van|Von|O')/

/**
 * A capitalised name right after a verb that takes a person ("Tell Matt", "waiting on Priya Nair")
 * that is not in the vocabulary yet. These are tagged and added to People. Used without AI, and as
 * the cheap first pass before it.
 */
export function findNewNames(
  text: string,
  known: CompiledTagVocab,
  me: ReadonlySet<string>,
  opts: TagOptions = {}
): NewName[] {
  const skip = protectedRanges(text)
  const out: NewName[] = []
  const taken = (from: number, to: number): boolean => out.some((o) => from < o.to && to > o.from)
  const isKnown = (name: string): boolean => {
    const first = name.split(/\s+/)[0]
    return (
      known.byTerm.has(name) ||
      known.byTerm.has(name.toLowerCase()) ||
      known.byTerm.has(first) ||
      known.byTerm.has(first.toLowerCase())
    )
  }
  // Well-known places and software need no cue words around them.
  for (const m of text.matchAll(GAZETTEER_RE)) {
    const name = m[0]
    const from = m.index ?? 0
    const lower = name.toLowerCase()
    if (me.has(lower) || isKnown(name) || opts.ignore?.has(lower)) continue
    if (overlaps(from, from + name.length, skip) || taken(from, from + name.length)) continue
    out.push({ from, to: from + name.length, text: name, kind: GAZETTEER.get(name) ?? 'system' })
  }
  for (const rule of KIND_RULES) {
    for (const m of text.matchAll(rule.re)) {
      const name = (m[1] ?? m[0]).replace(/\.$/, '')
      const from = (m.index ?? 0) + m[0].indexOf(m[1] ?? m[0])
      const to = from + name.length
      const lower = name.toLowerCase()
      const first = lower.split(/\s+/)[0]
      if (name.length < 2 || NOT_NAMES.has(first) || NOT_NAMES_AFTER_CUE.has(first)) continue
      if (me.has(lower) || me.has(first) || isKnown(name) || opts.ignore?.has(lower)) continue
      if (rule.kind === 'system' && PERSON_PREFIX.test(name)) continue
      // A capital letter at the start of a sentence says nothing, so "Next release" is no project.
      if (rule.mid && startsSentence(text, from)) continue
      if (overlaps(from, to, skip) || taken(from, to)) continue
      out.push({ from, to, text: name, kind: rule.kind, ...(rule.weak ? { maybe: true } : {}) })
    }
  }
  for (const m of text.matchAll(CUE)) {
    const from = (m.index ?? 0) + m[0].length - m[1].length
    // Keep the leading capitalised words that are not ordinary words ("Tell Matt He likes" -> "Matt").
    const words: string[] = []
    for (const w of m[1].split(/\s+/)) {
      if (!isCapitalised(w) || (words.length > 0 && NOT_NAMES.has(w.toLowerCase()))) break
      words.push(w)
    }
    const name = words.join(' ')
    const first = words[0]?.toLowerCase() ?? ''
    if (!name || NOT_NAMES.has(first) || me.has(first) || me.has(name.toLowerCase())) continue
    if (known.byTerm.has(name) || known.byTerm.has(name.toLowerCase())) continue
    if (known.byTerm.has(first) || known.byTerm.has(words[0])) continue
    if (opts.ignore?.has(first)) continue
    if (overlaps(from, from + name.length, skip) || taken(from, from + name.length)) continue
    // After "tell / ask / email" it is surely a person; after "with / from / by / for / to" it could be anything.
    const weak = /\b(?:with|from|by|for|to|per)\s+$/i.test(text.slice(0, from))
    out.push({
      from,
      to: from + name.length,
      text: name,
      kind: 'person',
      ...(weak ? { maybe: true } : {})
    })
  }
  // What you corrected before beats every rule.
  for (const o of out) {
    const k = opts.kinds?.[o.text.toLowerCase()]
    if (k && ['person', 'customer', 'project', 'system', 'place'].includes(k))
      o.kind = k as NewName['kind']
  }
  return out.sort((a, b) => a.from - b.from)
}

/** Words that are plausible topic candidates for the AI step (not already tagged, not tiny). */
export function untaggedWordCount(text: string): number {
  return (text.match(/(?<![@#\w])[\p{L}][\p{L}\p{N}'-]{2,}/gu) ?? []).length
}

/**
 * Is a model call worth it for this line? Only when the rules left something unresolved: a
 * capitalised word in the middle of a sentence that is not a known name and was not already found,
 * or a sentence with an uncommon word that could be a new topic. Short or fully
 * understood lines never cost a call.
 */
export function needsModel(
  text: string,
  known: CompiledTagVocab,
  found: readonly string[]
): boolean {
  const skip = protectedRanges(text)
  const have = new Set(found.map((f) => f.toLowerCase()))
  let capitalised = 0
  for (const m of text.matchAll(/(?<![@#\p{L}\p{N}_])\p{Lu}[\p{L}'’-]{2,}/gu)) {
    const from = m.index ?? 0
    const w = m[0]
    const lower = w.toLowerCase()
    if (overlaps(from, from + w.length, skip)) continue
    if (/(^|[.!?:]\s+|\n\s*(?:[-*]\s+(?:\[.\]\s+)?)?)$/.test(text.slice(0, from))) continue // sentence start
    if (NOT_NAMES.has(lower) || TOPIC_STOP.has(lower) || have.has(lower)) continue
    if (known.byTerm.has(w) || known.byTerm.has(lower)) continue
    capitalised++
  }
  if (capitalised > 0) return true
  const words = text.match(/(?<![@#\p{L}\p{N}_])\p{L}[\p{L}'’-]*/gu) ?? []
  const uncommon = words.filter((w) => {
    const l = w.toLowerCase()
    return w.length >= 6 && !TOPIC_STOP.has(l) && !known.byTerm.has(l) && !have.has(l)
  })
  return words.length >= 5 && uncommon.length >= 1
}

// --------------------------------------------------------------- tags suggested from outside

export interface Suggested {
  /** The exact words in the line. */
  text: string
  kind: 'topic' | 'person' | 'customer' | 'project' | 'system' | 'place'
  /** A weak guess: shown as a maybe-tag (Tab to accept) instead of being written. */
  maybe?: boolean
}

export interface Placed {
  /** Where the sigil goes, and where the word ends, in the original text. */
  from: number
  to: number
  sigil: '@' | '#'
  tag: Suggested
}

/**
 * Where each suggested tag goes: the first whole-word occurrence of its exact words that is not
 * already tagged or inside code, a link or a task field. One tag per suggestion.
 */
export function placeSuggested(text: string, tags: Suggested[], opts: TagOptions = {}): Placed[] {
  const skip = protectedRanges(text)
  const out: Placed[] = []
  for (const t of tags) {
    const re = new RegExp(`${BOUND_L}${esc(t.text)}${BOUND_R}`, 'gu')
    for (const m of text.matchAll(re)) {
      const from = m.index ?? 0
      const to = from + m[0].length
      if (overlaps(from, to, skip)) continue
      if (opts.ignore?.has(m[0].toLowerCase())) continue
      if (out.some((p) => p.from < to && p.to > from)) continue
      out.push({ from, to, sigil: t.kind === 'topic' ? '#' : '@', tag: t })
      break
    }
  }
  return out
}

/** Write the tags a model (or the verb-cue finder) suggested into the text. */
export function applySuggested(
  text: string,
  tags: Suggested[],
  opts: TagOptions = {}
): { text: string; applied: Suggested[] } {
  const placed = placeSuggested(text, tags, opts)
  let out = text
  for (const p of [...placed].sort((x, y) => y.from - x.from))
    out = out.slice(0, p.from) + p.sigil + out.slice(p.from)
  return { text: out, applied: placed.map((p) => p.tag) }
}

/** Tag a whole note: line by line, leaving frontmatter and fenced code alone. */
export function autoTagDocument(
  content: string,
  v: CompiledTagVocab,
  opts: TagOptions = {}
): { text: string; count: number } {
  const lines = content.split('\n')
  let i = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---')
    if (end > 0) i = end + 1
  }
  let fenced = false
  let count = 0
  for (; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const r = autoTag(lines[i], v, opts)
    if (r.hits.length) {
      lines[i] = r.text
      count += r.hits.length
    }
  }
  return { text: lines.join('\n'), count }
}
