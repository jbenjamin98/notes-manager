import { describe, expect, it } from 'vitest'
import { cleanEmail } from './clean'
import { extractFromText, extractFromUtterances } from './extract'
import type { ExtractCtx, InsightKind, Utterance } from './types'

const NOW = new Date('2026-11-14T15:00:00')
const ctx = (source: ExtractCtx['source']): ExtractCtx => ({
  now: NOW,
  me: ['Me', 'Jacob'],
  source
})

/** Every expected (kind, words) pair must be found; reports recall over the whole corpus. */
interface Case {
  name: string
  source: ExtractCtx['source']
  run: () => ReturnType<typeof extractFromText>
  expect: [InsightKind, string][]
  /** Things that must NOT come out (small talk, finished work). */
  not?: string[]
}

const chat = (lines: [string, string, boolean?][]): Utterance[] =>
  lines.map(([who, text, fromMe]) => ({ who, text, fromMe: !!fromMe }))

const CASES: Case[] = [
  {
    name: 'meeting notes: plain statements',
    source: 'meeting',
    run: () =>
      extractFromText(
        `We decided to move the cutover to December 4. Sarah will send the revised plan by Friday. Risk: the vendor has not confirmed the freeze window. Who signs off on the data migration? Priya is the executive sponsor.`,
        ctx('meeting')
      ),
    expect: [
      ['decision', 'cutover'],
      ['action', 'revised plan'],
      ['risk', 'vendor'],
      ['question', 'signs off'],
      ['fact', 'sponsor']
    ]
  },
  {
    name: 'meeting notes: paraphrased decisions the phrase list would miss',
    source: 'meeting',
    run: () =>
      extractFromText(
        `Final answer: we're going with option B for the rollout. The team settled on weekly releases. Legal approved the contract wording. We'll stick with the current vendor. Scrapped the pilot in Denver.`,
        ctx('meeting')
      ),
    expect: [
      ['decision', 'option B'],
      ['decision', 'weekly releases'],
      ['decision', 'contract'],
      ['decision', 'vendor'],
      ['decision', 'pilot']
    ]
  },
  {
    name: 'meeting notes: action lines in many shapes',
    source: 'meeting',
    run: () =>
      extractFromText(
        `Action items: Joe to schedule the dry run next Tuesday.\nSend the SOW to legal.\nPriya needs to confirm the budget by Friday.\nI will update the risk log tomorrow.\nFollow up with the vendor about licences.`,
        ctx('meeting')
      ),
    expect: [
      ['action', 'dry run'],
      ['action', 'SOW'],
      ['action', 'budget'],
      ['action', 'risk log'],
      ['action', 'vendor']
    ]
  },
  {
    name: 'date and scope changes',
    source: 'meeting',
    run: () =>
      extractFromText(
        `The go-live was pushed to January 12. Scope extended to include the Denver site. Code freeze moved from Nov 28 to Dec 2.`,
        ctx('meeting')
      ),
    expect: [
      ['change', 'go-live'],
      ['change', 'Denver'],
      ['change', 'freeze']
    ]
  },
  {
    name: 'chat: a proposal that gets agreement is a decision',
    source: 'chat',
    run: () =>
      extractFromUtterances(
        chat([
          ['Priya', 'I think option B is cleaner for the cutover, how about we go with that?'],
          ['Joe', '+1 works for me'],
          ['Priya', 'ok great']
        ]),
        ctx('chat')
      ),
    expect: [['decision', 'option B']]
  },
  {
    name: 'chat: asks to me, my promises, risks, and an unanswered question',
    source: 'chat',
    run: () =>
      extractFromUtterances(
        chat([
          ['Priya', 'Can you send me the budget numbers by EOD?'],
          ['Me', "I'll get that over to you this afternoon", true],
          ['Joe', 'Heads up, we are blocked on the firewall change until security signs off'],
          ['Joe', 'Does anyone know who owns the vendor contract?']
        ]),
        ctx('chat')
      ),
    expect: [
      ['ask', 'budget numbers'],
      ['promise', 'get that over'],
      ['risk', 'firewall'],
      ['question', 'vendor contract']
    ]
  },
  {
    name: 'chat: an answered question is not open, and small talk is ignored',
    source: 'chat',
    run: () =>
      extractFromUtterances(
        chat([
          ['Joe', 'Does anyone know who owns the vendor contract?'],
          ['Sarah', 'Legal does'],
          ['Joe', 'Thanks! Have a great weekend everyone']
        ]),
        ctx('chat')
      ),
    expect: [],
    not: ['vendor contract', 'weekend']
  },
  {
    name: 'email body: quoted history and signature are ignored',
    source: 'email',
    run: () =>
      extractFromText(
        cleanEmail(`Hi Jacob,

Please send the signed SOW back by Thursday. We agreed to keep the scope as is.

Thanks,
Dana
--
Dana Cole | Acme
On Mon, Nov 9, 2026 at 9:00 AM Jacob wrote:
> We still need to talk about licences and the Denver site.
`),
        ctx('email')
      ),
    expect: [
      ['ask', 'signed SOW'],
      ['decision', 'scope']
    ],
    not: ['licences', 'Denver']
  },
  {
    name: 'people and roles',
    source: 'meeting',
    run: () =>
      extractFromText(
        `Sarah Chen owns the cutover plan. Joe Cardone is the customer sponsor. Dana will be the approver for change requests.`,
        ctx('meeting')
      ),
    expect: [
      ['fact', 'cutover'],
      ['fact', 'sponsor'],
      ['fact', 'approver']
    ]
  }
]

describe('insight extraction (rules)', () => {
  let found = 0
  let total = 0
  for (const c of CASES) {
    it(c.name, () => {
      const out = c.run()
      for (const [kind, words] of c.expect) {
        total++
        const hit = out.some(
          (o) => o.kind === kind && o.text.toLowerCase().includes(words.toLowerCase())
        )
        if (hit) found++
        expect(
          hit,
          `${kind} about "${words}" in ${JSON.stringify(out.map((o) => [o.kind, o.text]))}`
        ).toBe(true)
      }
      for (const bad of c.not ?? [])
        expect(out.some((o) => o.text.toLowerCase().includes(bad.toLowerCase()))).toBe(false)
    })
  }

  it('reads owners and dates', () => {
    const out = extractFromText('Sarah will send the revised plan by Friday.', ctx('meeting'))
    expect(out[0]).toMatchObject({ kind: 'action', owner: 'Sarah', due: '2026-11-20' })
    const mine = extractFromUtterances(
      chat([['Priya', 'Can you review this tomorrow?']]),
      ctx('chat')
    )
    expect(mine[0]).toMatchObject({ kind: 'ask', owner: 'Me', due: '2026-11-15' })
  })

  it('overall recall on the corpus', () => {
    expect(total).toBeGreaterThan(20)
    expect(found / total).toBeGreaterThanOrEqual(0.9)
  })
})
