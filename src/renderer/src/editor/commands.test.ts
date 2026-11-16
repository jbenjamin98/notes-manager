import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { buildTaskLine, describe as info, parseTaskLine, setField } from './commands'

describe('task line editing', () => {
  const line = '- [ ] Update firewall rules | @Sarah Chen | due:2026-11-13 ^tabc123'

  it('splits a task line into description, fields and id, and rebuilds it exactly', () => {
    const p = parseTaskLine(line)!
    expect(p).toMatchObject({
      description: 'Update firewall rules',
      checked: false,
      id: '^tabc123'
    })
    expect(p.fields).toEqual(['@Sarah Chen', 'due:2026-11-13'])
    expect(buildTaskLine(p)).toBe(line)
    expect(parseTaskLine('- plain bullet')).toBeNull()
    expect(buildTaskLine({ ...p, checked: true })).toContain('- [x] ')
  })

  it('sets, replaces and clears fields in a stable order, keeping the id', () => {
    const p = parseTaskLine('- [ ] Send deck ^tx1y2z3')!
    const a = setField(setField(p, 'priority', 'High'), 'owner', 'Joe')
    expect(buildTaskLine(a)).toBe('- [ ] Send deck | @Joe | priority:High ^tx1y2z3')
    const b = setField(a, 'due', '2026-12-01')
    expect(buildTaskLine(b)).toBe(
      '- [ ] Send deck | @Joe | due:2026-12-01 | priority:High ^tx1y2z3'
    )
    expect(buildTaskLine(setField(b, 'owner', null))).toBe(
      '- [ ] Send deck | due:2026-12-01 | priority:High ^tx1y2z3'
    )
    expect(buildTaskLine(setField(b, 'due', '2027-01-02'))).toContain('due:2027-01-02')
    expect(buildTaskLine(setField(b, 'due', '2027-01-02'))).not.toContain('2026-12-01')
  })

  it('works with indented tasks and tasks with no fields or id', () => {
    const p = parseTaskLine('  - [x] Done thing')!
    expect(p).toMatchObject({
      indent: '  ',
      checked: true,
      description: 'Done thing',
      fields: [],
      id: ''
    })
    expect(buildTaskLine(setField(p, 'due', '2026-11-20'))).toBe(
      '  - [x] Done thing | due:2026-11-20'
    )
  })
})

describe('toolbar state follows the cursor', () => {
  const at = (doc: string, pos: number): EditorState =>
    EditorState.create({ doc, selection: { anchor: pos } })

  it('reports headings, lists and tasks', () => {
    expect(info(at('## Title', 4)).heading).toBe(2)
    expect(info(at('- item', 3)).list).toBe('bullet')
    expect(info(at('3. item', 3)).list).toBe('number')
    expect(info(at('> quote', 3)).list).toBe('quote')
    const t = info(at('- [ ] Do it | @Joe | due:2026-11-20 | priority:High', 8))
    expect(t).toMatchObject({ list: 'task', onTask: true })
    expect(t.fields).toEqual({ owner: 'Joe', due: '2026-11-20', priority: 'High', est: null })
  })

  it('reports inline formatting around the cursor only', () => {
    const doc = 'plain **bold** and _it_ and ~~gone~~ and `code`'
    expect(info(at(doc, 10)).bold).toBe(true)
    expect(info(at(doc, 2)).bold).toBe(false)
    expect(info(at(doc, 20)).italic).toBe(true)
    expect(info(at(doc, 30)).strike).toBe(true)
    expect(info(at(doc, 44)).code).toBe(true)
  })
})
