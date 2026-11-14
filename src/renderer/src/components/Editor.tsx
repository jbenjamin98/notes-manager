import { useEffect, useRef } from 'react'
import { Annotation, EditorState, StateEffect, StateField, type Range } from '@codemirror/state'
import type { VocabEntry } from '@shared/contract'
import {
  EditorView,
  keymap,
  drawSelection,
  placeholder,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export interface EditorHandle {
  getText(): string
  /** Replace the whole document, keeping the cursor where possible. */
  setText(text: string): void
  focus(): void
  /** Names to recognise and underline as the user writes (people, accounts, systems). */
  setVocab(v: VocabEntry[]): void
}

/** Marks transactions we dispatch ourselves (external reloads) so they don't trigger autosave. */
const external = Annotation.define<boolean>()

const doneLine = Decoration.line({ class: 'cm-task-done' })
const idMark = Decoration.mark({ class: 'cm-task-id' })

/** End offset (exclusive) of a leading `---` frontmatter block, or 0 if there is none. */
function frontmatterEnd(state: EditorState): number {
  const doc = state.doc
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return 0
  for (let i = 2; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === '---') return Math.min(doc.length, doc.line(i).to + 1)
  }
  return 0
}

/**
 * Frontmatter is metadata (the header shows title and date), so it is hidden and
 * protected: typing, select-all or delete can never wipe a note's identity.
 * Programmatic reloads (annotated `external`) are still allowed.
 */
const hiddenFrontmatter = StateField.define<DecorationSet>({
  create: (s) => buildHidden(s),
  update: (v, tr) => (tr.docChanged ? buildHidden(tr.state) : v),
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f))
  ]
})
function buildHidden(state: EditorState): DecorationSet {
  const end = frontmatterEnd(state)
  return end > 0
    ? Decoration.set([Decoration.replace({ block: true }).range(0, end)])
    : Decoration.none
}
const protectFrontmatter = EditorState.changeFilter.of((tr) => {
  if (tr.annotation(external)) return true
  const end = frontmatterEnd(tr.startState)
  return end > 0 ? [0, end - 1] : true
})

/** Dims the inline `^id` marker and strikes through completed task lines. */
const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const ranges: Range<Decoration>[] = []
      const doc = view.state.doc
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to;) {
          const line = doc.lineAt(pos)
          const text = line.text
          if (/^\s*- \[[xX]\] /.test(text)) ranges.push(doneLine.range(line.from))
          const m = /\s(\^[A-Za-z0-9]{4,12})\s*$/.exec(text)
          if (m) {
            const start = line.from + text.trimEnd().length - m[1].length
            ranges.push(idMark.range(start, start + m[1].length))
          }
          pos = line.to + 1
        }
      }
      return Decoration.set(ranges, true)
    }
  },
  { decorations: (v) => v.decorations }
)

// All colours come from CSS variables, so the editor follows light/dark automatically.
const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.55em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.25em', fontWeight: '650' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontSize: '1.08em', fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.monospace, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.92em' },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: 'var(--muted)' },
  { tag: t.quote, color: 'var(--muted)' }
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '15px', color: 'var(--fg)', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.75', overflow: 'auto' },
  '.cm-content': { padding: '8px 4px 40vh', caretColor: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft) !important'
  },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-ent': { borderBottom: '2px dotted var(--muted)', borderRadius: '1px', cursor: 'text' },
  '.cm-ent-person': { borderBottomColor: 'var(--s1)' },
  '.cm-ent-customer': { borderBottomColor: 'var(--s2)' },
  '.cm-ent-system': { borderBottomColor: 'var(--s3)' },
  '.cm-task-done': { opacity: '0.5', textDecoration: 'line-through' },
  '.cm-task-id': { opacity: '0.35', fontSize: '11px', textDecoration: 'none' }
})

// ---- Auto-tagging: known names are underlined by type while you write. No "@" needed.
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BOUND_L = '(?<![\\p{L}\\p{N}_])'
const BOUND_R = '(?![\\p{L}\\p{N}_])'

interface CompiledVocab {
  ci: RegExp | null
  exact: RegExp | null
  byTerm: Map<string, VocabEntry>
}
const noVocab: CompiledVocab = { ci: null, exact: null, byTerm: new Map() }

