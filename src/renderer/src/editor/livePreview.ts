import { EditorState, RangeSetBuilder, type Range, type TransactionSpec } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'

/**
 * Live preview for Markdown notes: the file stays plain Markdown, but off the line you are editing
 * the syntax melts away. Headings are sized, ** and _ vanish, "- [ ]" becomes a real checkbox you can
 * click, "-" a bullet, and a task's "@owner | due:… | priority:…" fields become small chips. The line
 * with the cursor always shows its raw text so nothing is ever hidden while you type.
 */
class CheckWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private at: number
  ) {
    super()
  }
  eq(o: CheckWidget): boolean {
    return o.checked === this.checked && o.at === this.at
  }
  toDOM(view: EditorView): HTMLElement {
    const b = document.createElement('span')
    b.className = `cm-check${this.checked ? ' cm-check-on' : ''}`
    b.setAttribute('role', 'checkbox')
    b.setAttribute('aria-checked', String(this.checked))
    b.textContent = this.checked ? '✓' : ''
    b.onmousedown = (e) => {
      e.preventDefault() // do not move the cursor into the line
      const pos = view.posAtDOM(b)
      const line = view.state.doc.lineAt(pos)
      const m = /^(\s*- \[)([ xX])(\] )/.exec(line.text)
      if (!m) return
      const at = line.from + m[1].length
      view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' } })
    }
    return b
  }
  ignoreEvent(): boolean {
    return false
  }
}

const DRIVE_KIND: Record<string, string> = {
  document: '📄 Google Doc',
  spreadsheets: '📊 Google Sheet',
  presentation: '📽 Google Slides'
}

/** A pasted Google Docs/Sheets/Slides address, shown as a small chip that opens it. */
class DriveWidget extends WidgetType {
  constructor(
    private url: string,
    private kind: string
  ) {
    super()
  }
  eq(o: DriveWidget): boolean {
    return o.url === this.url
  }
  toDOM(): HTMLElement {
    const a = document.createElement('span')
    a.className = 'cm-drive-chip'
    a.textContent = DRIVE_KIND[this.kind] ?? 'Google file'
    a.title = this.url
    a.onmousedown = (e) => {
      e.preventDefault()
      void window.api.invoke('app:open-external', { url: this.url })
    }
    return a
  }
  ignoreEvent(): boolean {
    return false
  }
}

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'cm-bullet'
    s.textContent = '•'
    return s
  }
}

const hide = Decoration.replace({})
const chip = (cls: string): Decoration => Decoration.mark({ class: `cm-chip ${cls}` })
const lineH = [1, 2, 3].map((n) => Decoration.line({ class: `cm-lp-h${n}` }))
const lineQuote = Decoration.line({ class: 'cm-lp-quote' })

