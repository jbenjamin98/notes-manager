import { describe, it, expect } from 'vitest'
import { listWaiting } from '../waiting/waiting'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { createSecretStore } from '../services/secrets'
import { LlmUnavailable, type JsonRequest, type JsonResult } from '../llm/router'
import { classifyIntent } from './intent'
import { ftsQuery, retrieve } from './retrieve'
import { Assistant, type ActionSources, type JsonGenerator } from './assistant'

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

describe('intent', () => {
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
  settings: {
    blockCui?: boolean
    mode?: string
    persona?: string
    sources?: ActionSources
    compose?: (d: { to?: string; subject: string; body: string }) => void
  } = {}
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
      llm: { enabled: true, mode: settings.mode },
      assistant: { persona: settings.persona ?? 'nova' }
    }),
    sources: settings.sources,
    compose: settings.compose,
    guessEmail: (n) => (n === 'Sarah Chen' ? 'sarah@example.com' : null),
    now: () => NOW
  })
  return { root, vault, db, reminders, assistant, calls }
}
const done = async (e: Env): Promise<void> => {
  await e.vault.close()
  rmSync(e.root, { recursive: true, force: true })
}

describe('retrieval', () => {
  it('finds relevant chunks safely, and survives hostile queries', async () => {
    const e = await setup(() => ({}))
    try {
      expect(ftsQuery('What did we decide?')).toBeNull() // only stop words
      expect(ftsQuery('firewall "AND" OR (rules)')).toContain('"firewall"')
      const hits = retrieve(e.db, 'when is the cutover moving?')
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.some((h) => h.title === 'NextMRO sync')).toBe(true)
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
        'Sarah to update firewall rules next Thursday. Met Navy.',
        'capture'
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
        owner: 'Me',
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

      // The model sees today's date in the instructions.
      expect(e.calls[0].system).toContain('2026-11-13')

      const a1 = await e.assistant.apply(reply.id, 1, { due: '2026-11-21' })
      expect(a1.proposals[1]).toMatchObject({ status: 'applied', due: '2026-11-21' })
      // Sarah's action is my task to follow up, about Sarah: it is not handed to her.
      expect(
        e.vault
          .listTasks()
          .some((t) => t.description === 'Follow up with Sarah Chen: Update the firewall rules')
      ).toBe(true)
      expect(listWaiting(e.db)).toHaveLength(0)
      // Applying twice does nothing.
      await e.assistant.apply(reply.id, 1)
      expect(
        e.vault.listTasks().filter((t) => t.description.startsWith('Follow up with Sarah Chen'))
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
      const [, reply] = await e.assistant.send('remind me to do it sometime', 'capture')
      expect(reply.proposals[0]).toMatchObject({ kind: 'reminder', at: null })
      await expect(e.assistant.apply(reply.id, 0)).rejects.toThrow(/Pick a time/)
      const ok = await e.assistant.apply(reply.id, 0, { at: '2026-11-16T09:00' })
      expect(ok.proposals[0].status).toBe('applied')
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
      expect(ans.content).toContain('From your notes')
      expect(ans.citations.some((c) => c.title === 'NextMRO sync')).toBe(true)
    } finally {
      await done(e)
    }
  })

  it('answers questions from notes with citations', async () => {
    const e = await setup(() => {
      return { answer: 'The cutover moves to December 4 [1].', cited: [1, 9] }
    })
    try {
      const [, reply] = await e.assistant.send('When is the cutover moving?')
      expect(reply.via).toBe('llm')
      expect(reply.content).toContain('December 4')
      expect(reply.citations).toHaveLength(1)
      expect(reply.citations[0]).toMatchObject({ title: 'NextMRO sync' })
    } finally {
      await done(e)
    }
  })
})

