import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { ingestChat } from '../chat/ingest'
import type { JsonGenerator } from '../assistant/assistant'
import type { Candidate } from './types'
import {
  type PipelineDeps,
  insightsFromChat,
  insightsFromEmail,
  insightsFromMeeting,
  mergeCandidates
} from './pipeline'
import { getInsight, insightsFor, listInsights, setStatus } from './store'

const NOW = new Date('2026-11-14T15:00:00Z')
const ago = (h: number): string =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)
const deps = (db: ReturnType<typeof openDb>, llm: JsonGenerator | null = null): PipelineDeps => ({
  db,
  llm,
  me: () => ['Me', 'Jacob'],
  now: () => NOW
})

describe('insight pipeline', () => {
  it('chat: finds an ask, keeps the source, and does not read an unchanged conversation twice', async () => {
    const db = openDb(':memory:')
    ingestChat(db, [
      {
        id: '1',
        space: 'dm:Priya',
        spaceName: 'Direct message',
        spaceType: 'dm',
        sender: 'Priya',
        senderId: 'u',
        text: 'Can you send me the budget numbers by Friday?',
        createdAt: ago(5),
        thread: null,
        mentionsMe: false,
        fromMe: false
      }
    ])
    expect(await insightsFromChat(deps(db))).toBe(1)
    const [i] = listInsights(db)
    expect(i).toMatchObject({ kind: 'ask', owner: 'Me', sourceType: 'chat' })
    expect(i.sourceLabel).toMatch(/^Chat · Priya · /)
    expect(i.sourceRef.space).toBe('dm:Priya')
    expect(await insightsFromChat(deps(db))).toBe(0) // same text: nothing re-read
  })

  it('meeting notes: decisions, actions and the person facts link to known names', async () => {
    const db = openDb(':memory:')
    db.prepare(
      "INSERT INTO entities (id, name, category, in_registry) VALUES ('p1','Sarah Chen','person',1)"
    ).run()
    const n = await insightsFromMeeting(deps(db), {
      eventId: 'ev1',
      title: 'NextMRO sync',
      date: '2026-11-12',
      notePath: 'notes/2026/x.md',
      fileId: 'F1',
      text: `## Notes\n- We decided to move the cutover to December 4.\n- Sarah Chen will send the revised plan by Friday.`
    })
    expect(n).toBe(2)
    const kinds = listInsights(db)
      .map((i) => i.kind)
      .sort()
    expect(kinds).toEqual(['action', 'decision'])
    expect(insightsFor(db, 'Sarah Chen')).toHaveLength(1)
    expect(listInsights(db)[0].sourceRef.eventId).toBe('ev1')
  })

  it('the same thing said in two places is one insight; dismissed ones stay gone', async () => {
    const db = openDb(':memory:')
    const m = (fileId: string): Parameters<typeof insightsFromMeeting>[1] => ({
      eventId: null,
      title: 'Sync',
      date: '2026-11-12',
      notePath: null,
      fileId,
      text: 'Sarah will send the revised plan by Friday.'
    })
    await insightsFromMeeting(deps(db), m('A'))
    await insightsFromMeeting(deps(db), {
      ...m('B'),
      text: 'Sarah will send the revised plan by Friday!!'
    })
    expect(listInsights(db)).toHaveLength(1)
    setStatus(db, listInsights(db)[0].id, 'dismissed')
    await insightsFromMeeting(deps(db), {
      ...m('C'),
      text: 'Sarah will send the revised plan by Friday ok'
    })
    expect(listInsights(db, 'new')).toHaveLength(0)
  })

  it('email: reads the body but stores only the insight, a short snippet and the ids', async () => {
    const db = openDb(':memory:')
    const body = `Hi Jacob,\n\nPlease send the signed SOW back by Thursday. ${'Long boilerplate sentence here. '.repeat(40)}\n\nThanks`
    expect(
      await insightsFromEmail(deps(db), {
        threadId: 't1',
        subject: 'SOW approval',
        at: '2026-11-13T10:00:00Z',
        from: 'Dana',
        body
      })
    ).toBeGreaterThan(0)
    const [i] = listInsights(db)
    expect(i.sourceSnippet.length).toBeLessThanOrEqual(300)
    expect(JSON.stringify(db.prepare('SELECT * FROM insights').all())).not.toContain(
      'boilerplate sentence here. Long'
    )
    expect(getInsight(db, i.id)?.sourceRef.threadId).toBe('t1')
  })

  it('a model finds paraphrase the rules miss; if it fails the rules still work', async () => {
    const db = openDb(':memory:')
    const llm: JsonGenerator = {
      generateJson: (async () => ({
        data: {
          items: [
            {
              kind: 'decision',
              text: 'The rollout will use the simpler first option.',
              owner: null,
              due_phrase: null,
              confidence: 0.8,
              evidence: 'keep it simple'
            }
          ]
        },
        provider: 'gemini',
        model: 'x',
        cached: false
      })) as JsonGenerator['generateJson']
    }
    const text =
      'Sarah will send the plan by Friday. Honestly I would keep it simple and take the first one for the rollout, everyone nodded.'
    await insightsFromMeeting(deps(db, llm), {
      eventId: null,
      title: 'T',
      date: '2026-11-12',
      notePath: null,
      fileId: 'M1',
      text
    })
    expect(
      listInsights(db).some((i) => i.kind === 'decision' && /simpler first option/.test(i.text))
    ).toBe(true)

    const db2 = openDb(':memory:')
    const broken: JsonGenerator = {
      generateJson: (async () => {
        throw new Error('no key')
      }) as JsonGenerator['generateJson']
    }
    await insightsFromMeeting(deps(db2, broken), {
      eventId: null,
      title: 'T',
      date: '2026-11-12',
      notePath: null,
      fileId: 'M2',
      text
    })
    expect(listInsights(db2).some((i) => i.kind === 'action')).toBe(true)
  })

  it('merging keeps model items and adds only confident rule items the model missed', () => {
    const c = (kind: 'action' | 'risk', text: string, confidence: number): Candidate => ({
      kind,
      text,
      owner: null,
      due: null,
      confidence,
      evidence: text
    })
    const merged = mergeCandidates(
      [c('action', 'Send the plan to legal', 0.8)],
      [
        c('action', 'send the plan to legal today', 0.7),
        c('risk', 'Vendor has not confirmed', 0.75),
        c('risk', 'weak maybe', 0.5)
      ]
    )
    expect(merged.map((m) => m.text)).toEqual([
      'Send the plan to legal',
      'Vendor has not confirmed'
    ])
  })
})
