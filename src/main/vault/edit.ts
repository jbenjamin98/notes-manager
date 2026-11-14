import { parseFrontmatter, parseTaskLine, splitLines } from './parse'
import { taskId, ulid } from './ids'

/** All edits are pure string -> string and touch only the lines they target. */

const eolOf = (content: string): string => (content.includes('\r\n') ? '\r\n' : '\n')

/** Flip a task's checkbox, located by its inline ^id. Returns null if not found. */
export function setTaskChecked(content: string, id: string, checked: boolean): string | null {
  const lines = splitLines(content)
  for (let i = 0; i < lines.length; i++) {
    const t = parseTaskLine(lines[i], i)
    if (t?.id === id) {
      const next = lines[i].replace(/^(\s*- \[)( |x|X)(\])/, `$1${checked ? 'x' : ' '}$3`)
      if (next === lines[i]) return content
      lines[i] = next
      return lines.join('')
    }
  }
  return null
}

export interface IdentityResult {
  content: string
  noteId: string
  changed: boolean
}

/**
 * Guarantees a frontmatter `id`, and a unique inline ^id on every task line.
 * `isTaken(id)` reports ids owned by OTHER notes (e.g. a task line copy-pasted
 * between notes); those get re-issued here. `forceNewNoteId` handles copied files.
 */
export function ensureIdentity(
  content: string,
  isTaken: (taskId: string) => boolean,
  opts: { forceNewNoteId?: boolean } = {}
): IdentityResult {
  const eol = eolOf(content)
  let lines = splitLines(content)
  let changed = false
  let fm = parseFrontmatter(lines)
  let noteId = typeof fm?.data.id === 'string' ? (fm.data.id as string) : ''

  if (!fm) {
    noteId = ulid()
    lines = [`---${eol}`, `id: "${noteId}"${eol}`, `---${eol}`, ...lines]
    changed = true
  } else if (!noteId || opts.forceNewNoteId) {
    const fresh = ulid()
    const idx = lines.slice(1, fm.endLine).findIndex((l) => /^id\s*:/.test(l))
    if (idx >= 0) lines[idx + 1] = `id: "${fresh}"${eol}`
    else lines.splice(1, 0, `id: "${fresh}"${eol}`)
    noteId = fresh
    changed = true
  }

  fm = parseFrontmatter(lines)
  const start = fm ? fm.endLine + 1 : 0
  const seen = new Set<string>()
  for (let i = start; i < lines.length; i++) {
    const t = parseTaskLine(lines[i], i)
    if (!t) continue
    if (t.id && !seen.has(t.id) && !isTaken(t.id)) {
      seen.add(t.id)
      continue
    }
    let fresh = taskId()
    while (seen.has(fresh) || isTaken(fresh)) fresh = taskId()
    seen.add(fresh)
    const m = /^(.*?)(\r\n|\n|\r)?$/s.exec(lines[i])!
    const body = t.id ? m[1].replace(/\s\^[A-Za-z0-9]{4,12}\s*$/, '') : m[1].replace(/\s+$/, '')
    lines[i] = `${body} ^${fresh}${m[2] ?? ''}`
    changed = true
  }
  return { content: lines.join(''), noteId, changed }
}

/** Set the frontmatter `title`, preserving everything else. Unchanged if there is no frontmatter. */
export function setFrontmatterTitle(content: string, title: string): string {
  const eol = eolOf(content)
  const lines = splitLines(content)
  const fm = parseFrontmatter(lines)
  if (!fm) return content
  const line = `title: ${JSON.stringify(title)}${eol}`
  const idx = lines.slice(1, fm.endLine).findIndex((l) => /^title\s*:/.test(l))
  if (idx >= 0) lines[idx + 1] = line
  else {
    const idLine = lines.slice(1, fm.endLine).findIndex((l) => /^id\s*:/.test(l))
    lines.splice(idLine >= 0 ? idLine + 2 : 1, 0, line)
  }
  return lines.join('')
}

/**
 * Set or clear a task's `due:` field, located by ^id. Only that line changes; its other
 * fields are preserved (spacing around ` | ` is normalised). Null if the task isn't found.
 */
export function setTaskDue(content: string, id: string, due: string | null): string | null {
  const lines = splitLines(content)
  for (let i = 0; i < lines.length; i++) {
    const t = parseTaskLine(lines[i], i)
    if (t?.id !== id) continue
    const m = /^(.*?)(\r\n|\n|\r)?$/s.exec(lines[i])!
    const body = m[1].replace(/\s\^[A-Za-z0-9]{4,12}\s*$/, '')
    const segs = body.split(/\s+\|\s+/).filter((s) => !/^due:/i.test(s.trim()))
    if (due) segs.push(`due:${due}`)
    lines[i] = `${segs.join(' | ')} ^${id}${m[2] ?? ''}`
    return lines.join('')
  }
  return null
}

/** Append a line to the end of the file, making sure the previous content ends with a newline. */
export function appendLine(content: string, line: string): string {
  const eol = eolOf(content)
  const base = content.length === 0 || /(\r\n|\n|\r)$/.test(content) ? content : content + eol
  return base + line + eol
}