const sources = (over: Partial<ActionSources> = {}): ActionSources => ({
  note: async (p) =>
    p === 'secret'
      ? { title: 'Secret review', date: '2026-11-11', body: 'Restricted.', blocked: true }
      : {
          title: 'NextMRO sync',
          date: '2026-11-10',
          body: 'Cutover moves to December 4. Sarah Chen sends the revised plan Friday.',
          blocked: false
        },
  prep: () => ({
    title: 'NextMRO Weekly',
    text: 'Meeting: NextMRO Weekly\nOpen tasks:\n- Update firewall rules',
    blocked: false
  }),
  week: () => ({
    label: 'Nov 9 – Nov 15',
    weekStart: '2026-11-09',
    markdown: '## Week\n3 meetings · 2 tasks completed\n'
  }),
  day: () => ({ text: 'Today is 2026-11-13.\n\nTasks due:\n- Update firewall rules' }),
  entity: () => ({
    name: 'Navy',
    text: 'Navy (customer)\n- 2026-11-10 NextMRO sync',
    blocked: false
  }),
  ...over
})

describe('AI modes', () => {
  it('Light asks the small model with a short limit and no repair; Heavy reads more and asks for follow-ups', async () => {
    const seen: JsonRequest<unknown>[] = []
    const answer = { answer: 'Dec 4 [1].', cited: [1], followups: ['Who owns it?', 'Why late?'] }
    for (const mode of ['light', 'normal', 'heavy']) {
      const e = await setup(
        (r) => {
          seen.push(r)
          return answer
        },
        { mode }
      )
      try {
        await e.assistant.send('When is the cutover moving?')
      } finally {
        await done(e)
      }
    }
    const [light, normal, heavy] = seen
    expect([light.tier, normal.tier, heavy.tier]).toEqual(['extract', 'chat', 'chat'])
    expect(light.maxOut!).toBeLessThan(heavy.maxOut!)
    expect(light.repair).toBe(false)
    expect(heavy.repair).toBe(true)
    expect(light.system).toContain('leave empty')
    expect(heavy.system).toContain('up to 3 short follow-up questions')
  })

  it('suggests follow-ups only in Heavy, and remembers earlier turns', async () => {
    const calls: JsonRequest<unknown>[] = []
    const reply = { answer: 'Dec 4 [1].', cited: [1], followups: ['Who owns it?', 'Why late?'] }
    const e = await setup(
      (r) => {
        calls.push(r)
        return reply
      },
      { mode: 'heavy' }
    )
    try {
      const [, a1] = await e.assistant.send('When is the cutover moving?')
      expect(a1.followups).toEqual(['Who owns it?', 'Why late?'])
      await e.assistant.send('And who owns the firewall work?')
      expect(calls[1].user).toContain('Earlier in this chat')
      expect(calls[1].user).toContain('When is the cutover moving?')
    } finally {
      await done(e)
    }
    const l = await setup(() => reply, { mode: 'light' })
    try {
      const [, a] = await l.assistant.send('When is the cutover moving?')
      expect(a.followups).toEqual([])
    } finally {
      await done(l)
    }
  })
})

