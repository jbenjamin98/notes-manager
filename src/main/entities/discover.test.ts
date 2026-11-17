import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { compileTagVocab } from '../../shared/autotag'
import { discoverTags, votedKinds } from './discover'

const dirs: string[] = []
const vaults: Vault[] = []
afterEach(async () => {
  while (vaults.length) await vaults.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('discovering names and topics that keep coming up', () => {
  it('suggests names in 3+ notes and uncommon words in 4+, never known or ignored ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-disc-'))
    dirs.push(root)
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    const bodies = [
      'We met with Zorblax about the cutover. The latency work continues.',
      'Call with Zorblax to review latency numbers. Also Matt joined.',
      'Then Zorblax asked about latency again in Lisbon.',
      'Notes on latency and the new dashboard. Talked to Kralupy folks.',
      'Contract from Zorblax arrived. Latency again.',
      'Quiet day. Nothing about anything.',
      'Plain note one.',
      'Plain note two.',
      'Plain note three.',
      'Plain note four.'
    ]
    bodies.forEach((b, i) =>
      writeFileSync(
        join(root, 'notes', '2026', `n${i}.md`),
        `---\nid: "01DISC0000000000000000${String(i).padStart(2, '0')}"\ntitle: "N${i}"\ntype: "meeting"\ndate: "2026-11-${String(i + 1).padStart(2, '0')}"\n---\n\n${b}\n`
      )
    )
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.upsertRegistryEntry('person', 'Matt Rowe', ['Matt'])
    await vault.init()
    vaults.push(vault)
    const known = compileTagVocab(vault.tagVocabulary())
    const out = discoverTags(db, known, { me: new Set(['me']), ignore: new Set() })
    expect(out.find((d) => d.text === 'Zorblax')).toMatchObject({ kind: 'person' })
    expect(out.some((d) => d.text === 'Matt')).toBe(false)
    expect(out.find((d) => d.text === 'latency')).toMatchObject({ kind: 'topic' })
    const ignored = discoverTags(db, known, { me: new Set(['me']), ignore: new Set(['zorblax']) })
    expect(ignored.some((d) => d.text === 'Zorblax')).toBe(false)
  })
})

describe('deciding the kind of a name from all its mentions', () => {
  it('the kind most mentions point to wins, not the weak guess from one line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-vote-'))
    dirs.push(root)
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    const bodies = [
      'Renewal talk: the Zorblax contract is up in March.',
      'Escalated the Zorblax escalation to legal.',
      'Had lunch with Zorblax on Friday.',
      'Plain note.'
    ]
    bodies.forEach((b, i) =>
      writeFileSync(
        join(root, 'notes', '2026', `v${i}.md`),
        `---
id: "01VOTE0000000000000000000${i}"
title: "V${i}"
type: "meeting"
date: "2026-11-0${i + 1}"
---

${b}
`
      )
    )
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.init()
    vaults.push(vault)
    const known = compileTagVocab(vault.tagVocabulary())
    expect(votedKinds(db, known, new Set(['me'])).zorblax).toBe('customer')
  })
})
