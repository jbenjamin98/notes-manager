import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ID_RE, idGuard } from './livePreview'

const DOC = '- [ ] Buy cake | @Me ^tc0g7t5\nnext'
const state = (doc = DOC): EditorState => EditorState.create({ doc, extensions: [idGuard] })
const lineEnd = DOC.indexOf('\n')
const idFrom = DOC.indexOf(' ^tc0g7t5')

describe('task id marker', () => {
  it('is recognised only at the end of a line', () => {
    expect(ID_RE.test('- [ ] Buy cake ^tc0g7t5')).toBe(true)
    expect(ID_RE.test('a ^tc0g7t5 and more')).toBe(false)
    expect(ID_RE.test('no id here')).toBe(false)
  })
})

describe('typing next to the hidden id (Rich text mode)', () => {
  it('text typed at the end of the line lands before the id', () => {
    const tr = state().update({
      changes: { from: lineEnd, insert: '!' },
      userEvent: 'input.type'
    })
    expect(tr.state.doc.toString()).toBe('- [ ] Buy cake | @Me! ^tc0g7t5\nnext')
    expect(tr.state.selection.main.head).toBe(idFrom + 1)
  })

  it('Enter at the end keeps the id on its own line', () => {
    const tr = state().update({
      changes: { from: lineEnd, insert: '\n' },
      userEvent: 'input'
    })
    expect(tr.state.doc.toString()).toBe('- [ ] Buy cake | @Me ^tc0g7t5\n\nnext')
  })

  it('Backspace after the hidden id deletes the last visible character, not the id', () => {
    const tr = state().update({
      changes: { from: idFrom, to: lineEnd },
      userEvent: 'delete.backward'
    })
    expect(tr.state.doc.toString()).toBe('- [ ] Buy cake | @M ^tc0g7t5\nnext')
  })

  it('Delete at the end does nothing', () => {
    const tr = state().update({
      changes: { from: idFrom, to: lineEnd },
      userEvent: 'delete.forward'
    })
    expect(tr.state.doc.toString()).toBe(DOC)
  })

  it('programmatic reloads and ordinary edits pass through untouched', () => {
    const reload = state().update({ changes: { from: 0, to: DOC.length, insert: 'fresh' } })
    expect(reload.state.doc.toString()).toBe('fresh')
    const middle = state().update({
      changes: { from: 6, insert: 'big ' },
      userEvent: 'input.type'
    })
    expect(middle.state.doc.toString()).toBe('- [ ] big Buy cake | @Me ^tc0g7t5\nnext')
  })
})
