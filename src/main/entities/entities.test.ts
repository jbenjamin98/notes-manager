import { describe, it, expect } from 'vitest'
import {
  buildMatcher,
  emptyRegistry,
  parseRegistry,
  removeEntry,
  serializeRegistry,
  upsertEntry
} from './registry'
import { extractEntities } from './extract'

const registry = (): ReturnType<typeof emptyRegistry> => {
  let r = emptyRegistry()
  r = upsertEntry(r, 'person', 'Sarah Chen', ['Sarah', 'SC'])
  r = upsertEntry(r, 'customer', 'Navy NextMRO', ['NextMRO'])
  r = upsertEntry(r, 'system', 'Staging Environment', ['Staging'])
  return r
}

describe('registry', () => {
  it('upserts, renames, dedupes aliases, sorts, and round-trips stably', () => {
    let r = registry()
    r = upsertEntry(
      r,
      'person',
      'Sarah Chen-Lee',
      ['Sarah', 'sarah', 'Sarah Chen-Lee'],
      'Sarah Chen'
    )
    expect(r.people).toEqual([{ name: 'Sarah Chen-Lee', aliases: ['Sarah'] }])
    const text = serializeRegistry(r)
    expect(text.endsWith('\n')).toBe(true)
    expect(serializeRegistry(parseRegistry(text))).toBe(text) // stable => minimal Drive churn
    expect(removeEntry(r, 'person', 'sarah chen-lee').people).toEqual([])
  })
  it('never throws on a corrupt or half-synced file', () => {
    expect(parseRegistry('{ not json')).toEqual(emptyRegistry())
    expect(parseRegistry('{"people":"oops"}')).toEqual(emptyRegistry())
  })
})

describe('entity extraction', () => {
  const m = buildMatcher(registry(), ['Jacob'])
  const get = (
    xs: ReturnType<typeof extractEntities>,
    name: string
  ): ReturnType<typeof extractEntities>[number] | undefined => xs.find((e) => e.name === name)

  it('counts registry names and aliases whole-word, once per mention', () => {
    const r = extractEntities(
      {
        title: 'NextMRO sync',
        body: 'Staging is not ready. Ask @Sarah about staging.\nstagingarea is unrelated',
        attendees: [],
        account: null
      },
      m
    )
    expect(get(r, 'Navy NextMRO')).toMatchObject({
      category: 'customer',
      count: 1,
      inRegistry: true
    })
    expect(get(r, 'Staging Environment')?.count).toBe(2) // "Staging", "staging" — not "stagingarea"
    expect(get(r, 'Sarah Chen')?.count).toBe(1) // "@Sarah" resolved by alias, NOT double counted
    expect(r.some((e) => e.name.toLowerCase() === 'sarah')).toBe(false)
  })

  it('reads "@Sarah Chen" as the one person, and "@Acme"-style tags as the registry entry', () => {
    const r = extractEntities(
      {
        title: 'Tags',
        body: 'Tell @Sarah Chen about #cats and #cats again. Ping @Navy NextMRO.',
        attendees: [],
        account: null
      },
      m
    )
    expect(get(r, 'Sarah Chen')?.count).toBe(1)
    expect(r.some((e) => e.name.toLowerCase() === 'sarah')).toBe(false)
    expect(get(r, 'Navy NextMRO')).toMatchObject({ category: 'customer', count: 1 })
    expect(get(r, 'cats')).toMatchObject({ category: 'topic', count: 2 })
  })

  it('discovers unknown @mentions, ignores me, resolves attendees and accounts', () => {
    const r = extractEntities(
      {
        title: 'x',
        body: '- [ ] Send deck | @Joe | due:2026-11-20\n- [ ] mine | @Me\n- [ ] also mine | @Jacob',
        attendees: ['Jacob Benjamin', 'Priya Nair', 'Sarah'],
        account: 'Acme'
      },
      m
    )
    expect(get(r, 'Joe')).toMatchObject({ category: 'person', count: 1, inRegistry: false })
    expect(r.some((e) => /^(me|jacob)/i.test(e.name))).toBe(false)
    expect(get(r, 'Priya Nair')?.category).toBe('person')
    expect(get(r, 'Sarah Chen')).toBeDefined() // attendee "Sarah" -> registry person
    expect(get(r, 'Acme')).toMatchObject({ category: 'customer', inRegistry: false })
  })

  it('finds #tags as topics (not markdown headings)', () => {
    const r = extractEntities(
      {
        title: 't',
        body: '# Heading\nTalked about #Latency and #rate-limits.',
        attendees: [],
        account: null
      },
      m
    )
    expect(
      r
        .filter((e) => e.category === 'topic')
        .map((e) => e.name)
        .sort()
    ).toEqual(['latency', 'rate-limits'])
  })
})

describe('@Name Surname for someone not listed yet', () => {
  it('reads two capitalised words as one name, but not "@Sarah Please"', async () => {
    const { extractEntities } = await import('./extract')
    const { buildMatcher, emptyRegistry } = await import('./registry')
    const m = buildMatcher(emptyRegistry(), ['Me'])
    const names = (body: string): string[] =>
      extractEntities({ title: '', body, attendees: [], account: null }, m).map((e) => e.name)
    expect(names('Finish the onboarding documentation for @John Smith')).toEqual(['John Smith'])
    expect(names('Thanks @Sarah Please send it')).toEqual(['Sarah'])
    expect(names('Ping @Sarah tomorrow')).toEqual(['Sarah'])
  })
})
