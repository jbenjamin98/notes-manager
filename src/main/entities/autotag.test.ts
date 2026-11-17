import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'

describe('auto-tagging without typing @ or due:', () => {
  it('infers owners/dates from wording, tags known people in plain text, and lets explicit fields win', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-auto-'))
    try {
      mkdirSync(join(root, 'notes', '2026'), { recursive: true })
      const db = openDb(':memory:')
      // Priya has emailed me before (an email sender), but she was never typed with an @ anywhere.
      db.prepare(
        `INSERT INTO email_threads (id,subject,sender_name,sender_email,last_message_at) VALUES ('e1','Budget','Priya Nair','priya@example.com','2026-11-10T09:00')`
      ).run()

      writeFileSync(
        join(root, 'notes', '2026', '2026-11-13-sync.md'),
        [
          '---',
          'id: "01JAUTO00000000000000000A"',
          'title: "NextMRO sync"',
          'type: "meeting"',
          'date: "2026-11-13"',
          '---',
          '',
          'Spoke with Priya about staging. Sarah Chen owns the firewall work. Joe joined late.',
          '- [ ] Remind Sarah to update the firewall rules by Tuesday',
          '- [ ] Priya to send the revised budget tomorrow',
          '- [ ] Waiting on Joe for the certificate | @Me',
          '- [ ] Review the plan on Nov 20',
          '- [ ] Ask Sarah about the cutover',
          '- [ ] Draft the runbook | due:2026-12-01',
          ''
        ].join('\n')
      )

      const vault = new Vault(db, root, () => ['Me', 'Jacob'])
      await vault.upsertRegistryEntry('person', 'Sarah Chen', [])
      await vault.init()
      try {
        const rows = vault.tasksForNote('notes/2026/2026-11-13-sync.md')
        const by = (frag: string): (typeof rows)[number] =>
          rows.find((t) => t.description.includes(frag))!

        // Owner and due date come from the sentence; "Tuesday" resolves against the NOTE's date (Fri 13 Nov).
        // Wording never changes the owner: "Remind Sarah ..." is my task, about Sarah.
        expect(by('Remind Sarah')).toMatchObject({
          owner: 'Me',
          isMine: true,
          autoOwner: false,
          due: '2026-11-17',
          autoDue: true
        })
        // An email sender is a known person too, even though nobody typed "@Priya".
        expect(by('Priya to send')).toMatchObject({
          owner: 'Me',
          autoOwner: false,
          due: '2026-11-14',
          autoDue: true
        })
        // Explicit fields always win: "| @Me" keeps it mine even though the text says "Waiting on Joe".
        expect(by('Waiting on Joe')).toMatchObject({ owner: 'Me', isMine: true, autoOwner: false })
        expect(by('Review the plan')).toMatchObject({
          owner: 'Me',
          due: '2026-11-20',
          autoDue: true,
          autoOwner: false
        })
        // Asking someone about something is still MY task.
        expect(by('Ask Sarah')).toMatchObject({ owner: 'Me', autoOwner: false })
        expect(by('Draft the runbook')).toMatchObject({ due: '2026-12-01', autoDue: false })

        // People are tagged from plain prose: registry (first name), email sender, no "@" anywhere.
        const ents = vault.listEntities()
        expect(ents.find((e) => e.name === 'Sarah Chen')).toMatchObject({
          category: 'person',
          notes: 1,
          inRegistry: true
        })
        expect(ents.find((e) => e.name === 'Priya Nair')).toMatchObject({
          category: 'person',
          notes: 1,
          inRegistry: false
        })
        // "Joe" is not a known person (no email, no registry, never @-mentioned), so nothing is invented.
        expect(ents.some((e) => e.name === 'Joe')).toBe(false)

        // What quick-add will report for a plain sentence.
        expect(
          vault.previewInference('Remind Sarah to confirm tomorrow', new Date(2026, 10, 13))
        ).toEqual({
          owner: 'Sarah Chen',
          due: '2026-11-14'
        })
      } finally {
        await vault.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

import { applyEvents } from '../calendar/sync'
import { openEventNote } from '../calendar/openEvent'

describe('meeting notes file themselves under the right account', () => {
  it('assigns the registry account named (or aliased) in the meeting title, longest match first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-acct-'))
    try {
      const db = openDb(':memory:')
      const vault = new Vault(db, root, () => ['Me'])
      await vault.init()
      await vault.upsertRegistryEntry('customer', 'Navy NextMRO', ['NextMRO'])
      await vault.upsertRegistryEntry('customer', 'Navy', [])
      expect(vault.guessAccount('NextMRO Weekly Sync')).toBe('Navy NextMRO')
      expect(vault.guessAccount('Navy NextMRO cutover')).toBe('Navy NextMRO') // longer name beats "Navy"
      expect(vault.guessAccount('Team lunch')).toBeNull()
      expect(vault.guessAccount('Nextmrofoo')).toBeNull() // whole words only

      const ev = (id: string, title: string): Parameters<typeof applyEvents>[1][number] => ({
        id,
        date: '2026-11-13',
        startTime: '09:00',
        endTime: '10:00',
        allDay: false,
        title,
        status: 'accepted',
        kind: 'meeting'
      })
      applyEvents(db, [ev('a', 'NextMRO Weekly Sync'), ev('b', 'Team lunch')])
      const pa = await openEventNote(db, vault, 'a')
      const pb = await openEventNote(db, vault, 'b')
      expect((await vault.readNote(pa)).content).toContain('account: "Navy NextMRO"')
      expect((await vault.readNote(pb)).content).not.toContain('account:')
      expect(vault.listNotes().find((n) => n.path === pa)?.account).toBe('Navy NextMRO')
      await vault.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
