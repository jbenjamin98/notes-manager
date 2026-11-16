import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { bareMentions, reviewQueue } from './review'
import { setFrontmatterMention } from '../vault/edit'
import { applyMentions } from '../vault/indexer'

const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const note = (id: string, title: string, body: string): string =>
  `---\nid: "${id}"\ntitle: "${title}"\ntype: "meeting"\ndate: "2026-11-10"\n---\n\n${body}\n`

async function setup(): Promise<{ vault: Vault; db: ReturnType<typeof openDb>; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'nm-review-'))
  dirs.push(root)
  mkdirSync(join(root, 'notes', '2026'), { recursive: true })
  mkdirSync(join(root, 'system'), { recursive: true })
  writeFileSync(
    join(root, 'system', 'entities.json'),
    JSON.stringify({
      people: [
        { name: 'Jacob Anderson', aliases: [] },
        { name: 'Jacob Brooks', aliases: [] }
      ]
    })
  )
  const w = (f: string, c: string): void => writeFileSync(join(root, 'notes', '2026', f), c)
  w('a.md', note('01REVIEW00000000000000000A', 'Infra sync', 'Jacob will check the firewall.'))
  w('b.md', note('01REVIEW00000000000000000B', 'Budget', 'Ask Jacob about the numbers.'))
  w('c.md', note('01REVIEW00000000000000000C', 'Kickoff', 'Jacob Anderson joined.'))
  const db = openDb(':memory:')
  const vault = new Vault(db, root, () => ['Me'])
  await vault.init()
  closers.push(() => vault.close())
  return { vault, db, root }
}

describe('Review People: Jacob A. or Jacob B.?', () => {
  it('finds bare mentions only (not "Jacob Anderson")', () => {
    expect(bareMentions('Jacob will check. Jacob Anderson joined.', 'Jacob').count).toBe(1)
    expect(bareMentions('Talked to Jacob about it', 'Jacob').snippet).toContain('Talked to Jacob')
  })

  it('stores the choice in the note and reads it when finding people', () => {
    const c = note('x', 'T', 'Jacob said hi')
    const set = setFrontmatterMention(c, 'Jacob', 'Jacob Brooks')
    expect(set).toContain('mentions: {"Jacob":"Jacob Brooks"}')
    expect(setFrontmatterMention(set, 'Jacob', null)).not.toContain('mentions')
    expect(applyMentions('Jacob said hi to Jacob Anderson', { Jacob: 'Jacob Brooks' })).toBe(
      'Jacob Brooks said hi to Jacob Anderson'
    )
  })

  it('queues every unresolved "Jacob", and assigning removes it from the queue', async () => {
    const { vault, db, root } = await setup()
    const read = async (p: string): Promise<string> => (await vault.readNote(p)).content
    let q = await reviewQueue(db, vault.currentRegistry(), read)
    const g = q.find((x) => x.short === 'Jacob')!
    expect(g.candidates.map((c) => c.name).sort()).toEqual(['Jacob Anderson', 'Jacob Brooks'])
    expect(g.mentions.map((m) => m.title).sort()).toEqual(['Budget', 'Infra sync'])

    const infra = g.mentions.find((m) => m.title === 'Infra sync')!.path
    await vault.setMention([infra], 'Jacob', 'Jacob Brooks')
    expect(readFileSync(join(root, infra), 'utf8')).toContain('"Jacob":"Jacob Brooks"')
    q = await reviewQueue(db, vault.currentRegistry(), read)
    expect(q.find((x) => x.short === 'Jacob')!.mentions.map((m) => m.title)).toEqual(['Budget'])
    // The note now links to Jacob Brooks.
    const linked = db
      .prepare(
        `SELECT e.name FROM note_entities ne JOIN entities e ON e.id = ne.entity_id JOIN notes n ON n.id = ne.note_id WHERE n.file_path = ?`
      )
      .all(infra) as { name: string }[]
    expect(linked.map((r) => r.name)).toContain('Jacob Brooks')
  })
})

describe('a tagged @Jacob stays in the review queue', () => {
  it('is listed for review, makes no stray "Jacob" person, and an assignment resolves it', async () => {
    const { vault, db, root } = await setup()
    writeFileSync(
      join(root, 'notes', '2026', 'd.md'),
      note('01REVIEW00000000000000000D', 'Standup', 'Asked @Jacob to confirm the date.')
    )
    await vault.reindexAll()
    const read = async (p: string): Promise<string> => (await vault.readNote(p)).content
    const q = await reviewQueue(db, vault.currentRegistry(), read)
    const titles = q.find((x) => x.short === 'Jacob')!.mentions.map((m) => m.title)
    expect(titles).toContain('Standup')
    // Nobody called plain "Jacob" was invented from the tag.
    const stray = db
      .prepare("SELECT 1 FROM entities WHERE lower(name) = 'jacob' AND category = 'person'")
      .get()
    expect(stray).toBeUndefined()
    // Assigning it links the note to the right Jacob.
    const standup = q.find((x) => x.short === 'Jacob')!.mentions.find((m) => m.title === 'Standup')!
    await vault.setMention([standup.path], 'Jacob', 'Jacob Brooks')
    const linked = db
      .prepare(
        `SELECT e.name FROM note_entities ne JOIN entities e ON e.id = ne.entity_id JOIN notes n ON n.id = ne.note_id WHERE n.file_path = ?`
      )
      .all(standup.path) as { name: string }[]
    expect(linked.map((r) => r.name)).toContain('Jacob Brooks')
    const after = await reviewQueue(db, vault.currentRegistry(), read)
    expect(after.find((x) => x.short === 'Jacob')!.mentions.map((m) => m.title)).not.toContain(
      'Standup'
    )
  })
})

describe('shared names are not only people', () => {
  it('"Acme" is shared by a company and a system, so it waits for a review', async () => {
    const { vault, db } = await setup()
    await vault.upsertRegistryEntry('customer', 'Acme Corp', [])
    await vault.upsertRegistryEntry('system', 'Acme Portal', [])
    await vault.upsertRegistryEntry('customer', 'The Gap', [])
    await vault.upsertRegistryEntry('customer', 'The Bank', [])
    const { ambiguousNames } = await import('./review')
    const m = ambiguousNames(db, vault.currentRegistry())
    expect(
      m
        .get('Acme')
        ?.map((c) => `${c.category}:${c.name}`)
        .sort()
    ).toEqual(['customer:Acme Corp', 'system:Acme Portal'])
    expect(m.has('The')).toBe(false)
    const entry = vault.tagVocabulary().find((e) => e.review && e.terms.includes('Acme'))
    expect(entry?.category).toBe('customer')
  })
})
