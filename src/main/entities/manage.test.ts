import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import {
  emptyRegistry,
  isNotSame,
  markNotSame,
  mergeEntries,
  moveEntry,
  parseRegistry,
  serializeRegistry,
  setAmbiguous,
  upsertEntry
} from './registry'
import { suggestDuplicates } from './dedupe'

describe('registry: categories, merge, move, different, ambiguous', () => {
  it('stores projects and places, and reads old files that lack them', () => {
    const old = parseRegistry('{"version":1,"people":[{"name":"Sarah Chen","aliases":[]}]}')
    expect(old.projects).toEqual([])
    const reg = upsertEntry(
      upsertEntry(emptyRegistry(), 'project', 'Cutover', ['Go-live']),
      'place',
      'Norfolk',
      []
    )
    const round = parseRegistry(serializeRegistry(reg))
    expect(round.projects).toEqual([{ name: 'Cutover', aliases: ['Go-live'] }])
    expect(round.places).toEqual([{ name: 'Norfolk', aliases: [] }])
  })

  it('merges duplicates: names and aliases become aliases of the canonical entry', () => {
    let reg = upsertEntry(emptyRegistry(), 'person', 'Joe Cardone', ['JC'])
    reg = upsertEntry(reg, 'person', 'Joe C', ['Joey'])
    const merged = mergeEntries(reg, 'person', 'Joe Cardone', ['Joe C', 'Joe']) // "Joe" was only discovered in notes
    expect(merged.people).toEqual([
      {
        name: 'Joe Cardone',
        aliases: ['Joe', 'Joe C', 'Joey', 'JC'].sort((a, b) => a.localeCompare(b))
      }
    ])
    // Canonical that is not in the registry yet is created.
    const fresh = mergeEntries(emptyRegistry(), 'customer', 'Navy NextMRO', ['NextMRO'])
    expect(fresh.accounts).toEqual([{ name: 'Navy NextMRO', aliases: ['NextMRO'] }])
  })

  it('moves an entry between categories keeping its nicknames', () => {
    const reg = upsertEntry(emptyRegistry(), 'customer', 'Cutover', ['Go-live'])
    const moved = moveEntry(reg, 'customer', 'project', 'Cutover')
    expect(moved.accounts).toEqual([])
    expect(moved.projects).toEqual([{ name: 'Cutover', aliases: ['Go-live'] }])
  })

  it('remembers pairs that are different, and drops them when one side is merged away', () => {
    let reg = markNotSame(emptyRegistry(), 'Joe Cardone', 'Joe Smith')
    expect(isNotSame(reg, 'joe smith', 'JOE CARDONE')).toBe(true)
    reg = markNotSame(reg, 'Joe Smith', 'Joe Cardone') // duplicate pair is stored once
    expect(reg.notSame).toHaveLength(1)
    reg = mergeEntries(
      upsertEntry(upsertEntry(reg, 'person', 'Joe Smith', []), 'person', 'Joseph Smith', []),
      'person',
      'Joseph Smith',
      ['Joe Smith']
    )
    expect(reg.notSame).toEqual([])
  })

  it('suggests likely duplicates but never pairs the user said are different', () => {
    const ents = [
      { category: 'person', name: 'Joe Cardone', aliases: [], notes: 9 },
      { category: 'person', name: 'Joe C', aliases: [], notes: 2 },
      { category: 'person', name: 'Joe', aliases: [], notes: 5 },
      { category: 'person', name: 'Priya Nair', aliases: [], notes: 3 },
      { category: 'customer', name: 'Navy NextMRO', aliases: [], notes: 8 },
      { category: 'customer', name: 'NextMRO', aliases: [], notes: 3 },
      { category: 'system', name: 'Jira', aliases: [], notes: 4 }
    ]
    const s = suggestDuplicates(ents, emptyRegistry())
    const has = (a: string, b: string): boolean =>
      s.some((x) => x.names.includes(a) && x.names.includes(b))
    expect(has('Joe Cardone', 'Joe C')).toBe(true)
    expect(
      s.find((x) => x.names.includes('Joe Cardone') && x.names.includes('Joe C'))!.score
    ).toBeGreaterThan(0.75)
    const bare = s.find((x) => x.names.includes('Joe') && x.names.includes('Joe Cardone'))!
    expect(bare.ambiguous).toBe(true) // a bare first name may be someone else
    expect(has('Navy NextMRO', 'NextMRO')).toBe(true)
    expect(has('Priya Nair', 'Joe')).toBe(false)
    expect(has('Jira', 'NextMRO')).toBe(false)
    const hidden = suggestDuplicates(ents, markNotSame(emptyRegistry(), 'Joe Cardone', 'Joe C'))
    expect(hidden.some((x) => x.names.includes('Joe Cardone') && x.names.includes('Joe C'))).toBe(
      false
    )
  })

  it('an ambiguous name never links to anyone on its own, but the full names still do', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-amb-'))
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    writeFileSync(
      join(root, 'notes', '2026', 'a.md'),
      '---\nid: "01JAMB0000000000000000001"\ntitle: "Sync"\ntype: "meeting"\ndate: "2026-11-13"\n---\n\nJoe Cardone joined. Later Joe said hello. Joe Smith left.\n'
    )
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.upsertRegistryEntry('person', 'Joe Cardone', ['Joe'])
    await vault.upsertRegistryEntry('person', 'Joe Smith', [])
    await vault.init()
    try {
      const mentions = (): number =>
        vault.listEntities().find((e) => e.name === 'Joe Cardone')?.mentions ?? 0
      expect(mentions()).toBe(3) // the full name, plus the alias "Joe" twice (once inside "Joe Smith": the problem)
      await vault.updateRegistry((r) => setAmbiguous(r, 'Joe', true))
      expect(mentions()).toBe(1) // only the full name now
      expect(vault.listEntities().find((e) => e.name === 'Joe Smith')?.mentions).toBe(1)
    } finally {
      await vault.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