const INLINE: { re: RegExp; open: number; close: number; cls?: string }[] = [
  { re: /\*\*(?=\S)(.+?)(?<=\S)\*\*/g, open: 2, close: 2 },
  { re: /(?<![_\w])_(?=\S)([^_]+?)(?<=\S)_(?![_\w])/g, open: 1, close: 1 },
  { re: /~~(?=\S)(.+?)(?<=\S)~~/g, open: 2, close: 2 },
  { re: /`([^`]+)`/g, open: 1, close: 1, cls: 'cm-lp-code' }
]

function build(view: EditorView, rich: boolean): DecorationSet {
  const b: Range<Decoration>[] = []
  const state = view.state
  const active = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const z = state.doc.lineAt(r.to).number
    for (let n = a; n <= z; n++) active.add(n)
  }
  let fm = 0
  if (state.doc.lines > 1 && state.doc.line(1).text.trim() === '---') {
    for (let i = 2; i <= state.doc.lines; i++)
      if (state.doc.line(i).text.trim() === '---') {
        fm = state.doc.line(i).to
        break
      }
  }
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos)
      pos = line.to + 1
      if (line.to <= fm) continue
      const text = line.text
      // Rich text mode renders every line; the older mode shows the cursor line raw.
      const on = !rich && active.has(line.number)

      const h = /^(#{1,3}) /.exec(text)
      if (h) b.push(lineH[h[1].length - 1].range(line.from))
      if (/^> /.test(text)) b.push(lineQuote.range(line.from))
      if (on) continue

      // The task id marker ("^t7k2") is bookkeeping, not content: hidden in rich mode.
      if (rich) {
        const id = ID_RE.exec(text)
        if (id) b.push(hide.range(line.from + id.index, line.to))
      }

      if (h) b.push(hide.range(line.from, line.from + h[0].length))
      if (/^> /.test(text)) b.push(hide.range(line.from, line.from + 2))

      const task = /^(\s*)- \[([ xX])\] /.exec(text)
      if (task) {
        const s = line.from + task[1].length
        b.push(
          Decoration.replace({
            widget: new CheckWidget(task[2] !== ' ', s)
          }).range(s, s + task[0].length - task[1].length - 1)
        )
        // Task fields as chips: "| @Owner | due:… | priority:… | est:…".
        const fieldRe = /(\s\|\s)(@[^|^]+?|due:\S+|priority:\S+|est:\S+)(?=\s\||\s\^|\s*$)/g
        for (const m of text.matchAll(fieldRe)) {
          const sepFrom = line.from + (m.index ?? 0)
          const f0 = sepFrom + m[1].length
          const f1 = f0 + m[2].length
          b.push(hide.range(sepFrom, f0)) // the " | " separator
          const cls = m[2].startsWith('@')
            ? 'cm-chip-owner'
            : m[2].startsWith('due:')
              ? 'cm-chip-due'
              : m[2].startsWith('priority:')
                ? `cm-chip-pri cm-pri-${m[2].slice(9).toLowerCase()}`
                : 'cm-chip-est'
          b.push(chip(cls).range(f0, f1))
        }
      } else {
        const bullet = /^(\s*)([-*]) /.exec(text)
        if (bullet) {
          const s = line.from + bullet[1].length
          b.push(Decoration.replace({ widget: new BulletWidget() }).range(s, s + 2))
        }
        // @names in prose get a soft highlight (the entity underline still applies on top).
        for (const m of text.matchAll(/(?<![\p{L}\p{N}_])@[\p{L}][\p{L}\p{N}._-]*/gu))
          b.push(
            chip('cm-chip-owner').range(
              line.from + (m.index ?? 0),
              line.from + (m.index ?? 0) + m[0].length
            )
          )
      }

      for (const { re, open, close, cls } of INLINE) {
        for (const m of text.matchAll(re)) {
          const s = line.from + (m.index ?? 0)
          const e = s + m[0].length
          b.push(hide.range(s, s + open), hide.range(e - close, e))
          if (cls) b.push(Decoration.mark({ class: cls }).range(s + open, e - close))
        }
      }
      // Bare Google Docs / Sheets / Slides addresses become chips (links with text are left alone).
      for (const m of text.matchAll(
        /(?<![(\w/])https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/[\w-]+[^\s)<>]*/g
      )) {
        const s0 = line.from + (m.index ?? 0)
        b.push(
          Decoration.replace({ widget: new DriveWidget(m[0], m[1]) }).range(s0, s0 + m[0].length)
        )
      }
      // [text](url): show only the text, as a link.
      for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
        const s = line.from + (m.index ?? 0)
        const t0 = s + 1
        const t1 = t0 + m[1].length
        b.push(hide.range(s, t0))
        const src = /^nm:\/\/src\/([0-9a-fA-F-]+)$/.exec(m[2])
        b.push(
          Decoration.mark(
            src
              ? {
                  class: 'cm-lp-link cm-src-chip',
                  attributes: { 'data-src': src[1], title: 'Open where this came from' }
                }
              : { class: 'cm-lp-link', attributes: { title: m[2] } }
          ).range(t0, t1)
        )
        b.push(hide.range(t1, s + m[0].length))
      }
    }
  }
  // Ranges must be added in order; sort and drop any that overlap a hidden range.
  b.sort((x, y) => x.from - y.from || x.value.startSide - y.value.startSide)
  const out = new RangeSetBuilder<Decoration>()
  for (const r of b) out.add(r.from, r.to, r.value)
  return out.finish()
}

function makePlugin(rich: boolean): ViewPlugin<{ decorations: DecorationSet }> {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view, rich)
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || u.selectionSet)
          this.decorations = build(u.view, rich)
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (p) =>
        EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none)
    }
  )
}

/** Shows the line with the cursor as raw Markdown (the original live preview). */
export const livePreview = makePlugin(false)

/** A task line's trailing id marker: " ^t7k2". */
export const ID_RE = /\s\^[A-Za-z0-9]{3,12}\s*$/

/**
 * Keeps typing safe next to a hidden task id. Text typed at the end of a task line goes before the
 * id; Backspace at the end deletes the last visible character, never the id; Delete there does
 * nothing. Only user edits are touched; programmatic reloads pass through.
 */
export const idGuard = EditorState.transactionFilter.of(
  (tr): TransactionSpec | readonly TransactionSpec[] => {
    if (!tr.docChanged) return tr
    const isInput = tr.isUserEvent('input')
    const isBack = tr.isUserEvent('delete.backward')
    const isFwd = tr.isUserEvent('delete.forward')
    if (!isInput && !isBack && !isFwd) return tr
    let count = 0
    let fromA = 0
    let toA = 0
    let ins = ''
    tr.changes.iterChanges((a, b, _c, _d, text) => {
      count++
      fromA = a
      toA = b
      ins = text.toString()
    })
    if (count !== 1) return tr
    const doc = tr.startState.doc
    const line = doc.lineAt(fromA)
    if (doc.lineAt(toA).number !== line.number) return tr
    const id = ID_RE.exec(line.text)
    if (!id) return tr
    const idFrom = line.from + id.index
    if (fromA === toA && isInput && !ins.includes('\n') && fromA > idFrom && fromA <= line.to)
      return {
        changes: { from: idFrom, insert: ins },
        selection: { anchor: idFrom + ins.length },
        userEvent: 'input'
      }
    if (toA > fromA && fromA >= idFrom && toA <= line.to) {
      if (isBack && idFrom > line.from)
        return {
          changes: { from: idFrom - 1, to: idFrom },
          selection: { anchor: idFrom - 1 },
          userEvent: 'delete.backward'
        }
      return []
    }
    return tr
  }
)

/** Rich text mode: everything rendered, nothing raw, ids hidden. */
export const richMode = [makePlugin(true), idGuard]

export const livePreviewTheme = EditorView.theme({
  '.cm-lp-h1': { fontSize: '1.65em', fontWeight: '700', lineHeight: '1.35', paddingTop: '0.5em' },
  '.cm-lp-h2': { fontSize: '1.32em', fontWeight: '650', lineHeight: '1.4', paddingTop: '0.35em' },
  '.cm-lp-h3': { fontSize: '1.12em', fontWeight: '650', paddingTop: '0.2em' },
  '.cm-lp-quote': {
    borderLeft: '3px solid var(--accent)',
    paddingLeft: '12px',
    color: 'var(--muted)'
  },
  '.cm-lp-code': {
    fontFamily: 'ui-monospace, Consolas, monospace',
    background: 'var(--hover)',
    borderRadius: '4px',
    padding: '0 3px',
    fontSize: '0.92em'
  },
  '.cm-lp-link': {
    color: 'var(--accent)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px'
  },
  '.cm-src-chip': {
    textDecoration: 'none',
    fontSize: '0.8em',
    padding: '1px 8px',
    borderRadius: '999px',
    border: '1px solid var(--line)',
    color: 'var(--muted)',
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  },
  '.cm-src-chip:hover': { color: 'var(--fg)', borderColor: 'var(--accent)' },
  '.cm-drive-chip': {
    display: 'inline-block',
    padding: '0 9px',
    borderRadius: '999px',
    border: '1px solid var(--line)',
    fontSize: '0.85em',
    color: 'var(--accent)',
    cursor: 'pointer',
    background: 'color-mix(in srgb, var(--accent) 10%, transparent)'
  },
  '.cm-bullet': { display: 'inline-block', width: '1.1em', color: 'var(--muted)' },
  '.cm-check': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.05em',
    height: '1.05em',
    marginRight: '0.45em',
    verticalAlign: '-0.12em',
    border: '1.6px solid var(--muted)',
    borderRadius: '5px',
    fontSize: '0.8em',
    fontWeight: '700',
    cursor: 'pointer',
    color: '#fff',
    transition: 'background 0.15s, border-color 0.15s, transform 0.12s'
  },
  '.cm-check:hover': { borderColor: 'var(--accent)', transform: 'scale(1.1)' },
  '.cm-check-on': { background: 'var(--accent)', borderColor: 'var(--accent)' },
  '.cm-chip': {
    borderRadius: '999px',
    padding: '1px 8px',
    margin: '0 2px',
    fontSize: '0.82em',
    background: 'var(--hover)',
    whiteSpace: 'nowrap'
  },
  '.cm-chip-owner': { background: 'var(--accent-soft)' },
  '.cm-chip-due': { background: 'color-mix(in srgb, var(--s2) 22%, transparent)' },
  '.cm-pri-high': { background: 'color-mix(in srgb, var(--danger) 22%, transparent)' },
  '.cm-pri-medium': { background: 'color-mix(in srgb, var(--warn) 22%, transparent)' },
  '.cm-pri-low': { background: 'color-mix(in srgb, var(--ok) 22%, transparent)' }
})
