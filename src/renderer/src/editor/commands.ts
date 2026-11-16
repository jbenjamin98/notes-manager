import type { EditorView } from '@codemirror/view'
import { EditorSelection, type EditorState } from '@codemirror/state'
import { redo, undo } from '@codemirror/commands'

/**
 * Every formatting action the toolbar offers, expressed as edits to the plain Markdown the rest of
 * the app already understands (task lines use `- [ ] text | @Owner | due:YYYY-MM-DD | priority:High`).
 */
export type EditorCommand =
  | { type: 'wrap'; marker: '**' | '_' | '~~' | '`' }
  | { type: 'heading'; level: 0 | 1 | 2 | 3 }
  | { type: 'list'; kind: 'bullet' | 'number' | 'task' | 'quote' }
  | { type: 'link' }
  | { type: 'mention'; name: string }
  | { type: 'field'; field: 'owner' | 'due' | 'priority' | 'est'; value: string | null }
  | { type: 'undo' }
  | { type: 'redo' }

export interface FormatInfo {
  heading: 0 | 1 | 2 | 3
  list: 'bullet' | 'number' | 'task' | 'quote' | null
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  /** The cursor is on a task line (due / owner / priority buttons apply). */
  onTask: boolean
  /** Current task fields, when on a task line. */
  fields: { owner: string | null; due: string | null; priority: string | null; est: string | null }
}

const TASK = /^(\s*)- \[([ xX])\] (.*)$/
const ID = /\s(\^[A-Za-z0-9]{4,12})\s*$/

export interface TaskParts {
  indent: string
  checked: boolean
  description: string
  fields: string[]
  id: string
}

/** Split a task line into description, `| field` parts and the trailing ^id. */
export function parseTaskLine(line: string): TaskParts | null {
  const m = TASK.exec(line)
  if (!m) return null
  let rest = m[3]
  let id = ''
  const idm = ID.exec(' ' + rest)
  if (idm) {
    id = idm[1]
    rest = rest.slice(0, rest.length - id.length).trimEnd()
  }
  const [description, ...fields] = rest.split(' | ').map((s) => s.trim())
  return {
    indent: m[1],
    checked: m[2] !== ' ',
    description: description ?? '',
    fields: fields.filter(Boolean),
    id
  }
}

export function buildTaskLine(p: TaskParts): string {
  const body = [p.description, ...p.fields].join(' | ')
  return `${p.indent}- [${p.checked ? 'x' : ' '}] ${body}${p.id ? ' ' + p.id : ''}`
}

const FIELD_KEY: Record<string, RegExp> = {
  owner: /^@/,
  due: /^due:/i,
  priority: /^priority:/i,
  est: /^est:/i
}

export function setField(
  p: TaskParts,
  field: keyof typeof FIELD_KEY,
  value: string | null
): TaskParts {
  const fields = p.fields.filter((f) => !FIELD_KEY[field].test(f))
  if (value) {
    const text = field === 'owner' ? `@${value.replace(/^@/, '')}` : `${field}:${value}`
    // Keep a stable order: owner, due, priority, est.
    const order = ['owner', 'due', 'priority', 'est']
    const rank = (f: string): number => order.findIndex((k) => FIELD_KEY[k].test(f))
    fields.push(text)
    fields.sort((a, b) => rank(a) - rank(b))
  }
  return { ...p, fields }
}

