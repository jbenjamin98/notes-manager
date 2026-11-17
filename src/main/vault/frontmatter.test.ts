import { describe, expect, it } from 'vitest'
import { setFrontmatterField } from './edit'

const note = '---\nid: "01A"\ntitle: "T"\n---\n\nBody\n'

describe('setFrontmatterField', () => {
  it('adds, replaces and removes a one-line field without touching the rest', () => {
    const added = setFrontmatterField(note, 'series', 'NextMRO Sync')
    expect(added).toBe('---\nid: "01A"\ntitle: "T"\nseries: "NextMRO Sync"\n---\n\nBody\n')
    const changed = setFrontmatterField(added, 'series', '-')
    expect(changed).toContain('series: "-"')
    expect(changed.match(/series:/g)).toHaveLength(1)
    expect(setFrontmatterField(changed, 'series', null)).toBe(note)
  })

  it('keeps Windows line endings and leaves a note with no frontmatter alone', () => {
    const crlf = note.replace(/\n/g, '\r\n')
    expect(setFrontmatterField(crlf, 'series', 'X')).toContain('series: "X"\r\n---')
    expect(setFrontmatterField('Just text', 'series', 'X')).toBe('Just text')
  })
})
