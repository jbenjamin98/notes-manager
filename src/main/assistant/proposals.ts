import * as chrono from 'chrono-node'
import { z } from 'zod'
import { formatTaskLine } from '../../shared/quickadd'
import type { PersonIndex } from '../entities/infer'
import type { Proposal } from '../../shared/contract'

/**
 * The model proposes; we decide. Everything it returns is validated, dates are re-derived locally
 * with chrono (the model only quotes the phrase), names are mapped to people we know, and nothing is
 * written until the user presses Apply on a card.
 */

// ------------------------------------------------------------- what the model may return (loose)

const LlmTask = z.object({
  description: z.string().min(1),
  owner: z.string().nullish(),
  due_phrase: z.string().nullish(),
  due: z.string().nullish(),
  priority: z.string().nullish(),
  est_minutes: z.number().nullish()
})

export const CaptureOut = z.object({
  reply: z.string().default(''),
  tasks: z.array(LlmTask).default([]),
  notes: z
    .array(
      z.object({
        title: z.string().min(1),
        kind: z.string().nullish(),
        date: z.string().nullish(),
        account: z.string().nullish(),
        summary: z.string().nullish(),
        decisions: z.array(z.string()).default([]),
        open_questions: z.array(z.string()).default([]),
        action_items: z.array(LlmTask).default([])
      })
    )
    .default([]),
  reminders: z
    .array(
      z.object({
        text: z.string().min(1),
        at_phrase: z.string().nullish(),
        at: z.string().nullish()
      })
    )
    .default([])
})
export type CaptureOut = z.infer<typeof CaptureOut>

export const AskOut = z.object({
  answer: z.string(),
  /** Snippet numbers the answer relies on. */
  cited: z.array(z.number()).default([]),
  /** Short questions the user might ask next (only requested in Heavy mode). */
  followups: z.array(z.string()).default([])
})
export type AskOut = z.infer<typeof AskOut>

// ------------------------------------------------------------------------------- resolution

export interface ResolveCtx {
  now: Date
  people: PersonIndex
  meNames: Set<string>
  knownAccounts: string[]
}

const p2 = (n: number): string => String(n).padStart(2, '0')
export const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
export const isoMinute = (d: Date): string =>
  `${isoDay(d)}T${p2(d.getHours())}:${p2(d.getMinutes())}`

/** A calendar day named in a phrase ("next Thursday", "tomorrow", "Nov 20"). Bare numbers don't count. */
export function dayFromPhrase(phrase: string, now: Date): string | null {
  const hit = chrono
    .parse(phrase, now, { forwardDate: true })
    .find(
      (r) => r.start.isCertain('day') || r.start.isCertain('weekday') || r.start.isCertain('month')
    )
  return hit ? isoDay(hit.start.date()) : null
}

const normPriority = (s: string | null | undefined): 'High' | 'Medium' | 'Low' | null => {
  const v = (s ?? '').trim().toLowerCase()
  return v === 'high' || v === 'urgent'
    ? 'High'
    : v === 'medium' || v === 'med'
      ? 'Medium'
      : v === 'low'
        ? 'Low'
        : null
}

const clean = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()

type TaskP = Extract<Proposal, { kind: 'task' }>

export function resolveTask(t: z.infer<typeof LlmTask>, ctx: ResolveCtx): TaskP {
  const rawOwner = (t.owner ?? '').trim().replace(/^@/, '')
  const isMe = !rawOwner || ctx.meNames.has(rawOwner.toLowerCase())
  const owner = isMe ? 'Me' : (ctx.people.lookup.get(rawOwner.toLowerCase()) ?? rawOwner)

  // The model quotes the phrase; WE compute the date. If it also gave a date and they disagree, say so.
  const fromPhrase = t.due_phrase ? dayFromPhrase(t.due_phrase, ctx.now) : null
  const fromModel = t.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : null
  const due = fromPhrase ?? fromModel
  let dueNote: string | null = null
  if (fromPhrase && fromModel && fromPhrase !== fromModel) {
    dueNote = `You said "${t.due_phrase}", which is ${fromPhrase}. The AI guessed ${fromModel}; ${fromPhrase} is used.`
  } else if (!fromPhrase && t.due_phrase && !fromModel) {
    dueNote = `Could not turn "${t.due_phrase}" into a date. Pick one if you want a due date.`
  }
  return {
    kind: 'task',
    description: clean(t.description).slice(0, 200),
    owner,
    ownerExplicit: !isMe || !!rawOwner,
    due,
    dueNote,
    priority: normPriority(t.priority),
    estMinutes:
      t.est_minutes && t.est_minutes > 0 && t.est_minutes <= 480 ? Math.round(t.est_minutes) : null,
    status: 'pending',
    appliedPath: null
  }
}

