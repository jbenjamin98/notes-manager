import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { createSecretStore } from '../services/secrets'
import { LlmUnavailable, type JsonRequest, type JsonResult } from '../llm/router'
import { classifyIntent, mentionsCui, redact } from './intent'
import { ftsQuery, retrieve } from './retrieve'
import { Assistant, type JsonGenerator } from './assistant'

const NOW = new Date(2026, 10, 13, 10, 0) // Fri 13 Nov 2026, 10:00

describe('secret store', () => {
  it('keeps keys encrypted on disk and refuses to store without OS encryption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nm-sec-'))
    try {
      const file = join(dir, 'secrets.json')
      const fake = {
        available: () => true,
        encrypt: (p: string) => Buffer.from(p.split('').reverse().join('')),
        decrypt: (b: Buffer) => b.toString().split('').reverse().join('')
      }
      const s = createSecretStore(file, fake)
      s.set('llm.gemini', '  AIzaSecretKey1234  ')
      expect(s.get('llm.gemini')).toBe('AIzaSecretKey1234')
      expect(s.has('llm.other')).toBe(false)
      expect(readFileSync(file, 'utf8')).not.toContain('AIzaSecretKey1234')
      s.delete('llm.gemini')
      expect(s.get('llm.gemini')).toBeNull()
      const off = createSecretStore(file, { ...fake, available: () => false })
      expect(() => off.set('x', 'yyyyyyyyyyyyy')).toThrow(/cannot encrypt/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('intent + privacy helpers', () => {
  it('routes questions to ask and everything else to capture, with explicit overrides', () => {
    expect(classifyIntent('What did we decide about the cutover?').intent).toBe('ask')
    expect(classifyIntent('who owns the firewall work').intent).toBe('ask')
    expect(classifyIntent('Remind Sarah to send the deck tomorrow').intent).toBe('capture')
    expect(classifyIntent('Met with Navy.\nSarah will update rules by Tuesday.').intent).toBe(
      'capture'
    )
    expect(classifyIntent('/ask budget status')).toEqual({ intent: 'ask', text: 'budget status' })
    expect(classifyIntent('/note what a day')).toEqual({ intent: 'capture', text: 'what a day' })
  })
  it('detects CUI markings, including spelled-out ones, and redacts emails and phone numbers', () => {
    expect(mentionsCui('Controlled Unclassified Information')).toBe(true)
    expect(mentionsCui('marked FOUO')).toBe(true)
    expect(mentionsCui('This is CUI//SP-CTI data')).toBe(true)
    expect(mentionsCui('a document about cuisine')).toBe(false)
    expect(redact('mail joe@example.com or call 555-123-4567')).toBe(
      'mail [email] or call [number]'
    )
  })
})

interface Env {
  root: string
  vault: Vault
  db: ReturnType<typeof openDb>
  reminders: { text: string; at: Date }[]
  assistant: Assistant
  calls: JsonRequest<unknown>[]
}

async function setup(
  llm: (req: JsonRequest<unknown>) => unknown | Promise<unknown>,
  settings: { blockCui?: boolean } = {}
): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), 'nm-asst-'))
  mkdirSync(join(root, 'notes', '2026'), { recursive: true })
  const note = (name: string, id: string, fm: string, body: string): void =>
    writeFileSync(join(root, 'notes', '2026', name), `---\nid: "${id}"\n${fm}---\n\n${body}\n`)
  note(
    '2026-11-10-nextmro-sync.md',
    '01JASST0000000000000000001',
    'title: "NextMRO sync"\ntype: "meeting"\ndate: "2026-11-10"\naccount: "Navy NextMRO"\n',
    '## Key Decisions & Insights\n- Cutover moves to December 4 because the firewall rules are late.\n- Sarah Chen owns the firewall work.\n'
  )
  note(
    '2026-11-11-secret.md',
    '01JASST0000000000000000002',
    'title: "Secret review"\ntype: "meeting"\ndate: "2026-11-11"\ntags: [CUI]\n',
    '## Key Decisions & Insights\n- The cutover plan details are restricted.\n'
  )
  const db = openDb(':memory:')
  const vault = new Vault(db, root, () => ['Me', 'Jacob'])
  await vault.upsertRegistryEntry('person', 'Sarah Chen', [])
  await vault.init()
  const calls: JsonRequest<unknown>[] = []
  const reminders: { text: string; at: Date }[] = []
  const gen: JsonGenerator = {
    async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
      calls.push(req as JsonRequest<unknown>)
      const raw = await llm(req as JsonRequest<unknown>)
      return { data: req.schema.parse(raw), provider: 'gemini', model: 'fake', cached: false }
    }
  }
  const assistant = new Assistant({
    db,
    llm: gen,
    vault: () => vault,
    addReminder: (text, at) => {
      reminders.push({ text, at })
      return 'r1'
    },
    getSettings: () => ({
      meAliases: ['Me', 'Jacob'],
      timezone: 'America/New_York',
      llm: { enabled: true, blockCui: settings.blockCui ?? true }
    }),
    now: () => NOW
  })
  return { root, vault, db, reminders, assistant, calls }
}
const done = async (e: Env): Promise<void> => {
  await e.vault.close()
  rmSync(e.root, { recursive: true, force: true })
}

