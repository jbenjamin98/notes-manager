import { describe, expect, it } from 'vitest'
import {
  applyTags,
  autoTag,
  compileTagVocab,
  findNewNames,
  findTags,
  needsModel,
  protectedRanges,
  type TagVocabEntry
} from './autotag'

const vocab: TagVocabEntry[] = [
  { name: 'Matt Rowe', category: 'person', terms: ['Matt Rowe', 'Matt'], exact: true },
  { name: 'Sarah Chen', category: 'person', terms: ['Sarah Chen', 'Sarah'], exact: false },
  { name: 'Acme', category: 'customer', terms: ['Acme', 'Acme Corp'], exact: false },
  { name: 'Firewall Gateway', category: 'system', terms: ['Firewall Gateway'], exact: false },
  { name: 'Denver', category: 'place', terms: ['Denver'], exact: false },
  { name: 'cats', category: 'topic', terms: ['cats'], exact: false },
  { name: 'budget', category: 'topic', terms: ['budget', 'two words'], exact: false }
]
const v = compileTagVocab(vocab)
const tag = (s: string, ignore?: string[]): string =>
  autoTag(s, v, { ignore: new Set(ignore) }).text

describe('auto-tagging', () => {
  it('turns "Tell Matt he likes cats" into "Tell @Matt he likes #cats"', () => {
    expect(tag('Tell Matt he likes cats')).toBe('Tell @Matt he likes #cats')
  })

  it('tags every kind of thing: people, companies, systems, places and topics', () => {
    expect(
      tag('Sarah Chen at Acme Corp is moving the Firewall Gateway to Denver for the budget')
    ).toBe('@Sarah Chen at @Acme Corp is moving the @Firewall Gateway to @Denver for the #budget')
  })

  it('keeps the words as typed (case) and is idempotent', () => {
    const once = tag('ask sarah about CATS')
    expect(once).toBe('ask @sarah about #CATS')
    expect(tag(once)).toBe(once)
    expect(tag('Already @Matt and #cats here')).toBe('Already @Matt and #cats here')
  })

  it('takes the longest name, never a name inside a name', () => {
    const hits = findTags('Sarah Chen and Sarah', v)
    expect(hits.map((h) => [h.from, h.to])).toEqual([
      [0, 10],
      [15, 20]
    ])
  })

  it('respects the exact capitalisation of discovered names', () => {
    expect(tag('the matt is here')).toBe('the matt is here')
    expect(tag('Matt is here')).toBe('@Matt is here')
  })

  it('does not touch code, links, URLs, emails or the fields of a task line', () => {
    expect(tag('Run `matt cats` now')).toBe('Run `matt cats` now')
    expect(tag('See [Matt cats](https://example.com/Matt) soon')).toBe(
      'See [Matt cats](https://example.com/Matt) soon'
    )
    expect(tag('Mail matt@acme.com about cats')).toBe('Mail matt@acme.com about #cats')
    expect(tag('- [ ] Tell Matt about cats | @Sarah | due:2026-11-20 ^abc123')).toBe(
      '- [ ] Tell @Matt about #cats | @Sarah | due:2026-11-20 ^abc123'
    )
    expect(tag('```\nMatt\n```'.split('\n')[0])).toBe('```')
  })

  it('leaves multi-word topics and ignored words alone', () => {
    expect(tag('two words are not a topic')).toBe('two words are not a topic')
    expect(tag('Tell Matt about cats', ['cats'])).toBe('Tell @Matt about cats')
  })

  it('reports what it would tag without changing the text', () => {
    const hits = findTags('Tell Matt about cats', v)
    expect(hits.map((h) => `${h.sigil}${h.name}:${h.category}`)).toEqual([
      '@Matt Rowe:person',
      '#cats:topic'
    ])
    expect(applyTags('Tell Matt about cats', hits)).toBe('Tell @Matt about #cats')
  })

  it('protects the right ranges', () => {
    const t = 'a `b` [c](d) https://x.y/z q@w.io'
    expect(protectedRanges(t).length).toBeGreaterThanOrEqual(4)
  })
})

describe('names nobody has listed yet', () => {
  const me = new Set(['me', 'jacob'])
  it('finds a capitalised name after a verb that takes a person', () => {
    const r = findNewNames('Please tell Priya Nair about it, and ask Joe too', v, me)
    expect(r.map((x) => x.text)).toEqual(['Priya Nair', 'Joe'])
  })
  it('ignores names it already knows, your own names, and ordinary capitalised words', () => {
    expect(findNewNames('Tell Matt', v, me)).toEqual([])
    expect(findNewNames('Tell Jacob', v, me)).toEqual([])
    expect(findNewNames('Ask Monday about it', v, me)).toEqual([])
    expect(findNewNames('tell the team', v, me)).toEqual([])
  })
  it('does not swallow the next word ("Tell Matt He likes")', () => {
    const r = findNewNames('Tell Rhea He likes cats', v, me)
    expect(r.map((x) => x.text)).toEqual(['Rhea'])
  })
})

