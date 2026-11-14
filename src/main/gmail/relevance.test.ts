import { describe, it, expect } from 'vitest'
import {
  classify,
  isAutomatedSender,
  isCalendarNoise,
  normalizeMute,
  type RelevanceCtx,
  type RelevanceFacts
} from './relevance'

const facts = (over: Partial<RelevanceFacts> = {}): RelevanceFacts => ({
  starred: false,
  labels: [],
  iParticipated: false,
  inInbox: true,
  subject: 'Budget numbers',
  senderEmail: 'priya@example.com',
  senderName: 'Priya Nair',
  ...over
})
const ctx = (over: Partial<RelevanceCtx> = {}): RelevanceCtx => ({
  handlerOf: () => 'info',
  mutedEmails: new Set(),
  mutedDomains: new Set(),
  ...over
})

describe('relevance: what gets brought in', () => {
  it('keeps mail you routed (star, label, your own reply) and human inbox mail', () => {
    expect(classify(facts({ starred: true, inInbox: false }), ctx())).toEqual({
      keep: true,
      reason: 'starred'
    })
    // A label set to Counts is "counted" (a number, never listed); one set to Tasks is brought in.
    expect(classify(facts({ labels: ['Jira'], inInbox: false }), ctx())).toEqual({
      keep: true,
      reason: 'counted'
    })
    expect(
      classify(facts({ labels: ['Jira'], inInbox: false }), ctx({ handlerOf: () => 'tasks' }))
    ).toEqual({ keep: true, reason: 'label' })
    expect(classify(facts({ iParticipated: true, inInbox: false }), ctx())).toEqual({
      keep: true,
      reason: 'mine'
    })
    expect(classify(facts(), ctx())).toEqual({ keep: true, reason: 'inbox' })
  })

  it('drops bulk, automated, archived, calendar chatter and ignored labels', () => {
    expect(classify(facts({ senderEmail: 'noreply@shop.com' }), ctx())).toEqual({
      keep: false,
      reason: 'automated'
    })
    expect(classify(facts({ inInbox: false }), ctx())).toEqual({ keep: false, reason: 'archived' })
    expect(classify(facts({ subject: 'Accepted: Team sync @ Mon' }), ctx())).toEqual({
      keep: false,
      reason: 'calendar'
    })
    expect(classify(facts({ labels: ['Noise'] }), ctx({ handlerOf: () => 'ignore' }))).toEqual({
      keep: false,
      reason: 'ignored-label'
    })
  })

  it('treats a label you made as a signal even for automated senders (Jira), but a muted sender is never shown', () => {
    expect(
      classify(facts({ senderEmail: 'jira@corp.atlassian.net', labels: ['Jira'] }), ctx())
    ).toMatchObject({ keep: true })
    expect(
      classify(facts({ senderEmail: 'joe@spam.io' }), ctx({ mutedDomains: new Set(['spam.io']) }))
    ).toEqual({ keep: false, reason: 'muted' })
    // ...unless you starred it: an explicit action beats a blanket mute.
    expect(
      classify(
        facts({ senderEmail: 'joe@spam.io', starred: true }),
        ctx({ mutedDomains: new Set(['spam.io']) })
      )
    ).toMatchObject({ keep: true })
  })

  it('an ignored label does not hide a thread that also carries a useful label', () => {
    const c = ctx({ handlerOf: (l) => (l === 'Noise' ? 'ignore' : 'tasks') })
    expect(classify(facts({ labels: ['Noise', 'Jira'] }), c)).toMatchObject({
      keep: true,
      reason: 'label'
    })
  })

  it('detects automated senders and calendar noise without flagging people', () => {
    for (const e of [
      'no-reply@x.com',
      'noreply@x.com',
      'notifications@github.com',
      'mailer-daemon@x.com',
      'news@x.com'
    ])
      expect(isAutomatedSender(e, null)).toBe(true)
    expect(isAutomatedSender('info@mail.brand.com', null)).toBe(true) // bulk subdomain
    // People are never flagged, even when part of their address looks like a keyword.
    for (const e of [
      'priya.nair@example.com',
      'joe@acme.co',
      'sam.reply@acme.co',
      'dana.news@acme.co'
    ])
      expect(isAutomatedSender(e, 'Someone')).toBe(false)
    expect(isCalendarNoise('Updated invitation: Review @ Tue Nov 17')).toBe(true)
    expect(isCalendarNoise('Invitation to the offsite')).toBe(false)
  })

  it('normalises mute input', () => {
    expect(normalizeMute(' Joe@Spam.IO ')).toBe('joe@spam.io')
    expect(normalizeMute('https://Spam.io/path')).toBe('@spam.io')
    expect(normalizeMute('@news.example.com')).toBe('@news.example.com')
    expect(normalizeMute('not a thing')).toBeNull()
    expect(normalizeMute('')).toBeNull()
  })
})