type NoteP = Extract<Proposal, { kind: 'note' }>

export function composeNoteBody(n: CaptureOut['notes'][number], ctx: ResolveCtx): string {
  const parts: string[] = []
  const bullets = (xs: string[]): string => xs.map((x) => `- ${clean(x)}`).join('\n')
  if (n.summary?.trim()) parts.push(`## Context & Objective\n${n.summary.trim()}`)
  if (n.decisions.length) parts.push(`## Key Decisions & Insights\n${bullets(n.decisions)}`)
  if (n.open_questions.length)
    parts.push(`## Open Questions / Parking Lot\n${bullets(n.open_questions)}`)
  if (n.action_items.length) {
    const lines = n.action_items.map((a) => {
      const t = resolveTask(a, ctx)
      return formatTaskLine({
        description: t.description,
        owner: t.owner,
        due: t.due,
        priority: t.priority,
        estMinutes: t.estMinutes,
        ownerExplicit: t.ownerExplicit
      })
    })
    parts.push(`## Action Items\n${lines.join('\n')}`)
  }
  return parts.join('\n\n')
}

export function resolveNote(n: CaptureOut['notes'][number], ctx: ResolveCtx): NoteP {
  const date = n.date && /^\d{4}-\d{2}-\d{2}$/.test(n.date) ? n.date : isoDay(ctx.now)
  const acct = n.account?.trim()
  const known = acct
    ? ctx.knownAccounts.find((a) => a.toLowerCase() === acct.toLowerCase())
    : undefined
  return {
    kind: 'note',
    title: clean(n.title).slice(0, 120),
    noteKind: (n.kind ?? '').toLowerCase() === 'meeting' ? 'meeting' : 'adhoc',
    date,
    account: known ?? (acct || null),
    body: composeNoteBody(n, ctx),
    status: 'pending',
    appliedPath: null
  }
}

type ReminderP = Extract<Proposal, { kind: 'reminder' }>

export function resolveReminder(r: CaptureOut['reminders'][number], ctx: ResolveCtx): ReminderP {
  let when: Date | null = null
  let note: string | null = null
  const phrase = r.at_phrase || r.text
  const hit = chrono
    .parse(phrase, ctx.now, { forwardDate: true })
    .find(
      (x) => x.start.isCertain('day') || x.start.isCertain('weekday') || x.start.isCertain('hour')
    )
  if (hit) {
    when = hit.start.date()
    // "remind me Friday" has no time: default to 9 AM rather than midnight.
    if (!hit.start.isCertain('hour')) when.setHours(9, 0, 0, 0)
  } else if (r.at && !Number.isNaN(new Date(r.at).getTime())) {
    when = new Date(r.at)
  }
  if (when && when.getTime() <= ctx.now.getTime()) {
    note = 'That time has already passed. Pick a later time.'
    when = null
  } else if (!when) {
    note = `Could not work out when "${phrase}" is. Pick a time.`
  }
  return {
    kind: 'reminder',
    text: clean(r.text).slice(0, 200),
    at: when ? isoMinute(when) : null,
    atNote: note,
    status: 'pending'
  }
}

/** Caps keep one rambling message from producing a wall of cards. */
export function resolveCapture(out: CaptureOut, ctx: ResolveCtx): Proposal[] {
  return [
    ...out.notes.slice(0, 3).map((n) => resolveNote(n, ctx)),
    ...out.tasks.slice(0, 8).map((t) => resolveTask(t, ctx)),
    ...out.reminders.slice(0, 5).map((r) => resolveReminder(r, ctx))
  ]
}

