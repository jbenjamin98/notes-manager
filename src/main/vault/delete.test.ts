import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db'
import { Vault } from './vault'

const dirs: string[] = []
const vaults: Vault[] = []
afterEach(async () => {
  while (vaults.length) await vaults.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const note = (root: string, n: string, id: string, body: string): void =>
  writeFileSync(
    join(root, 'notes', '2026', n),
    `---\nid: "${id}"\ntitle: "T ${n}"\ntype: "meeting"\ndate: "2026-11-02"\n---\n\n${body}\n`
  )

describe('deleting notes and names', () => {
  it('a deleted note goes to the trash function and leaves the index and its tasks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-del-'))
    dirs.push(root)
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    note(root, 'a.md', '01DEL000000000000000000A01', '- [ ] Send the plan')
    note(root, 'b.md', '01DEL000000000000000000B02', 'Other')
    const db = openDb(':memory:')
    const vault = new Vault(db, root, () => ['Me'])
    await vault.init()
    vaults.push(vault)
    const bin = mkdtempSync(join(tmpdir(), 'nm-bin-'))
    dirs.push(bin)
    await vault.deleteNote('notes/2026/a.md', async (abs) => renameSync(abs, join(bin, 'a.md')))
    expect(existsSync(join(root, 'notes', '2026', 'a.md'))).toBe(false)
    expect(existsSync(join(bin, 'a.md'))).toBe(true)
    expect(vault.listNotes().map((n) => n.path)).toEqual(['notes/2026/b.md'])
    expect(vault.listTasks()).toHaveLength(0)
    await expect(vault.deleteNote('system/entities.json', async () => undefined)).rejects.toThrow()
  })

  it('a deleted name is no longer found in notes, and comes back when restored', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nm-hide-'))
    dirs.push(root)
    mkdirSync(join(root, 'notes', '2026'), { recursive: true })
    note(root, 'a.md', '01DEL000000000000000000C03', 'Ask @Zorblax and @Priya about #rollout')
    let hidden: string[] = []
    const db = openDb(':memory:')
    const vault = new Vault(
      db,
      root,
      () => ['Me'],
      undefined,
      () => hidden
    )
    await vault.init()
    vaults.push(vault)
    const names = (): string[] => vault.noteEntities('notes/2026/a.md').map((e) => e.name)
    expect(names()).toEqual(expect.arrayContaining(['Zorblax', 'Priya', 'rollout']))
    hidden = ['zorblax', 'rollout']
    await vault.reindexAll()
    expect(names()).toEqual(['Priya'])
    hidden = []
    await vault.reindexAll()
    expect(names()).toContain('Zorblax')
  })
})
