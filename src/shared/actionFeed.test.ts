import { describe, expect, it } from 'vitest'
import { buildFeed, buildReview } from './actionFeed'
import type { ChatConversation, GmailOverview, InsightItem, ThreadItem } from './contract'

const thread = (id: string, over: Partial<ThreadItem> = {}): ThreadItem => ({
  id,
  linkId: id,
  subject: `Subject ${id}`,
  snippet: 'Can you look?',
  senderName: 'Dana Cole',
  senderEmail: 'dana@acme.com',
  lastMessageAt: '2026-11-16T09:00',
  unread: true,
  starred: false,
  labels: [],
  taskAdded: false,
  taskText: 'Reply',
  level: 'important',
  score: 6,
  reasons: ['Sent to you'],
  ...over
})
const mail = (over: Partial<GmailOverview> = {}): GmailOverview => ({
  awaitingMe: [],
  awaitingMeTotal: 0,
  hidden: [],
  hiddenTotal: 0,
  needsReply: [],
  starred: [],
  groups: [],
  info: [],
  attention: 0,
  stats: { stored: 0, kept: 0, dropped: {}, keptBy: {} },
  ...over
})
const conv = (key: string, bucket: ChatConversation['bucket'], score = 4): ChatConversation => ({
  key,
  space: 's',
  spaceName: 'Priya',
  spaceType: 'dm',
  title: 'Priya',
  lastAt: '2026-11-16T10:00',
  lastText: 'Can you send the deck?',
  lastSender: 'Priya',
  lastFromMe: false,
  messages: 2,
  score,
  reasons: ['dm', 'question'],
  bucket,
  ageHours: 3,
  awaitingMeHours: 3,
  awaitingThemHours: 0
})
const insight = (id: string, over: Partial<InsightItem> = {}): InsightItem => ({
  id,
  kind: 'ask',
  text: 'Send the budget',
  owner: 'Me',
  due: null,
  confidence: 0.8,
  status: 'new',
  sourceType: 'email',
  sourceLabel: 'Email · Budget',
  sourceSnippet: 'please send',
  sourceAt: '2026-11-15T08:00',
  entities: [],
  mine: true,
  ...over
})

describe('the Action Center feed', () => {
  it('puts email, chat and insights in one list sorted by importance, with the buckets counted', () => {
    const f = buildFeed(
      mail({
        awaitingMe: [thread('a', { score: 7 }), thread('b', { level: 'maybe', score: 3 })],
        needsReply: [thread('w', { level: 'maybe', score: 2 })],
        hidden: [thread('n', { level: 'noise', score: 0 })]
      }),
      { conversations: [conv('c1', 'needs-you'), conv('c2', 'noise', 0)] },
      [
        insight('i1'),
        insight('i2', { confidence: 0.4 }),
        insight('i3', { kind: 'action', mine: false })
      ]
    )
    expect(f.counts).toEqual({ 'needs-you': 4, waiting: 2, hidden: 3 })
    expect(f.items[0].level).toBe('important')
    expect(f.items.at(-1)?.level).toBe('noise')
    expect(f.items.find((i) => i.key === 'chat:c1')).toMatchObject({
      bucket: 'needs-you',
      from: 'Priya'
    })
    expect(f.items.find((i) => i.key === 'insight:i3')?.bucket).toBe('waiting')
    expect(f.items.find((i) => i.key === 'insight:i2')?.bucket).toBe('hidden')
  })

  it('shows a thread once, even when it is starred and waiting', () => {
    const t = thread('a', { starred: true })
    const f = buildFeed(mail({ awaitingMe: [t], starred: [t] }), null, [])
    expect(f.items.filter((i) => i.id === 'a')).toHaveLength(1)
  })

  it('ignores insights you have already handled', () => {
    expect(buildFeed(null, null, [insight('x', { status: 'dismissed' })]).items).toHaveLength(0)
  })

  it('keeps decisions, changes and facts out of the Action Center and in the review list', () => {
    const list = [
      insight('d', { kind: 'decision', text: 'Cutover is Dec 4' }),
      insight('c', { kind: 'change', text: 'Scope moved' }),
      insight('f', { kind: 'fact', text: 'Sarah owns firewall', confidence: 0.5 }),
      insight('a', { kind: 'action' }),
      insight('x', { kind: 'decision', status: 'dismissed' })
    ]
    expect(buildFeed(null, null, list).items.map((i) => i.id)).toEqual(['a'])
    expect(
      buildReview(list)
        .map((i) => i.id)
        .sort()
    ).toEqual(['c', 'd', 'f'])
  })
})