describe('one-click actions', () => {
  it('summarises a note into readable text', async () => {
    const e = await setup(
      () => ({
        tldr: 'Cutover slips to Dec 4.',
        decisions: ['Move cutover'],
        open_questions: [],
        next_steps: ['Send plan']
      }),
      { sources: sources() }
    )
    try {
      const [user, reply] = await e.assistant.runAction({
        kind: 'summarize-note',
        path: 'notes/2026/x.md'
      })
      expect(user.content).toBe('Summarize “NextMRO sync”')
      expect(reply.content).toContain('Cutover slips to Dec 4.')
      expect(reply.content).toContain('Decisions\n• Move cutover')
      expect(reply.via).toBe('llm')
      expect(e.calls[0].user).toContain('December 4')
    } finally {
      await done(e)
    }
  })

  it('turns found action items into approve-first task cards, with dates computed locally', async () => {
    const e = await setup(
      () => ({
        tasks: [{ description: 'Send the revised plan', owner: 'Sarah Chen', due_phrase: 'Friday' }]
      }),
      { sources: sources() }
    )
    try {
      const [, reply] = await e.assistant.runAction({ kind: 'extract-actions', path: 'p' })
      expect(reply.proposals).toHaveLength(1)
      expect(reply.proposals[0]).toMatchObject({
        kind: 'task',
        owner: 'Me',
        due: '2026-11-13',
        status: 'pending'
      })
      expect(e.vault.listTasks().some((t) => t.description === 'Send the revised plan')).toBe(false)
    } finally {
      await done(e)
    }
  })

  it('drafts a follow-up email card; applying opens a pre-filled compose window and never sends', async () => {
    const opened: { to?: string; subject: string; body: string }[] = []
    const e = await setup(
      () => ({
        recipient_name: 'Sarah Chen',
        subject: 'Follow-up: NextMRO sync',
        body: 'Hi Sarah,\n\nThanks.'
      }),
      { sources: sources(), compose: (d) => opened.push(d) }
    )
    try {
      const [, reply] = await e.assistant.runAction({ kind: 'draft-followup', path: 'p' })
      expect(reply.proposals[0]).toMatchObject({ kind: 'email', to: 'sarah@example.com' })
      expect(opened).toHaveLength(0)
      const applied = await e.assistant.apply(reply.id, 0, { subject: 'Edited subject' })
      expect(opened).toEqual([
        { to: 'sarah@example.com', subject: 'Edited subject', body: 'Hi Sarah,\n\nThanks.' }
      ])
      expect(applied.proposals[0].status).toBe('applied')
    } finally {
      await done(e)
    }
  })

  it('falls back to local text for the weekly update and day plan when no AI is available', async () => {
    const e = await setup(
      () => {
        throw new LlmUnavailable('no-key', 'no key')
      },
      { sources: sources() }
    )
    try {
      const [, week] = await e.assistant.runAction({ kind: 'week-update' })
      expect(week.via).toBe('local')
      expect(week.content).toContain('3 meetings')
      expect(week.proposals[0]).toMatchObject({
        kind: 'email',
        subject: 'Weekly update: Nov 9 – Nov 15'
      })
      const [, day] = await e.assistant.runAction({ kind: 'day-brief' })
      expect(day.content).toContain('Update firewall rules')
      const [, brief] = await e.assistant.runAction({ kind: 'prep-brief', eventId: 'x' })
      expect(brief.content).toMatch(/AI is needed/)
    } finally {
      await done(e)
    }
  })

  it('writes meeting briefs, day plans and catch-ups from the context it is given', async () => {
    const e = await setup(
      (r) =>
        r.system.includes('Plan the day')
          ? {
              headline: 'Focus on the firewall.',
              priorities: ['Update firewall rules: overdue'],
              heads_up: []
            }
          : r.system.includes('Catch the reader')
            ? { summary: 'Navy is on track.', timeline: ['Nov 10: reviewed'], open_items: [] }
            : {
                headline: 'Ask about the rules.',
                bullets: ['Rules late'],
                watch_outs: ['Cutover risk']
              },
      { sources: sources() }
    )
    try {
      const [, brief] = await e.assistant.runAction({ kind: 'prep-brief', eventId: 'x' })
      expect(brief.content).toContain('Watch out for\n• Cutover risk')
      const [, day] = await e.assistant.runAction({ kind: 'day-brief' })
      expect(day.content).toContain('1. Update firewall rules: overdue')
      const [, catchUp] = await e.assistant.runAction({
        kind: 'catch-up',
        entityId: 'customer:navy'
      })
      expect(catchUp.content).toContain('Timeline\n• Nov 10: reviewed')
    } finally {
      await done(e)
    }
  })
})

