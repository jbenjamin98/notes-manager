/**
 * What the app keeps from meetings, email and chat: not the messages, but the important things in
 * them, each with a reference back to where it came from.
 */
export type InsightKind =
  | 'action' // someone has to do something
  | 'ask' // someone asked ME to do something
  | 'promise' // I said I would do something
  | 'decision' // something was decided or approved
  | 'question' // an open question
  | 'risk' // a risk, blocker, issue or dependency
  | 'change' // a date, scope or plan moved
  | 'fact' // who is who: a role or relationship

export const KINDS: InsightKind[] = [
  'action',
  'ask',
  'promise',
  'decision',
  'question',
  'risk',
  'change',
  'fact'
]

export interface Candidate {
  kind: InsightKind
  text: string
  owner: string | null
  /** ISO date (YYYY-MM-DD) when the text names one. */
  due: string | null
  confidence: number
  /** The sentence it came from (short). */
  evidence: string
}

export type SourceType = 'meeting' | 'email' | 'chat' | 'note'

/** Enough to reopen the origin later, and to label it for people. */
export interface SourceInfo {
  type: SourceType
  /** Ids to reopen the origin: { eventId, notePath, threadId, space, fileId, ... }. */
  ref: Record<string, string | null>
  /** "Chat · Priya · Nov 14" */
  label: string
  /** ISO time of the source. */
  at: string
}

/** One person's message (chat) or one block of text (a meeting note, an email body). */
export interface Utterance {
  who: string
  text: string
  fromMe: boolean
}

export interface ExtractCtx {
  now: Date
  /** My own names ("Me", "Jacob"...). */
  me: string[]
  /** Kind of source: only some kinds make sense for some sources. */
  source: SourceType
}
