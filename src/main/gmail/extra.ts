import type { Db } from '../db'
import type { Vault } from '../vault/vault'
import { overview, type GmailOverview, type LabelHandler, type OverviewExtra } from './sync'

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** What the importance score needs to know about you: the people and work you have listed. */
export function mailExtra(
  vault: Vault | null,
  s: { meAliases: string[]; gmailImportance?: 'balanced' | 'strict' }
): OverviewExtra {
  const people = new Set<string>()
  const topics: string[] = []
  if (vault) {
    try {
      for (const v of vault.vocabulary()) {
        if (v.category === 'person')
          for (const t of [v.name, ...v.terms]) people.add(t.toLowerCase())
        else if (['customer', 'system', 'project'].includes(v.category))
          for (const t of [v.name, ...v.terms]) if (t.length >= 3) topics.push(t)
      }
    } catch {
      /* the vault is still starting: score without it */
    }
  }
  const re = topics.length
    ? new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${[...new Set(topics)].slice(0, 300).map(esc).join('|')})(?![\\p{L}\\p{N}])`,
        'iu'
      )
    : null
  return {
    knownPerson: (name) => !!name && people.has(name.toLowerCase()),
    topic: (text) => !!re && re.test(text),
    meAliases: s.meAliases,
    mode: s.gmailImportance ?? 'balanced'
  }
}

/** The mail overview, scored with what is known about you. */
export function smartOverview(
  db: Db,
  vault: Vault | null,
  s: {
    gmailLabels: Record<string, LabelHandler>
    meAliases: string[]
    gmailImportance?: 'balanced' | 'strict'
  }
): GmailOverview {
  return overview(db, s.gmailLabels, new Date(), 48, mailExtra(vault, s))
}
