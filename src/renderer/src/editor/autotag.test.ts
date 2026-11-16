import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { autoTagTyping, planTag, setTagConfig, type TagSettings } from './autotag'

const entries = [
  { name: 'Matt Rowe', category: 'person', terms: ['Matt Rowe', 'Matt'], exact: true },
  { name: 'Sarah Chen', category: 'person', terms: ['Sarah Chen', 'Sarah'], exact: false },
  { name: 'cats', category: 'topic', terms: ['cats'], exact: false }
]
const on: TagSettings = { enabled: true, ai: false, ignore: [] }

/** A document where the caret sits right after the character that was just typed. */
function typed(doc: string, settings: TagSettings = on, caret = doc.length): EditorState {
  const s = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [autoTagTyping(() => null)]
  })
  return s.update({ effects: setTagConfig.of({ entries, settings }) }).state
}
const run = (
  doc: string,
  enter = false,
  settings: TagSettings = on,
  rejected = new Set<string>(),
  caret = doc.length
): string => {
  const st = typed(doc, settings, caret)
  const p = planTag(st, enter, rejected)
  return p ? st.doc.sliceString(0, p.pos) + p.sigil + st.doc.sliceString(p.pos) : doc
}

describe('tagging the word you just finished typing', () => {
  it('tags a known name at a space: "Tell Matt " becomes "Tell @Matt "', () => {
    expect(run('Tell Matt ')).toBe('Tell @Matt ')
  })
  it('tags a topic: "he likes cats." becomes "he likes #cats."', () => {
    expect(run('Tell @Matt he likes cats.')).toBe('Tell @Matt he likes #cats.')
  })
  it('only ever tags the word that just ended, never earlier text', () => {
    expect(run('Sarah and Matt are here ')).toBe('Sarah and Matt are here ')
    expect(run('Sarah and Matt ')).toBe('Sarah and @Matt ')
  })
  it('tags a multi-word name once it is finished', () => {
    expect(run('Ask Sarah Chen ')).toBe('Ask @Sarah Chen ')
  })
  it('tags the last word of a line when you press Enter', () => {
    expect(run('Tell Matt\n', true)).toBe('Tell @Matt\n')
  })
  it('leaves code, links, fences, frontmatter and task fields alone', () => {
    expect(run('Run `matt ')).toBe('Run `matt ')
    expect(run('See [matt ')).toBe('See [matt ')
    expect(run('```\nTell Matt ')).toBe('```\nTell Matt ')
    const fm = '---\ntitle: Matt \n---\nbody'
    expect(run(fm, false, on, new Set(), fm.indexOf('Matt ') + 5)).toBe(fm)
    expect(run('- [ ] Tell Matt | @Sarah ')).toBe('- [ ] Tell Matt | @Sarah ')
  })
  it('does nothing when off, for words taken off before, or a half-typed word', () => {
    expect(run('Tell Matt ', false, { ...on, enabled: false })).toBe('Tell Matt ')
    expect(run('Tell Matt ', false, { ...on, ignore: ['matt'] })).toBe('Tell Matt ')
    expect(run('Tell Matt ', false, on, new Set(['matt']))).toBe('Tell Matt ')
    expect(run('Tell Mat ')).toBe('Tell Mat ')
  })
  it('does not tag a word that is already tagged', () => {
    expect(run('Tell @Matt ')).toBe('Tell @Matt ')
    expect(run('about #cats ')).toBe('about #cats ')
  })
})
