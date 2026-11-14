import { describe, it, expect } from 'vitest'
import { composeUrl, searchUrl, threadUrl } from './urls'

describe('gmail urls', () => {
  it('builds a pre-filled compose URL that round-trips subject, body and recipient', () => {
    const body = 'Hi Joe,\n\nFollowing up on "Budget & plan" (due Fri).\n\nThanks,'
    const u = new URL(composeUrl({ to: 'joe@example.com', subject: 'Re: Budget & plan', body }))
    expect(u.hostname).toBe('mail.google.com')
    expect(u.searchParams.get('view')).toBe('cm')
    expect(u.searchParams.get('fs')).toBe('1')
    expect(u.searchParams.get('to')).toBe('joe@example.com')
    expect(u.searchParams.get('su')).toBe('Re: Budget & plan')
    expect(u.searchParams.get('body')).toBe(body) // newlines, quotes and & survive intact
  })
  it('omits the recipient when unknown', () => {
    expect(new URL(composeUrl({ subject: 's', body: 'b' })).searchParams.has('to')).toBe(false)
  })
  it('links to a thread by id, falling back to a quoted subject search', () => {
    expect(threadUrl('18f3a', 'x')).toBe('https://mail.google.com/mail/u/0/#all/18f3a')
    const u = threadUrl(null, 'Say "hi"')
    expect(decodeURIComponent(u.split('#search/')[1])).toBe('subject:"Say hi"')
    expect(searchUrl('in:anywhere newer_than:14d')).toContain('in%3Aanywhere%20newer_than%3A14d')
  })
})