export function describe(state: EditorState): FormatInfo {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const text = line.text
  const tp = parseTaskLine(text)
  const h = /^(#{1,3}) /.exec(text)
  const inside = (re: RegExp): boolean => {
    const col = head - line.from
    for (const m of text.matchAll(re))
      if (col >= (m.index ?? 0) && col <= (m.index ?? 0) + m[0].length) return true
    return false
  }
  const pick = (re: RegExp): string | null =>
    tp?.fields.find((f) => re.test(f))?.replace(re, '') ?? null
  return {
    heading: (h ? h[1].length : 0) as FormatInfo['heading'],
    list: tp
      ? 'task'
      : /^\s*[-*] /.test(text)
        ? 'bullet'
        : /^\s*\d+\. /.test(text)
          ? 'number'
          : /^> /.test(text)
            ? 'quote'
            : null,
    bold: inside(/\*\*[^*]+\*\*/g),
    italic: inside(/(?<![*_])_[^_]+_(?!_)/g),
    strike: inside(/~~[^~]+~~/g),
    code: inside(/`[^`]+`/g),
    onTask: !!tp,
    fields: {
      owner: pick(FIELD_KEY.owner),
      due: pick(FIELD_KEY.due),
      priority: pick(FIELD_KEY.priority),
      est: pick(FIELD_KEY.est)
    }
  }
}

function wrap(view: EditorView, marker: string): void {
  const { state } = view
  const changes = state.changeByRange((r) => {
    const sel = state.sliceDoc(r.from, r.to)
    const before = state.sliceDoc(Math.max(0, r.from - marker.length), r.from)
    const after = state.sliceDoc(r.to, r.to + marker.length)
    if (before === marker && after === marker) {
      // Already wrapped around the selection: remove the markers.
      return {
        changes: [
          { from: r.from - marker.length, to: r.from },
          { from: r.to, to: r.to + marker.length }
        ],
        range: EditorSelection.range(r.from - marker.length, r.to - marker.length)
      }
    }
    if (sel.startsWith(marker) && sel.endsWith(marker) && sel.length >= marker.length * 2) {
      return {
        changes: {
          from: r.from,
          to: r.to,
          insert: sel.slice(marker.length, sel.length - marker.length)
        },
        range: EditorSelection.range(r.from, r.to - marker.length * 2)
      }
    }
    if (r.empty) {
      return {
        changes: { from: r.from, insert: marker + marker },
        range: EditorSelection.range(r.from + marker.length, r.from + marker.length)
      }
    }
    return {
      changes: { from: r.from, to: r.to, insert: marker + sel + marker },
      range: EditorSelection.range(r.from + marker.length, r.to + marker.length)
    }
  })
  view.dispatch(state.update(changes, { scrollIntoView: true }))
}

/** Lines touched by the selection. */
function selectedLines(
  state: EditorState
): { from: number; to: number; text: string; number: number }[] {
  const out: { from: number; to: number; text: string; number: number }[] = []
  const seen = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let pos = state.doc.lineAt(r.from).from; pos <= state.doc.lineAt(r.to).to;) {
      const l = state.doc.lineAt(pos)
      if (!seen.has(l.number)) {
        seen.add(l.number)
        out.push({ from: l.from, to: l.to, text: l.text, number: l.number })
      }
      pos = l.to + 1
    }
  }
  return out
}

const PREFIX = /^(\s*)(?:#{1,6} |- \[[ xX]\] |[-*] |\d+\. |> )/

function listPrefix(kind: 'bullet' | 'number' | 'task' | 'quote', n: number): string {
  return kind === 'bullet' ? '- ' : kind === 'number' ? `${n}. ` : kind === 'task' ? '- [ ] ' : '> '
}

function list(view: EditorView, kind: 'bullet' | 'number' | 'task' | 'quote'): void {
  const { state } = view
  const lines = selectedLines(state)
  const cur = describe(state).list
  const removing = cur === kind
  let n = 1
  const changes = lines.map((l) => {
    const m = PREFIX.exec(l.text)
    const indent = m ? m[1] : (/^\s*/.exec(l.text)?.[0] ?? '')
    const body = m ? l.text.slice(m[0].length) : l.text.slice(indent.length)
    const next = removing ? body : listPrefix(kind, n++) + body
    return { from: l.from, to: l.to, insert: indent + next }
  })
  view.dispatch({ changes, scrollIntoView: true })
}

function heading(view: EditorView, level: 0 | 1 | 2 | 3): void {
  const { state } = view
  const changes = selectedLines(state).map((l) => {
    const body = l.text.replace(/^#{1,6} /, '')
    const cur = /^(#{1,6}) /.exec(l.text)?.[1].length ?? 0
    const insert = level === 0 || cur === level ? body : '#'.repeat(level) + ' ' + body
    return { from: l.from, to: l.to, insert }
  })
  view.dispatch({ changes, scrollIntoView: true })
}

function link(view: EditorView): void {
  const { state } = view
  const r = state.selection.main
  const sel = state.sliceDoc(r.from, r.to) || 'link text'
  const url = 'https://'
  const text = `[${sel}](${url})`
  const urlStart = r.from + sel.length + 3
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    selection: { anchor: urlStart, head: urlStart + url.length },
    scrollIntoView: true
  })
}

function field(view: EditorView, f: keyof typeof FIELD_KEY, value: string | null): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const tp = parseTaskLine(line.text)
  if (!tp) return
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: buildTaskLine(setField(tp, f, value)) }
  })
}

function mention(view: EditorView, name: string): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const tp = parseTaskLine(line.text)
  if (tp) return field(view, 'owner', name)
  const r = view.state.selection.main
  const text = `@${name}`
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    selection: { anchor: r.from + text.length }
  })
}

export function run(view: EditorView, cmd: EditorCommand): void {
  switch (cmd.type) {
    case 'wrap':
      return wrap(view, cmd.marker)
    case 'heading':
      return heading(view, cmd.level)
    case 'list':
      return list(view, cmd.kind)
    case 'link':
      return link(view)
    case 'mention':
      return mention(view, cmd.name)
    case 'field':
      return field(view, cmd.field, cmd.value)
    case 'undo':
      undo(view)
      return
    case 'redo':
      redo(view)
      return
  }
}
