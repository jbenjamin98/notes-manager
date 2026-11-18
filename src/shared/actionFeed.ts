import type { ChatConversation, GmailOverview, InsightItem, ThreadItem } from './contract'

/**
 * The Action Center's single list: email, chat and what-matters items in one shape, so they share
 * one card and one set of actions. Pure: built from what the main process already returns.
 */
export type ActionBucket = 'needs-you' | 'waiting' | 'hidden'
export type ActionLevel = 'important' | 'maybe' | 'noise'

export type ActionItem = {
  /** Unique across kinds. */
  key: string
  id: string
  bucket: ActionBucket
  title: string
  snippet: string
  /** Who it is from (or, for a waiting item, who it is waiting on). */
  from: string | null
  /** ISO-ish time of the last activity. */
  when: string | null
  unread: boolean
  level: ActionLevel
  score: number
  /** Short "why this is here" chips. */
  reasons: string[]
} & (
  | { kind: 'email'; thread: ThreadItem }
  | { kind: 'chat'; conversation: ChatConversation }
  | { kind: 'insight'; insight: InsightItem }
)

export interface Feed {
  items: ActionItem[]
  counts: Record<ActionBucket, number>
}

const CHAT_WHY: Record<string, string> = {
  dm: 'Direct message',
  mention: 'Mentioned you',
  'reply-to-me': 'Replied to you',
  question: 'Asks something',
  deadline: 'Has a deadline',
  topic: 'About your work',
  frequent: 'Someone you talk to',
  recent: 'Recent',
  unanswered: 'Unanswered'
}

const KIND_WHY: Record<InsightItem['kind'], string> = {
  action: 'Action',
  ask: 'Asked of you',
  promise: 'You promised',
  decision: 'Decision',
  question: 'Open question',
  risk: 'Risk',
  change: 'Change',
  fact: 'Fact'
}

/** Things to know, not to do: reviewed on their own page, never in the Action Center. */
export const PASSIVE_KINDS: ReadonlySet<InsightItem['kind']> = new Set([
  'decision',
  'change',
  'fact'
])

const insightItem = (i: InsightItem, bucket: ActionBucket): ActionItem => ({
  kind: 'insight',
  key: `insight:${i.id}`,
  id: i.id,
  bucket,
  title: i.text,
  snippet: i.sourceSnippet,
  from: i.sourceLabel,
  when: i.sourceAt,
  unread: false,
  level: i.confidence >= 0.75 ? 'important' : i.confidence >= 0.6 ? 'maybe' : 'noise',
  score: Math.round(i.confidence * 10),
  reasons: [KIND_WHY[i.kind], ...(i.due ? [`Due ${i.due}`] : [])],
  insight: i
})

/** Decisions, changes and facts waiting to be kept or marked not pertinent, newest first. */
export function buildReview(insights: InsightItem[]): ActionItem[] {
  return insights
    .filter((i) => i.status === 'new' && PASSIVE_KINDS.has(i.kind))
    .map((i) => insightItem(i, 'needs-you'))
    .sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''))
}

const rank = (l: ActionLevel): number => (l === 'important' ? 2 : l === 'maybe' ? 1 : 0)

export function buildFeed(
  mail: GmailOverview | null,
  chat: { conversations: ChatConversation[] } | null,
  insights: InsightItem[]
): Feed {
  const items: ActionItem[] = []
  const seen = new Set<string>()
  const email = (t: ThreadItem, bucket: ActionBucket): void => {
    if (seen.has(t.id)) return
    seen.add(t.id)
    items.push({
      kind: 'email',
      key: `email:${t.id}`,
      id: t.id,
      bucket,
      title: t.subject,
      snippet: t.snippet,
      from: t.senderName ?? t.senderEmail,
      when: t.lastMessageAt,
      unread: t.unread,
      level: t.level ?? (bucket === 'hidden' ? 'noise' : 'maybe'),
      score: t.score ?? 0,
      reasons: t.reasons ?? [],
      thread: t
    })
  }
  for (const t of mail?.awaitingMe ?? []) email(t, 'needs-you')
  for (const t of mail?.starred ?? [])
    email({ ...t, level: 'important', score: Math.max(t.score ?? 0, 5) }, 'needs-you')
  for (const g of mail?.groups ?? [])
    for (const t of g.threads) if (!t.taskAdded) email(t, 'needs-you')
  for (const t of mail?.needsReply ?? []) email(t, 'waiting')
  for (const t of mail?.hidden ?? []) email(t, 'hidden')

  for (const c of chat?.conversations ?? []) {
    const bucket: ActionBucket =
      c.bucket === 'needs-you' ? 'needs-you' : c.bucket === 'waiting' ? 'waiting' : 'hidden'
    items.push({
      kind: 'chat',
      key: `chat:${c.key}`,
      id: c.key,
      bucket,
      title: c.title,
      snippet: c.lastText,
      from: c.lastFromMe ? c.title : c.lastSender,
      when: c.lastAt,
      unread: bucket === 'needs-you',
      level: c.bucket === 'needs-you' ? 'important' : c.bucket === 'fyi' ? 'maybe' : 'noise',
      score: c.score,
      reasons: c.reasons.map((r) => CHAT_WHY[r] ?? r).slice(0, 3),
      conversation: c
    })
  }

  for (const i of insights) {
    if (i.status !== 'new' || PASSIVE_KINDS.has(i.kind)) continue
    const bucket: ActionBucket =
      i.confidence < 0.6
        ? 'hidden'
        : i.kind !== 'ask' && i.kind !== 'promise' && !i.mine
          ? 'waiting'
          : 'needs-you'
    items.push(insightItem(i, bucket))
  }

  // Most important first, then newest.
  items.sort(
    (a, b) =>
      rank(b.level) - rank(a.level) ||
      b.score - a.score ||
      (b.when ?? '').localeCompare(a.when ?? '')
  )
  const counts: Feed['counts'] = { 'needs-you': 0, waiting: 0, hidden: 0 }
  for (const i of items) counts[i.bucket]++
  return { items, counts }
}
