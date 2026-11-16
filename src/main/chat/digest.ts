import type { Db } from '../db'
import { topicMatcher, triage, type Conversation } from './triage'

const h = (x: number): string => (x < 24 ? `${Math.round(x)}h` : `${Math.round(x / 24)}d`)
const line = (c: Conversation, tail: string): string =>
  `- ${c.title} (${c.spaceType === 'dm' ? 'direct' : c.spaceName}): ${c.lastText.slice(0, 160)} [${tail}]`

/** The state of Chat as plain text: what is waiting on me, what I am waiting on, what I promised. */
export function chatDigestText(db: Db, now = new Date()): string | null {
  const { conversations, commitments } = triage(db, { now, topicHit: topicMatcher(db) })
  const need = conversations.filter((c) => c.bucket === 'needs-you').slice(0, 8)
  const wait = conversations.filter((c) => c.bucket === 'waiting').slice(0, 6)
  const look = conversations.filter((c) => c.bucket === 'fyi').slice(0, 5)
  if (!need.length && !wait.length && !look.length && !commitments.length) return null
  const sec = (t: string, xs: string[]): string => (xs.length ? `${t}\n${xs.join('\n')}` : '')
  return [
    sec(
      'Waiting on me',
      need.map((c) => line(c, `waiting ${h(c.awaitingMeHours || c.ageHours)}`))
    ),
    sec(
      'I am waiting on',
      wait.map((c) => line(c, `asked ${h(c.awaitingThemHours)} ago`))
    ),
    sec(
      'Worth a look',
      look.map((c) => line(c, c.reasons.join(', ')))
    ),
    sec(
      'What I said I would do',
      commitments.slice(-6).map((m) => `- ${m.text.slice(0, 160)} (${m.spaceName})`)
    )
  ]
    .filter(Boolean)
    .join('\n\n')
}