function compileVocab(v: VocabEntry[]): CompiledVocab {
  const byTerm = new Map<string, VocabEntry>()
  const ci: string[] = []
  const exact: string[] = []
  for (const e of v) {
    for (const t of e.terms) {
      if (t.trim().length < 2) continue
      byTerm.set(e.exact ? t : t.toLowerCase(), e)
      ;(e.exact ? exact : ci).push(t)
    }
  }
  const build = (terms: string[], flags: string): RegExp | null =>
    terms.length
      ? new RegExp(
          `${BOUND_L}(?:${terms
            .sort((a, b) => b.length - a.length)
            .map(esc)
            .join('|')})${BOUND_R}`,
          flags
        )
      : null
  return { ci: build(ci, 'giu'), exact: build(exact, 'gu'), byTerm }
}

const setVocabEffect = StateEffect.define<VocabEntry[]>()
const vocabField = StateField.define<CompiledVocab>({
  create: () => noVocab,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setVocabEffect)) return compileVocab(e.value)
    return value
  }
})

const CATEGORY_LABEL: Record<string, string> = {
  person: 'Person',
  customer: 'Account',
  system: 'System',
  topic: 'Topic'
}

const entityMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate): void {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.startState.field(vocabField) !== u.state.field(vocabField)
      ) {
        this.decorations = this.build(u.view)
      }
    }
    build(view: EditorView): DecorationSet {
      const v = view.state.field(vocabField)
      if (!v.ci && !v.exact) return Decoration.none
      const doc = view.state.doc
      const fmEnd = frontmatterEnd(view.state)
      const found: { from: number; to: number; e: VocabEntry }[] = []
      for (const { from, to } of view.visibleRanges) {
        const start = Math.max(from, fmEnd)
        if (start >= to) continue
        const text = doc.sliceString(start, to)
        for (const [re, exact] of [
          [v.ci, false],
          [v.exact, true]
        ] as const) {
          if (!re) continue
          for (const m of text.matchAll(re)) {
            const e = v.byTerm.get(exact ? m[0] : m[0].toLowerCase())
            if (e)
              found.push({
                from: start + (m.index ?? 0),
                to: start + (m.index ?? 0) + m[0].length,
                e
              })
          }
        }
      }
      // Longest first; drop overlaps (e.g. "Sarah Chen" vs "Sarah").
      found.sort((a, b) => a.from - b.from || b.to - a.to)
      const ranges: Range<Decoration>[] = []
      let last = -1
      for (const f of found) {
        if (f.from < last) continue
        last = f.to
        ranges.push(
          Decoration.mark({
            class: `cm-ent cm-ent-${f.e.category}`,
            attributes: {
              'data-ent': f.e.id,
              title: `${f.e.name} · ${CATEGORY_LABEL[f.e.category] ?? f.e.category} (Ctrl+click to open)`
            }
          }).range(f.from, f.to)
        )
      }
      return Decoration.set(ranges, true)
    }
  },
  { decorations: (v) => v.decorations }
)

interface Props {
  /** Changing `docKey` remounts the editor with a fresh `initial`. */
  docKey: string
  initial: string
  onChange: (text: string) => void
  onSave: () => void
  onOpenEntity: (id: string) => void
  handleRef: React.MutableRefObject<EditorHandle | null>
}

export default function Editor({
  docKey,
  initial,
  onChange,
  onSave,
  onOpenEntity,
  handleRef
}: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const cb = useRef({ onChange, onSave, onOpenEntity })
  useEffect(() => {
    cb.current = { onChange, onSave, onOpenEntity }
  })

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          drawSelection(),
          markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          placeholder('Start writing…  Tasks: - [ ] Do the thing | @Owner | due:2026-11-20'),
          hiddenFrontmatter,
          protectFrontmatter,
          decorations,
          vocabField,
          entityMarks,
          EditorView.domEventHandlers({
            mousedown: (e) => {
              if (!(e.ctrlKey || e.metaKey)) return false
              const el = (e.target as HTMLElement).closest('[data-ent]')
              const id = el?.getAttribute('data-ent')
              if (!id) return false
              e.preventDefault()
              cb.current.onOpenEntity(id)
              return true
            }
          }),
          theme,
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave(), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) {
              cb.current.onChange(u.state.doc.toString())
            }
          })
        ]
      })
    })
    handleRef.current = {
      setVocab: (v) => view.dispatch({ effects: setVocabEffect.of(v) }),
      getText: () => view.state.doc.toString(),
      setText: (text) => {
        if (text === view.state.doc.toString()) return
        const head = Math.min(view.state.selection.main.head, text.length)
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: head },
          annotations: external.of(true)
        })
      },
      focus: () => {
        // Land after the frontmatter so typing starts in the body.
        const end = frontmatterEnd(view.state)
        const pos = end > 0 ? end : view.state.doc.length
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
        view.focus()
      }
    }
    return () => {
      handleRef.current = null
      view.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  return <div ref={host} className="h-full overflow-hidden" />
}
