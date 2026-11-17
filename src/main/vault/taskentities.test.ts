import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from './vault'

describe('a task is mine and lists what it is about', () => {
  it('links people, companies, places, projects and systems named in the wording', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-taskent-'))
    try {
      const vault = new Vault(openDb(':memory:'), root, () => ['Me'])
      await vault.upsertRegistryEntry('person', 'John Smith', [])
      await vault.upsertRegistryEntry('customer', 'Acme', [])
      await vault.upsertRegistryEntry('place', 'Denver', [])
      await vault.upsertRegistryEntry('project', 'Atlas', [])
      await vault.upsertRegistryEntry('system', 'Okta', [])
      await vault.init()
      const now = new Date(2026, 10, 13, 9, 0, 0)
      await vault.addInboxTask(
        'Complete the onboarding documentation for @John Smith at @Acme in @Denver for @Atlas on @Okta',
        now
      )
      const t = vault.listTasks()[0]
      expect(t.owner).toBe('Me')
      expect(t.isMine).toBe(true)
      expect(t.entities?.map((e) => `${e.category}:${e.name}`).sort()).toEqual([
        'customer:Acme',
        'person:John Smith',
        'place:Denver',
        'project:Atlas',
        'system:Okta'
      ])
      await vault.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
