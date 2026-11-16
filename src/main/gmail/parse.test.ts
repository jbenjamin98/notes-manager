import { describe, it, expect } from 'vitest'
import {
  cleanSubject,
  followUpSubject,
  sanitizeTaskText,
  isUserLabel,
  normalizeRows,
  parseGmailTime,
  suggestTaskText,
  type RawRow
} from './parse'

const row = (over: Partial<RawRow> = {}): RawRow => ({
  legacyId: '18f3a',
  threadId: '#thread-f:1850',
  senders: [{ name: 'Joe Park', email: 'Joe@Example.com' }],
  subject: 'Staging firewall',
  snippet: ' - can you check',
  timeTitle: 'Fri, Nov 13, 2026, 10:47 AM',
  unread: true,
  starred: false,
  labels: ['Inbox', 'Jira', 'jira', ' '],
  ...over
})

describe('gmail parsing', () => {
  it('parses Gmail timestamps (12h clock edge cases, narrow nbsp)', () => {
    expect(parseGmailTime('Fri, Nov 13, 2026, 10:47 AM')).toBe('2026-11-13T10:47')
    expect(parseGmailTime('Mon, Jan 5, 2026, 12:05 AM')).toBe('2026-01-05T00:05')
    expect(parseGmailTime('Mon, Jan 5, 2026, 12:05 PM')).toBe('2026-01-05T12:05')
    expect(parseGmailTime('Tue, Dec 1, 2026, 11:59 PM')).toBe('2026-12-01T23:59')
    expect(parseGmailTime('yesterday')).toBeNull()
  })

  it('keeps only user labels, once; prefers the legacy id; strips snippet dash', () => {
    const [t] = normalizeRows([row()], null)
    expect(t.id).toBe('18f3a')
    expect(t.labels).toEqual(['Jira']) // "Inbox" is a system label; Jira/jira are one label
    expect(t.snippet).toBe('can you check')
    expect(t.senderEmail).toBe('joe@example.com')
    expect(t.lastMessageAt).toBe('2026-11-13T10:47')
    expect(isUserLabel('Inbox')).toBe(false)
    expect(isUserLabel('CHIRPS')).toBe(true)
  })

  it('knows when the last message in a thread is from me, and who the other party is', () => {
    const me = { name: 'me', email: 'jacob@appian.com' }
    const joe = { name: 'Joe Park', email: 'joe@example.com' }
    const [a] = normalizeRows([row({ senders: [joe, me] })], 'jacob@appian.com')
    expect(a.lastSenderIsMe).toBe(true)
    expect(a.senderName).toBe('Joe Park')
    const [b] = normalizeRows([row({ senders: [me, joe] })], 'jacob@appian.com')
    expect(b.lastSenderIsMe).toBe(false)
    // Self detected by email even when Gmail prints your real name instead of "me".
    const [c] = normalizeRows(
      [row({ senders: [joe, { name: 'Jacob Benjamin', email: 'JACOB@appian.com' }] })],
      'jacob@appian.com'
    )
    expect(c.lastSenderIsMe).toBe(true)
  })

  it('skips rows without an id or subject, and falls back to data-thread-id', () => {
    expect(normalizeRows([row({ legacyId: null, threadId: null })], null)).toEqual([])
    expect(normalizeRows([row({ subject: '  ' })], null)).toEqual([])
    expect(normalizeRows([row({ legacyId: null })], null)[0]).toMatchObject({
      id: 'thread-f:1850',
      linkId: null
    })
  })

  it('sanitises task text without touching ordinary characters', () => {
    expect(sanitizeTaskText('Budget | Q4  review')).toBe('Budget / Q4 review')
    expect(sanitizeTaskText('Plain subject, with: punctuation')).toBe(
      'Plain subject, with: punctuation'
    )
  })

  it('suggests deterministic task text', () => {
    expect(cleanSubject('Re: Fwd: Budget numbers')).toBe('Budget numbers')
    expect(suggestTaskText({ subject: '[JIRA] (NMRO-171) Rate limit tuning' })).toBe(
      'Jira NMRO-171: Rate limit tuning'
    )
    expect(suggestTaskText({ subject: 'NMRO-9 assigned to you' })).toBe(
      'Jira NMRO-9: assigned to you'
    )
    expect(suggestTaskText({ subject: 'Budget numbers' })).toBe('Review: Budget numbers')
    expect(suggestTaskText({ subject: 'Budget numbers', unreplied: true })).toBe(
      'Follow up: Budget numbers'
    )
    expect(followUpSubject('Re: Budget numbers')).toBe('Re: Budget numbers')
  })
})
