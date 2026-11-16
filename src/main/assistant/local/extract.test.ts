import { describe, expect, it } from 'vitest'
import { actionCandidates, quickFollowup, quickSummary, renderQuickSummary } from './extract'

const NOTE = `# NextMRO sync
The team reviewed the cutover plan and confirmed the December window is still realistic.

## Decisions
- Cutover moves to Dec 4
- Freeze starts Nov 28

## Open questions
- Who signs off on the data migration?

## Next steps
- Priya will send the revised plan by Friday
- [ ] Already tracked item
- Schedule a dry run with the vendor
`

describe('local extraction', () => {
  it('summarises from the note headings without inventing anything', () => {
    const s = quickSummary(NOTE)!
    expect(s.tldr).toContain('cutover plan')
    expect(s.decisions).toEqual(['Cutover moves to Dec 4', 'Freeze starts Nov 28'])
    expect(s.questions).toEqual(['Who signs off on the data migration?'])
    const text = renderQuickSummary(s)
    expect(text).toContain('Decisions')
    expect(text).toContain('• Freeze starts Nov 28')
  })

  it('finds action-like bullets and skips tracked checkboxes', () => {
    const c = actionCandidates(NOTE)
    expect(c).toContain('Priya will send the revised plan by Friday')
    expect(c).toContain('Schedule a dry run with the vendor')
    expect(c.some((x) => /Already tracked/.test(x))).toBe(false)
  })

  it('drafts a recap email from the same facts', () => {
    const f = quickFollowup('NextMRO sync', quickSummary(NOTE)!)
    expect(f.subject).toBe('Follow-up: NextMRO sync')
    expect(f.body).toContain('Cutover moves to Dec 4')
    expect(f.body).toContain('Next steps')
  })

  it('returns null for an empty note so the AI can be used instead', () => {
    expect(quickSummary('')).toBeNull()
  })
})
