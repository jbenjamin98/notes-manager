import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { analyze, foldPlurals, tokenize, weeklyBuckets } from './store'

const note = (id: string, title: string, date: string, extra: string, body: string): string =>
  `---\nid: "${id}"\ntitle: "${title}"\ntype: "meeting"\ndate: "${date}"\n${extra}---\n\n${body}\n`

describe('entity pipeline (real vault + SQLite)', () => {
  it('extracts, resolves aliases via the registry, builds dossiers and insights', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-ent-'))
    try {
      mkdirSync(join(root, 'notes', '2026'), { recursive: true })
      const w = (f: string, c: string): void => writeFileSync(join(root, 'notes', '2026', f), c)
      w(
        '2026-11-05-a.md',
        note(
          '01JENT0000000000000000000A',
          'Cutover planning',
          '2026-11-05',
          'account: "NextMRO"\nattendees: ["Jacob Benjamin", "Sarah"]\n',
          'Staging firewall rules are the blocker. #latency\n- [ ] Verify firewall | @Sarah | due:2026-11-17'
        )
      )
      w(
        '2026-11-12-b.md',
        note(
          '01JENT0000000000000000000B',
          'Rate limits',
          '2026-11-12',
          'account: "Navy NextMRO"\n',
          'Staging firewall again. Ask @Joe about limits. #latency\n- [ ] Share list | @Joe'
        )
      )
      const db = openDb(':memory:')
      const vault = new Vault(db, root, () => ['Me', 'Jacob'])
      await vault.init()
      try {
        // Before the registry: "Sarah" and "Joe" are discovered people, "Jacob" never is.
        let ents = vault.listEntities()
        expect(ents.find((e) => e.name === 'Sarah')).toMatchObject({
          category: 'person',
          notes: 1,
          inRegistry: false
        })
        expect(ents.find((e) => e.name === 'Joe')).toMatchObject({ notes: 1 })
        expect(ents.some((e) => /jacob/i.test(e.name))).toBe(false)
        expect(ents.find((e) => e.name === 'latency')).toMatchObject({
          category: 'topic',
          notes: 2
        })
        // Two spellings of the account are two entities until the registry merges them.
        expect(
          ents
            .filter((e) => e.category === 'customer')
            .map((e) => e.name)
            .sort()
        ).toEqual(['NextMRO', 'Navy NextMRO'].sort())

        // Curate: merge the account spellings, name Sarah, add a system.
        await vault.upsertRegistryEntry('customer', 'Navy NextMRO', ['NextMRO'])
        await vault.upsertRegistryEntry('person', 'Sarah Chen', ['Sarah'])
        await vault.upsertRegistryEntry('system', 'Staging Environment', ['Staging'])
        await vault.upsertRegistryEntry('system', 'Vault', []) // zero mentions: still listed

        ents = vault.listEntities()
        expect(ents.filter((e) => e.category === 'customer')).toHaveLength(1)
        expect(ents.find((e) => e.name === 'Navy NextMRO')).toMatchObject({
          notes: 2,
          inRegistry: true
        })
        expect(ents.find((e) => e.name === 'Sarah Chen')).toMatchObject({
          notes: 1,
          inRegistry: true
        })
        expect(ents.some((e) => e.name === 'Sarah')).toBe(false)
        expect(ents.find((e) => e.name === 'Staging Environment')).toMatchObject({ notes: 2 })
        expect(ents.find((e) => e.name === 'Vault')).toMatchObject({ notes: 0, inRegistry: true })

        // The registry file is plain, sorted JSON in the vault.
        const file = readFileSync(join(root, 'system', 'entities.json'), 'utf8')
        expect(JSON.parse(file).systems.map((s: { name: string }) => s.name)).toEqual([
          'Staging Environment',
          'Vault'
        ])

        // Dossier: newest first, snippet from the matching line, 12 weekly buckets.
        const d = vault.entityDossier('system:staging environment')!
        expect(d.aliases).toEqual(['Staging'])
        expect(d.notes.map((n) => n.title)).toEqual(['Rate limits', 'Cutover planning'])
        expect(d.notes[0].snippet).toContain('Staging firewall again')
        expect(d.weeks).toHaveLength(12)
        expect(d.totalNotes).toBe(2)

        // Insights: words (no stopwords, ids or @people), and co-occurrence edges.
        const ins = vault.insights(null)
        expect(ins.notes).toBe(2)
        const words = ins.words.map((x) => x.word)
        expect(words).toContain('firewall')
        expect(words).not.toContain('the')
        expect(words.some((x) => /^t[a-z0-9]{6}$/.test(x))).toBe(false)
        expect(words).not.toContain('sarah')
        const edge = ins.edges.find(
          (e) =>
            [e.a, e.b].includes('system:staging environment') &&
            [e.a, e.b].includes('topic:latency')
        )
        expect(edge?.weight).toBe(2)

        // Someone edits the registry file by hand (or Drive delivers it): re-extract everything.
        writeFileSync(
          join(root, 'system', 'entities.json'),
          JSON.stringify({ version: 1, people: [{ name: 'Joe Park', aliases: ['Joe'] }] })
        )
        await (
          vault as unknown as { onRegistryFileChanged(): Promise<void> }
        ).onRegistryFileChanged()
        ents = vault.listEntities()
        expect(ents.find((e) => e.name === 'Joe Park')).toMatchObject({
          notes: 1,
          inRegistry: true
        })
        expect(ents.some((e) => e.name === 'Staging Environment')).toBe(false)
        expect(ents.find((e) => e.name === 'Sarah')).toBeDefined() // back to discovered
      } finally {
        await vault.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('tokenizes without ids, tags, mentions, urls or stop words; buckets weeks Monday-first', () => {
    expect(
      tokenize(
        'See https://x.io/a about the @Sarah #latency firewall ^tabc123 due:2026-11-17 firewall Rollout'
      )
    ).toEqual(['firewall', 'firewall', 'rollout'])
    // Fri 13 Nov 2026 -> weeks start Mondays: ... Nov 2, Nov 9. A note on Tue Nov 10 lands in Nov 9's week.
    const b = weeklyBuckets(
      ['2026-11-10', '2026-11-13', '2026-11-03', '2025-01-01'],
      new Date(2026, 10, 13),
      3
    )
    expect(b).toEqual([
      { weekStart: '2026-10-26', notes: 0 },
      { weekStart: '2026-11-02', notes: 1 },
      { weekStart: '2026-11-09', notes: 2 }
    ])
  })
})

describe('word cloud filtering', () => {
  it('drops filler, boilerplate and people, folds plurals, and ranks distinctive words first', () => {
    const db = openDb(':memory:')
    db.prepare(
      "INSERT INTO entities (id,name,category,in_registry) VALUES ('person:sarah chen','Sarah Chen','person',1)"
    ).run()
    const ins = db.prepare(
      "INSERT INTO notes (id,file_path,title,type,date,body_text) VALUES (?,?,?,'meeting','2026-11-10',?)"
    )
    for (let i = 0; i < 10; i++) {
      const extra = i < 4 ? ' cutover firewall rules' : i < 6 ? ' firewall rule' : ''
      // "agenda" is in every note (template boilerplate); "really/think/update" are filler; Sarah is a person.
      ins.run(
        'n' + i,
        'notes/2026/n' + i + '.md',
        'N' + i,
        'agenda really think update Sarah Chen discussed' + extra
      )
    }
    const words = analyze(db, null, new Date(2026, 10, 13)).words.map((w) => w.word)
    expect(words).toContain('firewall')
    expect(words).toContain('cutover')
    expect(words).toContain('rule') // "rules" folded into "rule"
    expect(words).not.toContain('rules')
    for (const bad of ['agenda', 'really', 'think', 'update', 'sarah', 'chen', 'discussed'])
      expect(words).not.toContain(bad)
    expect(words.indexOf('firewall')).toBeLessThan(words.indexOf('cutover') + 1)
  })

  it('folds plurals only when both forms exist', () => {
    const m = new Map([
      ['rule', { count: 2, notes: 2 }],
      ['rules', { count: 3, notes: 3 }],
      ['status', { count: 4, notes: 2 }]
    ])
    foldPlurals(m)
    expect([...m.keys()].sort()).toEqual(['rule', 'status'])
    expect(m.get('rule')).toEqual({ count: 5, notes: 3 })
  })
})