describe('the assistant converses (it decides what you meant)', () => {
  const sourcesOf = (user: string): string => user.slice(user.indexOf('Sources so far:'))

  it('answers a casual message as a person would, with nothing to capture', async () => {
    const e = await setup(() => ({
      action: 'answer',
      answer: 'Glad it helped. Shout if the cutover gets worse.',
      cited: []
    }))
    try {
      const [user, reply] = await e.assistant.send('thanks, that helped')
      expect(user.role).toBe('user')
      expect(reply.content).toMatch(/Glad it helped/)
      expect(reply.proposals).toEqual([])
      expect(reply.via).toBe('llm')
      expect(reply.followups).toEqual([])
      expect(e.calls).toHaveLength(1)
    } finally {
      await done(e)
    }
  })

  it('looks things up when it needs to, shows what it looked at, and cites notes', async () => {
    let n = 0
    const e = await setup(() =>
      ++n === 1
        ? {
            action: 'lookup',
            lookups: [
              { tool: 'search_notes', args: { query: 'firewall' } },
              { tool: 'list_tasks', args: { filter: 'open' } }
            ]
          }
        : {
            action: 'answer',
            answer: 'Sarah owns the firewall work [1].',
            cited: [1],
            followups: []
          }
    )
    try {
      const progress: string[] = []
      ;(e.assistant as unknown as { deps: { onProgress?: (l: string) => void } }).deps.onProgress =
        (l) => progress.push(l)
      const [, reply] = await e.assistant.send('who is on the firewall thing?')
      expect(e.calls).toHaveLength(2)
      expect(sourcesOf(e.calls[1].user)).toMatch(/Cutover moves to December 4/)
      expect(reply.content).toContain('Sarah owns')
      expect(reply.notice).toMatch(/^Looked at .*notes/)
      expect(reply.citations.some((c) => c.title === 'NextMRO sync')).toBe(true)
      expect(progress.some((p) => /Searching your notes/.test(p))).toBe(true)
    } finally {
      await done(e)
    }
  })

  it('stops looking after the step limit and answers with what it has', async () => {
    const e = await setup((r) =>
      /do all the lookups|Answer now/.test(r.user)
        ? { action: 'answer', answer: 'Here is what I could find.', cited: [] }
        : {
            action: 'lookup',
            lookups: [{ tool: 'search_notes', args: { query: String(Math.random()) } }]
          }
    )
    try {
      const [, reply] = await e.assistant.send('tell me everything')
      expect(reply.content).toBe('Here is what I could find.')
      expect(e.calls.length).toBeLessThanOrEqual(3) // Standard allows two rounds of lookups
    } finally {
      await done(e)
    }
  })

  it('Quick mode never looks things up', async () => {
    const e = await setup(
      () => ({
        action: 'lookup',
        lookups: [{ tool: 'calendar', args: {} }],
        answer: 'Here you go.'
      }),
      { mode: 'light' }
    )
    try {
      const [, reply] = await e.assistant.send('what is on today?')
      expect(e.calls).toHaveLength(1)
      expect(e.calls[0].system).toContain('You have no lookup tools')
      expect(reply.content).toBe('Here you go.')
    } finally {
      await done(e)
    }
  })

  it('a pile of to-dos gets an offer, not cards; the button then creates cards to approve', async () => {
    const e = await setup((r) =>
      /Plan the day|"tasks"/.test(r.system) &&
      /Sarah to update/.test(r.user) &&
      !/capture/.test(r.feature ?? '')
        ? {
            action: 'answer',
            answer: 'That reads like three to-dos.',
            cited: [],
            offer: { kind: 'tasks', label: 'Turn these into tasks' }
          }
        : {
            reply: 'Found one.',
            tasks: [
              { description: 'Update firewall rules', owner: 'Sarah', due_phrase: 'next Thursday' }
            ],
            notes: [],
            reminders: []
          }
    )
    try {
      const [, offer] = await e.assistant.send('Sarah to update firewall rules next Thursday')
      expect(offer.proposals).toEqual([])
      expect(offer.followups[0]).toBe('Turn these into tasks::capture:')
      const [cards] = await e.assistant.send(
        'Sarah to update firewall rules next Thursday',
        'capture',
        true
      )
      expect(cards.proposals[0]).toMatchObject({
        kind: 'task',
        owner: 'Me',
        description: 'Follow up with Sarah Chen: Update firewall rules'
      })
      expect(e.vault.listTasks().some((t) => t.description.includes('firewall'))).toBe(false)
    } finally {
      await done(e)
    }
  })

  it('"/note" still goes straight to capture', async () => {
    const e = await setup(() => ({
      reply: 'ok',
      tasks: [{ description: 'Call Priya' }],
      notes: [],
      reminders: []
    }))
    try {
      const [, reply] = await e.assistant.send('/note call Priya')
      expect(reply.proposals[0]).toMatchObject({ kind: 'task' })
    } finally {
      await done(e)
    }
  })

  it("speaks in the chosen persona's own voice, and a shorter one in Quick mode", async () => {
    const mk = async (persona: string, mode?: string): Promise<string> => {
      const e = await setup(() => ({ action: 'answer', answer: 'ok', cited: [] }), {
        mode,
        persona
      })
      try {
        await e.assistant.send('hey')
        return e.calls[0].system
      } finally {
        await done(e)
      }
    }
    expect(await mk('rook')).toContain('You are Rook, dry and blunt')
    expect(await mk('pip')).toContain('You are Pip')
    expect(await mk('sage')).not.toContain('You are Pip')
    expect(await mk('rook', 'light')).toContain('Rook: dry, blunt')
    expect(await mk('rook', 'light')).not.toContain('You are Rook, dry and blunt')
  })

  it('keeps the conversation: earlier turns are in the prompt', async () => {
    const e = await setup(() => ({ action: 'answer', answer: 'About Friday.', cited: [] }))
    try {
      await e.assistant.send('when is the cutover?')
      await e.assistant.send('and who owns it?')
      expect(e.calls[1].user).toContain('Earlier in this chat')
      expect(e.calls[1].user).toContain('when is the cutover?')
    } finally {
      await done(e)
    }
  })

  it('part way failure reports what was found instead of erroring', async () => {
    let n = 0
    const e = await setup(() => {
      if (++n === 1)
        return {
          action: 'lookup',
          lookups: [{ tool: 'search_notes', args: { query: 'firewall' } }]
        }
      throw new LlmUnavailable('busy', 'rate limited')
    })
    try {
      const [, reply] = await e.assistant.send('what is happening with the firewall?')
      expect(reply.via).toBe('local')
      expect(reply.content).toMatch(/firewall/i)
    } finally {
      await done(e)
    }
  })
})