describe('applying suggested tags', () => {
  it('writes each suggestion once at its first free whole-word match', async () => {
    const { applySuggested } = await import('./autotag')
    const r = applySuggested('Tell Rhea about the firewall and the firewall again', [
      { text: 'Rhea', kind: 'person' },
      { text: 'firewall', kind: 'topic' },
      { text: 'nothere', kind: 'topic' }
    ])
    expect(r.text).toBe('Tell @Rhea about the #firewall and the firewall again')
    expect(r.applied.map((a) => a.text)).toEqual(['Rhea', 'firewall'])
  })
  it('skips code, links and anything already tagged', async () => {
    const { applySuggested } = await import('./autotag')
    const r = applySuggested('See `firewall` and #firewall and [firewall](x) then firewall', [
      { text: 'firewall', kind: 'topic' }
    ])
    expect(r.text).toBe('See `firewall` and #firewall and [firewall](x) then #firewall')
  })
})

describe('tagging a whole note', () => {
  it('skips frontmatter and fenced code, and counts the tags', async () => {
    const { autoTagDocument } = await import('./autotag')
    const doc = [
      '---',
      'title: "Matt and cats"',
      '---',
      'Tell Matt he likes cats',
      '```',
      'Matt cats',
      '```',
      '- [ ] Ask Sarah about the budget | @Matt | due:2026-11-20'
    ].join('\n')
    const r = autoTagDocument(doc, v)
    expect(r.count).toBe(4)
    expect(r.text).toBe(
      [
        '---',
        'title: "Matt and cats"',
        '---',
        'Tell @Matt he likes #cats',
        '```',
        'Matt cats',
        '```',
        '- [ ] Ask @Sarah about the #budget | @Matt | due:2026-11-20'
      ].join('\n')
    )
    expect(autoTagDocument(r.text, v).count).toBe(0) // idempotent
  })
})

describe('new names of other kinds, without a model', () => {
  const me = new Set(['me', 'jacob'])
  const kinds = (s: string): [string, string][] =>
    findNewNames(s, v, me).map((x) => [x.text, x.kind])
  it('finds companies, systems, projects and places from the words around them', () => {
    expect(kinds('Signed with Globex Corp last week')).toContainEqual(['Globex Corp', 'customer'])
    expect(kinds('Renewal with the client Initech is due')).toContainEqual(['Initech', 'customer'])
    expect(kinds('Move the tickets into ServiceNow')).toContainEqual(['ServiceNow', 'system'])
    expect(kinds('We are using Okta for sign-in')).toContainEqual(['Okta', 'system'])
    expect(kinds('The Zephyr project is late')).toContainEqual(['Zephyr', 'project'])
    expect(kinds('Workshop in Lisbon next month')).toContainEqual(['Lisbon', 'place'])
  })
  it('still takes a name after "tell" as a person, and a company is not a person', () => {
    expect(kinds('Tell Rhea about it')).toEqual([['Rhea', 'person']])
    expect(kinds('Call with Globex Corp')).toEqual([['Globex Corp', 'customer']])
  })
  it('reads "X is pursuing Y" as a company going after a project, even at the start of a line', () => {
    expect(kinds('KPMG is pursuing RMW')).toEqual([
      ['KPMG', 'customer'],
      ['RMW', 'project']
    ])
    expect(kinds('Next is pursuing the plan')).toEqual([])
  })
  it('asks the model about an all-caps name at the start of a line', () => {
    expect(needsModel('KPMG wants the numbers', v, [])).toBe(true)
  })
  it('does not take sentence starts or everyday words for names', () => {
    expect(kinds('Next release is in review')).toEqual([])
    expect(kinds('McDonald said hello')).toEqual([])
  })
})

describe('well-known names and remembered corrections', () => {
  const me = new Set(['me', 'jacob'])
  const kinds = (s: string, k?: Record<string, string>): [string, string][] =>
    findNewNames(s, v, me, { kinds: k }).map((x) => [x.text, x.kind])
  it('knows places and software with no cue words around them', () => {
    expect(kinds('Lunch near Lisbon then the Jira board')).toEqual([
      ['Lisbon', 'place'],
      ['Jira', 'system']
    ])
    expect(kinds('We flew San Francisco to New York')).toEqual([
      ['San Francisco', 'place'],
      ['New York', 'place']
    ])
  })
  it('leaves everyday words alone', () => {
    expect(kinds('The Teams call is on Monday about Word counts')).toEqual([])
  })
  it('what you corrected before beats the rules', () => {
    expect(kinds('Ship it to Lisbon', { lisbon: 'customer' })).toEqual([['Lisbon', 'customer']])
  })
})

describe('weak guesses are maybe-tags', () => {
  const me = new Set(['me', 'jacob'])
  const maybe = (s: string): boolean | undefined => findNewNames(s, v, me)[0]?.maybe
  it('"Tell Rhea" is sure; "with Zorblax" and "in Kralupy" are guesses', () => {
    expect(maybe('Tell Rhea about it')).toBeUndefined()
    expect(maybe('We met with Zorblax yesterday')).toBe(true)
    expect(maybe('Workshop in Kralupy next month')).toBe(true)
  })
})

describe('asking the model only when the rules left something open', () => {
  const noModel = (s: string, found: string[] = []): boolean => needsModel(s, v, found)
  it('skips short, fully understood lines and asks for new capitalised words or topics', () => {
    expect(noModel('Tell Matt about cats')).toBe(false)
    expect(noModel('ok thanks')).toBe(false)
    expect(noModel('We met Zorblax yesterday')).toBe(true)
    expect(noModel('Ask about the rollout plan')).toBe(true)
  })
})
