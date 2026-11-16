import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from '../vault/vault'
import { makeSources } from './sources'
import { todayIn } from '../../shared/tz'

describe('action sources', () => {
  it('build plain-text context from real notes, flag CUI notes, and never leak frontmatter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-src-'))
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    const today = todayIn(undefined)
    const note = (file: string, id: string, extra: string, body: string): void =>
      writeFileSync(
        join(root, 'notes', '2026', file),
        `---\nid: "${id}"\ntitle: "${file}"\ntype: "meeting"\ndate: "${today}"\n${extra}---\n\n${body}\n`
      )
    note(
      'open.md',
      '01JSRC0000000000000000001',
      'account: "Navy"\n',
      'Sarah Chen owns the cutover.\n- [ ] Update firewall rules | @Me | due:' + today
    )
    note('secret.md', '01JSRC0000000000000000002', 'tags: [CUI]\n', 'Restricted.')
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.upsertRegistryEntry('person', 'Sarah Chen', [])
    await vault.init()
    try {
      const src = makeSources({ db, vault: () => vault, zone: () => undefined })

      const n = await src.note('notes/2026/open.md')
      expect(n).toMatchObject({ title: 'open.md' })
      expect(n!.body).toContain('Sarah Chen owns the cutover')
      expect(n!.body).not.toContain('01JSRC') // frontmatter is never part of the context
      expect(await src.note('notes/2026/missing.md')).toBeNull()
      expect(await src.note('../../etc/passwd')).toBeNull()

      const day = src.day().text
      expect(day).toContain(`Today is ${today}`)
      expect(day).toContain('Update firewall rules')
      expect(day).toContain('No meetings today')

      const w = src.week()
      expect(w.markdown).toContain('meeting')
      expect(w.label).toMatch(/–/)

      const e = src.entity('person:sarah chen')
      expect(e?.name).toBe('Sarah Chen')
      expect(e?.text).toContain('open.md')
    } finally {
      await vault.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
