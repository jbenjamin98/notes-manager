import type { Db } from '../../db'
import { listUpcoming, localDate } from '../../calendar/sync'
import { triage, topicMatcher, type Conversation } from '../../chat/triage'

/**
 * Questions that are lookups, not language problems. Answered from the local index, in plain
 * sentences, with no AI and no tokens. Returns null when the question needs a model.
 */
export interface LocalAnswer {
  text: string
  /** What the answer was computed from, for the quiet "Answered on your computer" tag. */
  basis: string
}

const hrs = (h: number): string => (h < 24 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`)

function lines(list: Conversation[], extra: (c: Conversation) => string): string {
  return list
    .slice(0, 6)
    .map((c) => `- ${c.title}: ${c.lastText.slice(0, 100)} (${extra(c)})`)
    .join('\n')
}

export function localRoute(db: Db, question: string, now = new Date()): LocalAnswer | null {
  const q = question
    .trim()
    .toLowerCase()
    .replace(/[?!.]+$/, '')

  const chatWords = /\b(chat|chats|dm|dms|messages?|google chat)\b/.test(q)
  if (
    chatWords &&
    /\b(waiting on me|need(s)? (me|a reply|my)|unanswered|owe|haven'?t (replied|answered)|should i (reply|answer)|reply to|respond to)\b/.test(
      q
    )
  ) {
    const t = triage(db, { now, topicHit: topicMatcher(db) }).conversations.filter(
      (c) => c.bucket === 'needs-you'
    )
    return {
      text: t.length
        ? `${t.length} chat conversation${t.length === 1 ? ' is' : 's are'} waiting on you:\n${lines(t, (c) => `waiting ${hrs(c.awaitingMeHours || c.ageHours)}`)}`
        : 'Nothing in Chat is waiting on you right now.',
      basis: 'chat'
    }
  }
  if (
    chatWords &&
    /\b(waiting on|haven'?t heard|no (answer|reply)|owe me|not replied|never replied)\b/.test(q)
  ) {
    const t = triage(db, { now, topicHit: topicMatcher(db) }).conversations.filter(
      (c) => c.bucket === 'waiting'
    )
    return {
      text: t.length
        ? `You are waiting on ${t.length} chat repl${t.length === 1 ? 'y' : 'ies'}:\n${lines(t, (c) => `asked ${hrs(c.awaitingThemHours)} ago`)}`
        : 'You are not waiting on anyone in Chat.',
      basis: 'chat'
    }
  }
  if (
    /\b(what|which)\b.*\b(did i (promise|commit|say i'?d)|i said i'?d|my commitments)\b/.test(q)
  ) {
    const { commitments } = triage(db, { now })
    return {
      text: commitments.length
        ? `Things you said you would do in Chat:\n${commitments
            .slice(-6)
            .map((c) => `- ${c.text.slice(0, 120)} (${c.spaceName})`)
            .join('\n')}`
        : 'I did not find any promises you made in recent Chat messages.',
      basis: 'chat'
    }
  }
  if (/\b(next|upcoming)\b.*\b(meeting|call|event)\b|\bwhen('?s| is) my next\b/.test(q)) {
    const today = localDate(now)
    const nowHm = now.toTimeString().slice(0, 5)
    const next = listUpcoming(db, today).find(
      (e) => e.date > today || (e.startTime !== null && e.startTime >= nowHm)
    )
    return {
      text: next
        ? `Your next meeting is "${next.title}" ${next.date === today ? 'today' : 'on ' + next.date}${next.startTime ? ' at ' + next.startTime : ''}.`
        : 'You have no upcoming meetings on your calendar.',
      basis: 'calendar'
    }
  }
  return null
}