/** Fields the user may change on a card before applying. Everything else is ignored. */
export function mergeEdits(
  p: Proposal,
  edits: Record<string, unknown> | undefined,
  ctx: ResolveCtx
): Proposal {
  if (!edits) return p
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  if (p.kind === 'task') {
    const owner = str(edits.owner)?.trim().replace(/^@/, '')
    const due = edits.due === null ? null : str(edits.due)
    const prio = edits.priority === null ? null : normPriority(str(edits.priority))
    return {
      ...p,
      description: str(edits.description)
        ? clean(str(edits.description)!).slice(0, 200)
        : p.description,
      ...(owner !== undefined
        ? {
            owner:
              !owner || ctx.meNames.has(owner.toLowerCase())
                ? 'Me'
                : (ctx.people.lookup.get(owner.toLowerCase()) ?? owner),
            ownerExplicit: true
          }
        : {}),
      ...(due !== undefined
        ? { due: due === null || /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : p.due, dueNote: null }
        : {}),
      ...(edits.priority !== undefined ? { priority: prio } : {})
    }
  }
  if (p.kind === 'note') {
    return { ...p, title: str(edits.title) ? clean(str(edits.title)!).slice(0, 120) : p.title }
  }
  if (p.kind === 'email') {
    const to = str(edits.to)?.trim()
    return {
      ...p,
      subject: str(edits.subject) ? clean(str(edits.subject)!).slice(0, 200) : p.subject,
      body: typeof edits.body === 'string' ? edits.body.slice(0, 4000) : p.body,
      ...(to !== undefined ? { to: to || null } : {})
    }
  }
  const at = str(edits.at)
  return {
    ...p,
    text: str(edits.text) ? clean(str(edits.text)!).slice(0, 200) : p.text,
    ...(at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) ? { at, atNote: null } : {})
  }
}

// -------------------------------------------------------------------------------- prompts

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function captureSystemPrompt(ctx: ResolveCtx, tz: string): string {
  const people = [...new Set(ctx.people.lookup.values())].slice(0, 40)
  return [
    'You turn a messy brain-dump from a busy delivery manager into structured items. Reply with ONLY a JSON object.',
    `Today is ${WEEKDAYS[ctx.now.getDay()]} ${isoDay(ctx.now)}. Timezone: ${tz}.`,
    people.length
      ? `People the user already works with: ${people.join(', ')}. Use these exact spellings when the text refers to them.`
      : '',
    ctx.knownAccounts.length
      ? `Known accounts/projects: ${ctx.knownAccounts.slice(0, 20).join(', ')}.`
      : '',
    'JSON shape:',
    '{"reply": short friendly sentence summarising what you found,',
    ' "tasks": [{"description": imperative, no names or dates in it, "owner": person who must DO it or null for the user, "due_phrase": the exact words about timing e.g. "next Thursday" or null, "priority": "High"|"Medium"|"Low"|null, "est_minutes": number|null}],',
    ' "notes": [{"title", "kind": "meeting"|"adhoc", "date": "YYYY-MM-DD"|null, "account": string|null, "summary": string, "decisions": [string], "open_questions": [string], "action_items": [same shape as tasks]}],',
    ' "reminders": [{"text", "at_phrase": exact words like "tomorrow 3pm" or null}]}',
    'Rules: never invent people, dates or facts; quote timing words exactly in due_phrase/at_phrase (do not compute dates).',
    'Create a note only when the text describes a meeting or conversation worth keeping. If you create a note, put its action items inside that note and do NOT repeat them in "tasks".',
    'Use an empty array for anything not present. "owner" is the person responsible, not the person mentioned in passing.'
  ]
    .filter(Boolean)
    .join('\n')
}

/** How long an answer should be, by AI mode. */
export const ANSWER_LENGTH: Record<string, string> = {
  light: '2 to 4 sentences',
  normal: 'about 80 to 180 words; use short bullets for lists of 3 or more things',
  heavy:
    'as long as the question deserves, up to about 350 words, with bullets and short headings when it helps'
}

export const askSystemPrompt = (followups: boolean, mode = 'normal'): string =>
  [
    'You are the user\'s work assistant. You know their meeting notes, their own open tasks, their calendar, what other people owe them ("Waiting on"), and insights pulled from their meetings, email and chat. These arrive as numbered sources.',
    `Reply with ONLY a JSON object: {"answer": string, "cited": [numbers]${followups ? ', "followups": [up to 3 short questions the user might ask next]' : ''}}.`,
    'How to answer:',
    '- Lead with the direct answer in the first sentence. No preamble, no restating the question.',
    '- Then give the details that make it useful: who, what, when, the current status, and what is still open. Connect related sources (a decision in one meeting and the task it created in another).',
    '- Cite sources inline like [2] right after the fact they support, and list every number you used in "cited".',
    '- If the sources only partly answer, say what you found and name the gap plainly ("I can see X, but nothing about Y yet").',
    '- When something needs doing, end with one concrete suggested next step.',
    '- Use ONLY the sources. Never invent names, dates or numbers. Write dates like "Mon Nov 17", not ISO.',
    '- If nothing in the sources is relevant, say so in one sentence and suggest a better question or where it might be.',
    `Length: ${ANSWER_LENGTH[mode] ?? ANSWER_LENGTH.normal}.`
  ].join('\n')

export const ASK_SYSTEM_PROMPT = askSystemPrompt(false)