describe('retrieval', () => {
  it('finds relevant chunks safely, flags CUI notes, and survives hostile queries', async () => {
    const e = await setup(() => ({}))
    try {
      expect(ftsQuery('What did we decide?')).toBeNull() // only stop words
      expect(ftsQuery('firewall "AND" OR (rules)')).toContain('"firewall"')
      const hits = retrieve(e.db, 'when is the cutover moving?')
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.some((h) => h.title === 'NextMRO sync' && !h.blocked)).toBe(true)
      expect(retrieve(e.db, 'NEAR( ) * " --')).toEqual([])
    } finally {
      await done(e)
    }
  })
})

describe('Co-Pilot', () => {
  it('turns a brain-dump into reviewable cards, computing dates itself, and writes nothing until Apply', async () => {
    const e = await setup(() => ({
      reply: 'Found a task, a reminder and a note.',
      tasks: [
        {
          description: 'Update the firewall rules',
          owner: 'Sarah',
          due_phrase: 'next Thursday',
          due: '2026-01-01',
          priority: 'high'
        },
        { description: 'Send the budget', owner: 'jacob', due_phrase: 'tomorrow' }
      ],
      reminders: [{ text: 'Call Priya', at_phrase: 'tomorrow at 3pm' }],
      notes: [
        {
          title: 'Navy kickoff',
          kind: 'meeting',
          account: 'navy nextmro',
          summary: 'Kickoff call.',
          decisions: ['Go live in Q1'],
          open_questions: ['Who signs off?'],
          action_items: [{ description: 'Draft runbook', owner: 'Sarah', due_phrase: 'Tuesday' }]
        }
      ]
    }))
    try {
      const [user, reply] = await e.assistant.send(
        'Sarah to update firewall rules next Thursday. Met Navy.'
      )
      expect(user.role).toBe('user')
      expect(reply.via).toBe('llm')
      const [note, t1, t2, rem] = reply.proposals
      expect(note).toMatchObject({
        kind: 'note',
        title: 'Navy kickoff',
        account: 'Navy NextMRO',
        noteKind: 'meeting'
      })
      // WE compute "next Thursday" (2026-11-19); the model's wrong date is overridden and flagged.
      expect(t1).toMatchObject({
        kind: 'task',
        owner: 'Sarah Chen',
        due: '2026-11-19',
        priority: 'High'
      })
      expect(t1.kind === 'task' && t1.dueNote).toContain('2026-01-01')
      expect(t2).toMatchObject({ owner: 'Me', due: '2026-11-14' })
      expect(rem).toMatchObject({ kind: 'reminder', at: '2026-11-14T15:00' })
      expect(note.kind === 'note' && note.body).toContain('## Action Items')
      expect(note.kind === 'note' && note.body).toContain('Draft runbook')
      // Nothing written yet.
      expect(e.vault.listTasks().some((t) => t.description.includes('budget'))).toBe(false)

      // The model only ever saw redacted text, with today's date in the instructions.
      expect(e.calls[0].system).toContain('2026-11-13')

      const a1 = await e.assistant.apply(reply.id, 1, { due: '2026-11-21' })
      expect(a1.proposals[1]).toMatchObject({ status: 'applied', due: '2026-11-21' })
      expect(
        e.vault.listTasks().find((t) => t.description === 'Update the firewall rules')
      ).toMatchObject({
        owner: 'Sarah Chen',
        due: '2026-11-21'
      })
      // Applying twice does nothing.
      await e.assistant.apply(reply.id, 1)
      expect(
        e.vault.listTasks().filter((t) => t.description === 'Update the firewall rules')
      ).toHaveLength(1)

      const a0 = await e.assistant.apply(reply.id, 0)
      const path = (a0.proposals[0] as { appliedPath: string }).appliedPath
      const md = readFileSync(join(e.root, path), 'utf8')
      expect(md).toContain('title: "Navy kickoff"')
      expect(md).toContain('## Key Decisions & Insights\n- Go live in Q1')
      expect(md).toContain('Draft runbook')

      await e.assistant.apply(reply.id, 3)
      expect(e.reminders).toHaveLength(1)
      expect(e.reminders[0].at.getHours()).toBe(15)

      const d = e.assistant.dismiss(reply.id, 2)
      expect(d.proposals[2].status).toBe('dismissed')
      expect(e.assistant.history().map((m) => m.role)).toEqual(['user', 'assistant'])
    } finally {
      await done(e)
    }
  })

  it('rejects reminders without a usable future time', async () => {
    const e = await setup(() => ({ reminders: [{ text: 'Do it', at_phrase: 'sometime' }] }))
    try {
      const [, reply] = await e.assistant.send('remind me to do it sometime')
      expect(reply.proposals[0]).toMatchObject({ kind: 'reminder', at: null })
      await expect(e.assistant.apply(reply.id, 0)).rejects.toThrow(/Pick a time/)
      const ok = await e.assistant.apply(reply.id, 0, { at: '2026-11-16T09:00' })
      expect(ok.proposals[0].status).toBe('applied')
    } finally {
      await done(e)
    }
  })

  it('never sends CUI text to the LLM and falls back to a local parse', async () => {
    const e = await setup(() => {
      throw new Error('LLM must not be called')
    })
    try {
      const [, reply] = await e.assistant.send('- Send CUI roster to Sarah tomorrow\n- Review plan')
      expect(e.calls).toHaveLength(0)
      expect(reply.via).toBe('local')
      expect(reply.notice).toMatch(/CUI/)
      expect(reply.proposals).toHaveLength(2)
      expect(reply.proposals[0]).toMatchObject({ kind: 'task', due: '2026-11-14' })
    } finally {
      await done(e)
    }
  })

  it('falls back locally when the AI is unavailable', async () => {
    const e = await setup(() => {
      throw new LlmUnavailable('no-key', 'no key')
    })
    try {
      const [, cap] = await e.assistant.send('Call the vendor Monday')
      expect(cap.via).toBe('local')
      expect(cap.notice).toMatch(/No AI key/)
      expect(cap.proposals[0]).toMatchObject({ kind: 'task', due: '2026-11-16' })
      const [, ans] = await e.assistant.send('When is the cutover moving?')
      expect(ans.via).toBe('local')
      expect(ans.content).toContain('Closest matches')
      expect(ans.citations.some((c) => c.title === 'NextMRO sync')).toBe(true)
    } finally {
      await done(e)
    }
  })

  it('answers questions from notes with citations and keeps CUI notes out of the prompt', async () => {
    const e = await setup((req) => {
      expect(req.user).not.toContain('restricted')
      return { answer: 'The cutover moves to December 4 [1].', cited: [1, 9] }
    })
    try {
      const [, reply] = await e.assistant.send('When is the cutover moving?')
      expect(reply.via).toBe('llm')
      expect(reply.content).toContain('December 4')
      expect(reply.citations).toHaveLength(1)
      expect(reply.citations[0]).toMatchObject({ title: 'NextMRO sync' })
      expect(reply.notice).toMatch(/CUI/)
    } finally {
      await done(e)
    }
  })
})
