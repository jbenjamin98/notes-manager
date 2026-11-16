import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { AutoTagger } from './autotag'
import type { JsonRequest, JsonResult } from '../llm/router'

const dirs: string[] = []
const vaults: Vault[] = []
afterEach(async () => {
  while (vaults.length) await vaults.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

async function setup(
  llm: (r: JsonRequest<unknown>) => unknown,
  tag: { enabled?: boolean; ai?: boolean; ignore?: string[] } = {}
): Promise<{ tagger: AutoTagger; vault: Vault; calls: JsonRequest<unknown>[] }> {
  const root = mkdtempSync(join(tmpdir(), 'nm-tag-'))
  dirs.push(root)
  mkdirSync(join(root, 'notes', '2026'), { recursive: true })
  const note = (n: string, id: string, body: string): void =>
    writeFileSync(
      join(root, 'notes', '2026', n),
      `---\nid: "${id}"\ntitle: "${n}"\ntype: "meeting"\ndate: "2026-11-10"\n---\n\n${body}\n`
    )
  // "cats" is a topic once it has been tagged in two notes.
  note('a.md', '01TAG000000000000000000A', 'Joe loves #cats a lot.')
  note('b.md', '01TAG000000000000000000B', 'More about #cats and #budget.')
  const db = openDb(':memory:')
  const vault = new Vault(db, root, () => ['Me', 'Jacob'])
  await vault.upsertRegistryEntry('person', 'Matt Rowe', ['Matt'])
  await vault.init()
  vaults.push(vault)
  const calls: JsonRequest<unknown>[] = []
  const tagger = new AutoTagger({
    db,
    vault: () => vault,
    llm: {
      async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
        calls.push(req as JsonRequest<unknown>)
        return {
          data: req.schema.parse(llm(req as JsonRequest<unknown>)),
          provider: 'gemini',
          model: 'fake',
          cached: false
        }
      }
    },
    settings: () => ({
      meAliases: ['Me', 'Jacob'],
      llm: { enabled: true },
      autoTag: { enabled: tag.enabled ?? true, ai: tag.ai ?? true, ignore: tag.ignore ?? [] }
    })
  })
  return { tagger, vault, calls }
}

describe('tagging text that is being saved', () => {
  it('"Tell Matt he likes cats" becomes "Tell @Matt he likes #cats" with no model needed', async () => {
    const { tagger, calls } = await setup(() => ({ tags: [] }))
    expect(await tagger.tagOnSubmit('Tell Matt he likes cats', { fast: true })).toBe(
      'Tell @Matt he likes #cats'
    )
    expect(calls).toHaveLength(0)
  })

  it('asks the model for new names and topics, checks them against the line, and adds new names to People', async () => {
    const { tagger, vault, calls } = await setup(() => ({
      tags: [
        { text: 'Rhea', kind: 'person' },
        { text: 'rollout', kind: 'topic' },
        { text: 'invented', kind: 'topic' },
        { text: 'Denver', kind: 'place' }
      ]
    }))
    const out = await tagger.tagOnSubmit('Ask Rhea about the rollout plan')
    expect(out).toBe('Ask @Rhea about the #rollout plan')
    expect(calls).toHaveLength(1)
    expect(calls[0].tier).toBe('extract')
    expect(vault.currentRegistry().people.map((p) => p.name)).toContain('Rhea')
  })

  it('without AI it still tags a name after a verb ("Tell Rhea") and learns it', async () => {
    const { tagger, vault, calls } = await setup(() => ({ tags: [] }), { ai: false })
    expect(await tagger.tagOnSubmit('Tell Rhea about the plan')).toBe('Tell @Rhea about the plan')
    expect(calls).toHaveLength(0)
    expect(vault.currentRegistry().people.map((p) => p.name)).toContain('Rhea')
  })

  it('does nothing when auto-tagging is off, and respects "never tag these words"', async () => {
    const off = await setup(() => ({ tags: [] }), { enabled: false })
    expect(await off.tagger.tagOnSubmit('Tell Matt he likes cats')).toBe('Tell Matt he likes cats')
    const some = await setup(() => ({ tags: [] }), { ignore: ['cats'] })
    expect(await some.tagger.tagOnSubmit('Tell Matt he likes cats', { fast: true })).toBe(
      'Tell @Matt he likes cats'
    )
  })

  it('suggest(): rejects made-up words, limits topics to four, and never tags your own name', async () => {
    const { tagger } = await setup(() => ({
      tags: [
        { text: 'plan', kind: 'topic' },
        { text: 'rollout', kind: 'topic' },
        { text: 'staging', kind: 'topic' },
        { text: 'budget', kind: 'topic' },
        { text: 'migration', kind: 'topic' },
        { text: 'Jacob', kind: 'person' },
        { text: 'Zed', kind: 'person' }
      ]
    }))
    const r = await tagger.suggest(
      'Jacob and I will ask about the plan rollout staging budget migration with Zed'
    )
    const texts = r.tags.map((t) => t.text)
    expect(texts).not.toContain('Jacob')
    expect(
      texts.filter((t) => ['plan', 'rollout', 'staging', 'budget', 'migration'].includes(t))
    ).toHaveLength(4)
    expect(texts).toContain('Zed')
    expect(r.via).toBe('llm')
  })

  it('a failing model falls back to the rules without an error', async () => {
    const { tagger } = await setup(() => {
      throw new Error('boom')
    })
    const r = await tagger.suggest('Tell Rhea about the new onboarding plan')
    expect(r.tags.map((t) => t.text)).toEqual(['Rhea'])
    expect(r.via).toBe('rules')
  })
})

describe('shared names are still tagged, and wait for a review', () => {
  it('"Ask Priya" is tagged @Priya when two people are called Priya, and flagged for review', async () => {
    const { tagger, vault } = await setup(() => ({ tags: [] }))
    await vault.upsertRegistryEntry('person', 'Priya Nair', [])
    await vault.upsertRegistryEntry('person', 'Priya Shah', [])
    const entry = vault.tagVocabulary().find((e) => e.review && e.terms.includes('Priya'))
    expect(entry).toMatchObject({ category: 'person', review: true })
    expect(await tagger.tagOnSubmit('Ask Priya about the plan', { fast: true })).toBe(
      'Ask @Priya about the plan'
    )
    // The full name still goes to the right person, with no review.
    expect(await tagger.tagOnSubmit('Ask Priya Shah today', { fast: true })).toBe(
      'Ask @Priya Shah today'
    )
  })

  it('never tags your own name, even if it is shared', async () => {
    const { tagger, vault } = await setup(() => ({ tags: [] }))
    await vault.upsertRegistryEntry('person', 'Jacob Anderson', [])
    await vault.upsertRegistryEntry('person', 'Jacob Brooks', [])
    expect(await tagger.tagOnSubmit('Ask Jacob about it', { fast: true })).toBe(
      'Ask Jacob about it'
    )
  })
})
