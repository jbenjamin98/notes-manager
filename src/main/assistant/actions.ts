import { z } from 'zod'
import type { Proposal } from '../../shared/contract'

/**
 * One-click AI actions on things the user is already looking at. Each action has a plain
 * instruction, a strict output shape, and a function that turns the model's answer into text plus
 * (where useful) cards the user can approve. Nothing here writes or sends anything by itself.
 */
export type ActionKind =
  | 'summarize-note'
  | 'extract-actions'
  | 'draft-followup'
  | 'prep-brief'
  | 'week-update'
  | 'day-brief'
  | 'catch-up'
  | 'chat-digest'

export const ACTION_KINDS: ActionKind[] = [
  'summarize-note',
  'extract-actions',
  'draft-followup',
  'prep-brief',
  'week-update',
  'day-brief',
  'catch-up',
  'chat-digest'
]

const list = z.array(z.string()).default([])

export const SummaryOut = z.object({
  tldr: z.string(),
  /** Why it matters / what it changes, in the assistant's own view. */
  significance: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  decisions: list,
  open_questions: list,
  next_steps: list
})
export const BriefOut = z.object({
  headline: z.string(),
  /** The assistant's overall read in a few sentences. */
  take: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  bullets: list,
  watch_outs: list
})
export const WeekOut = z.object({
  summary: z.string(),
  wins: list,
  risks: list,
  next_week: list
})
export const DayOut = z.object({
  headline: z.string(),
  /** How the day fits together: what is at stake and why the order matters. */
  narrative: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  priorities: list,
  heads_up: list
})
export const CatchUpOut = z.object({ summary: z.string(), timeline: list, open_items: list })
export const EmailOut = z.object({
  recipient_name: z.string().nullish(),
  subject: z.string(),
  body: z.string()
})

const COMMON =
  'Reply with ONLY a JSON object. Use only the information provided; never invent people, dates, numbers or decisions. ' +
  'Write like a sharp colleague who has read everything: specific names, dates and reasons, and a clear point of view about what matters and what you would do, not a neutral list. ' +
  'Connect related facts. Name what is missing rather than guessing. Plain text with at most **bold** and "- " bullets; no headings or tables.'

export const SYSTEM: Record<ActionKind, string> = {
  'summarize-note': `${COMMON} Summarise the meeting note: what happened, then why it matters. Shape: {"tldr": two or three sentences on what was settled and what is still open, "significance": one or two sentences on what this changes or puts at risk, "decisions": [string], "open_questions": [string], "next_steps": [string]}. Leave a list empty if the note has none.`,
  'extract-actions': `${COMMON} Find every action item in the note: things someone has to do. Shape: {"tasks": [{"description": imperative, no names or dates in it, "owner": the person who must do it or null for the note's author, "due_phrase": the exact words about timing or null, "priority": "High"|"Medium"|"Low"|null}]}. Do not repeat tasks that are already written as checkbox lines.`,
  'draft-followup': `${COMMON} Write a short, friendly follow-up email to attendees after this meeting. Shape: {"recipient_name": the one person it is mainly for or null, "subject": string, "body": string with a greeting, the decisions, who owes what by when, and a sign-off with no name}.`,
  'prep-brief': `${COMMON} Brief a delivery manager who is about to join this meeting, using the history given. Shape: {"headline": one sentence on what matters most, "take": two or three sentences: where things stand with these people and what you would push for in the room, "bullets": [up to 6 facts: last time's outcomes, open items, who owes what, with names and dates], "watch_outs": [up to 3 risks or questions to raise, each with why]}.`,
  'week-update': `${COMMON} Write a status update for a manager from the week's facts. Shape: {"summary": 2 to 4 sentences, "wins": [string], "risks": [string], "next_week": [string]}. Keep every number exactly as given.`,
  'day-brief': `${COMMON} Plan the day from the tasks, meetings, replies owed, what other people owe, and insights given. Give a real recommendation. Shape: {"headline": your honest read of the day in one or two sentences, "narrative": a short paragraph on how the day fits together: what is at stake, which meeting or task drives the rest, and why the order matters, "priorities": [up to 6 things to do first, in order, each starting with the thing itself and ending with the reason], "heads_up": [up to 4 clashes, overdue items or things at risk, naming who is affected]}.`,
  'chat-digest': `${COMMON} Brief a delivery manager on their Google Chat from the lists given (what is waiting on them, what they are waiting on, what they promised). Shape: {"headline": one sentence on what matters most, "take": two or three sentences on the overall picture and who you would answer first, "bullets": [up to 6 items to deal with, most urgent first, each naming the person and what they need], "watch_outs": [up to 3 things at risk of being dropped, with why]}.`,
  'catch-up': `${COMMON} Catch the reader up on this person, account or topic from the notes, mail and chat given: who they are in this work, how things have gone, and where it stands now. Shape: {"summary": 3 to 5 sentences with a point of view (what is going well, what is stuck, what you would do next), "timeline": [up to 8 dated points, oldest first, like "Nov 6: cutover plan reviewed"], "open_items": [what is still unresolved, with owners]}.`
}

