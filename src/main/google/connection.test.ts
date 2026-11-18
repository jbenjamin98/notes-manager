import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { connectionState, type ConnInputs } from './connection'
import { mergeSettings } from '../services/settings'
import { SettingsSchema } from '../../shared/contract'
import { isAutomatedSender, isPersonThread } from '../gmail/relevance'
import { openDb } from '../db'
import { eventsForDay, listUpcoming } from '../calendar/sync'

const idle = { state: 'idle', error: null, lastSyncAt: '2026-11-16T10:00:00Z' }
const base: ConnInputs = {
  apiActive: false,
  apiEmail: null,
  bridgeUrl: 'https://script.google.com/macros/s/AKfy/exec',
  hasToken: true,
  selfTest: { code: null, message: null, email: 'me@x.com' },
  cal: idle,
  mail: idle
}

describe('Google connection state (one answer for every screen)', () => {
  it('a working script is ok, not "not connected"', () => {
    const c = connectionState(base)
    expect(c).toMatchObject({ source: 'bridge', state: 'ok', action: 'refresh' })
    expect(c.detail).toMatch(/private script/)
  })

  it('no address is "not set up" with a setup action', () => {
    expect(connectionState({ ...base, bridgeUrl: '' })).toMatchObject({
      source: 'none',
      state: 'not-set-up',
      action: 'setup'
    })
  })

  it('an address without the key says to copy the script again', () => {
    const c = connectionState({ ...base, hasToken: false })
    expect(c.state).toBe('missing-key')
    expect(c.action).toBe('copy-script')
  })

  it('a signed-out sync asks to sign in; quota says busy, not broken', () => {
    expect(connectionState({ ...base, cal: { ...idle, state: 'needs-auth' } }).action).toBe(
      'sign-in'
    )
    expect(
      connectionState({
        ...base,
        mail: { ...idle, state: 'error', error: 'Google is busy: try again in a minute.' }
      }).state
    ).toBe('busy')
  })

  it('an expired OAuth sign-in asks to sign in again, not "not set up"', () => {
    expect(
      connectionState({ ...base, bridgeUrl: '', apiRevoked: true, apiActive: false })
    ).toMatchObject({ source: 'api', state: 'needs-login', action: 'sign-in' })
  })

  it('OAuth wins over the script', () => {
    expect(connectionState({ ...base, apiActive: true, apiEmail: 'a@b.com' })).toMatchObject({
      source: 'api',
      state: 'ok',
      email: 'a@b.com'
    })
  })
})

describe('settings updates merge field by field', () => {
  it('changing one Google option keeps the script address', () => {
    const cur = SettingsSchema.parse({
      google: { bridgeUrl: 'https://script.google.com/macros/s/AKfy/exec' }
    })
    const next = mergeSettings(cur, { google: { meetNotes: false } })
    expect(next.google.bridgeUrl).toBe('https://script.google.com/macros/s/AKfy/exec')
    expect(next.google.meetNotes).toBe(false)
  })

  it('record settings (label handlers) are replaced so removals stick', () => {
    const cur = SettingsSchema.parse({ gmailLabels: { a: 'tasks', b: 'info' } })
    expect(mergeSettings(cur, { gmailLabels: { a: 'tasks' } }).gmailLabels).toEqual({
      a: 'tasks'
    })
  })
})

describe('machine senders are never people you owe a reply', () => {
  it.each([
    ['calendar-notification@google.com', 'Google Calendar'],
    ['calendar-notification@google.com', null],
    [null, 'Google Calendar'],
    ['drive-shares-dm-noreply@google.com', 'Sam (via Google Docs)'],
    ['comments-noreply@docs.google.com', 'Sam (Google Docs)'],
    ['jira@acme.atlassian.net', 'Jira'],
    ['no-reply@zoom.us', 'Zoom'],
    ['feedback@slack.com', 'Slack']
  ])('%s / %s', (email, name) => {
    expect(isAutomatedSender(email, name)).toBe(true)
  })

  it('people stay people', () => {
    expect(isAutomatedSender('sarah.lee@acme.com', 'Sarah Lee')).toBe(false)
    expect(isAutomatedSender('calvin@acme.com', 'Calvin Docs')).toBe(false)
  })

  it('invitation subjects are not reply-owed', () => {
    expect(
      isPersonThread({
        senderEmail: 'sarah@acme.com',
        senderName: 'Sarah',
        subject: 'Invitation: Sprint review @ Mon Nov 17'
      })
    ).toBe(false)
  })
})

describe('one rule for "meetings on a day"', () => {
  it('counts the same events everywhere', () => {
    const db = openDb(':memory:')
    const add = (
      id: string,
      title: string,
      start: string,
      o: { allDay?: number; kind?: string; status?: string | null } = {}
    ): void => {
      db.prepare(
        `INSERT INTO calendar_events (id,title,start_at,end_at,date,all_day,kind,status,fetched_at)
         VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
      ).run(
        id,
        title,
        `2026-11-16T${start}:00`,
        `2026-11-16T${start}:30`,
        '2026-11-16',
        o.allDay ?? 0,
        o.kind ?? 'meeting',
        o.status ?? 'accepted'
      )
    }
    add('a', 'Standup', '09:00')
    add('b', 'Standup', '09:00') // same invite on a second calendar
    add('c', 'Review', '11:00', { status: 'tentative' })
    add('d', 'Lunch', '12:00', { status: 'declined' })
    add('e', 'Home', '00:00', { kind: 'working_location' })
    add('f', 'Holiday', '00:00', { allDay: 1, kind: 'allday' })
    add('g', '1:1', '15:00', { status: 'needs_action' })
    const day = eventsForDay(db, '2026-11-16').map((e) => e.title)
    expect(day).toEqual(['Standup', 'Review', '1:1'])
    expect(listUpcoming(db, '2026-11-16').filter((e) => e.date === '2026-11-16')).toHaveLength(3)
  })
})