describe("automatic messages are written in the persona's voice", () => {
  const cand = {
    key: 'brief:2026-11-13',
    trigger: 'brief' as const,
    title: 'Rook: today',
    body: 'Morning. 2 tasks today. Procrastination will not reduce the count.',
    purpose: 'A morning heads-up.',
    facts: 'Due today: Update firewall rules; Send deck\nMeetings today: 09:00 NextMRO Weekly',
    chips: [],
    urgent: false
  }
  type Composer = { compose: (c: typeof cand, persona: string, day: string) => Promise<string> }

  it("uses the model with the persona's voice and the facts, and falls back to the fixed phrase", async () => {
    const e = await setup(() => ({
      message:
        'Two things today and one of them is late. Do the firewall rules before the 9:00 and you may keep your evening.'
    }))
    try {
      const text = await (e.assistant as unknown as Composer).compose(cand, 'rook', '2026-11-13')
      expect(text).toMatch(/firewall rules/)
      expect(e.calls[0].system).toContain('You are Rook, dry and blunt')
      expect(e.calls[0].user).toContain('Update firewall rules')
      expect(e.calls[0].tier).toBe('extract')
    } finally {
      await done(e)
    }
    const off = await setup(() => {
      throw new LlmUnavailable('no-key', 'no key')
    })
    try {
      expect(await (off.assistant as unknown as Composer).compose(cand, 'rook', '2026-11-13')).toBe(
        cand.body
      )
    } finally {
      await done(off)
    }
  })

  it('stops spending after a small daily cap', async () => {
    const e = await setup(() => ({ message: 'Model words that are long enough.' }))
    try {
      const c = e.assistant as unknown as Composer
      for (let i = 0; i < 12; i++) await c.compose({ ...cand, key: 'k' + i }, 'nova', '2026-11-13')
      expect(await c.compose({ ...cand, key: 'k13' }, 'nova', '2026-11-13')).toBe(cand.body)
      expect(e.calls).toHaveLength(12)
    } finally {
      await done(e)
    }
  })
})