export const LABEL: Record<ActionKind, (title: string) => string> = {
  'summarize-note': (t) => `Summarize “${t}”`,
  'extract-actions': (t) => `Find action items in “${t}”`,
  'draft-followup': (t) => `Draft a follow-up email for “${t}”`,
  'prep-brief': (t) => `Brief me for “${t}”`,
  'week-update': (t) => `Draft my update for ${t}`,
  'day-brief': () => 'What is on my plate today?',
  'catch-up': (t) => `Catch me up on ${t}`,
  'chat-digest': () => 'What needs me in Chat?'
}

const bullets = (xs: string[]): string => xs.map((x) => `• ${x}`).join('\n')
const section = (title: string, xs: string[]): string =>
  xs.length ? `${title}\n${bullets(xs)}` : ''
const join = (...parts: string[]): string => parts.filter(Boolean).join('\n\n')

export const render = {
  summary: (o: z.infer<typeof SummaryOut>): string =>
    join(
      o.tldr,
      o.significance,
      section('Decisions', o.decisions),
      section('Open questions', o.open_questions),
      section('Next steps', o.next_steps)
    ),
  brief: (o: z.infer<typeof BriefOut>): string =>
    join(o.headline, o.take, bullets(o.bullets), section('Watch out for', o.watch_outs)),
  week: (o: z.infer<typeof WeekOut>): string =>
    join(
      o.summary,
      section('Wins', o.wins),
      section('Risks', o.risks),
      section('Next week', o.next_week)
    ),
  day: (o: z.infer<typeof DayOut>): string =>
    join(
      o.headline,
      o.narrative,
      section(
        'Start with',
        o.priorities.map((p, i) => `${i + 1}. ${p}`)
      ).replace(/• /g, ''),
      section('Heads up', o.heads_up)
    ),
  catchUp: (o: z.infer<typeof CatchUpOut>): string =>
    join(o.summary, section('Timeline', o.timeline), section('Still open', o.open_items))
}

type EmailP = Extract<Proposal, { kind: 'email' }>

export function emailProposal(to: string | null, subject: string, body: string): EmailP {
  return {
    kind: 'email',
    to,
    subject: subject.replace(/\s+/g, ' ').trim().slice(0, 200),
    body: body.trim().slice(0, 4000),
    status: 'pending'
  }
}

/** A plain email body from a week's facts, for the "Draft my update" action. */
export function weekEmailBody(o: z.infer<typeof WeekOut>): string {
  const block = (t: string, xs: string[]): string => (xs.length ? `${t}:\n${bullets(xs)}\n\n` : '')
  return `Hi all,\n\n${o.summary}\n\n${block('Wins', o.wins)}${block('Risks', o.risks)}${block('Next week', o.next_week)}Thanks,`
}
