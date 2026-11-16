import {
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension
} from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import {
  compileTagVocab,
  emptyTagVocab,
  findTags,
  placeSuggested,
  type CompiledTagVocab,
  type Suggested,
  type TagVocabEntry
} from '@shared/autotag'

/**
 * Writes the missing @ and # as you type: "Tell Matt he likes cats" becomes
 * "Tell @Matt he likes #cats". Only the word you just finished (at a space, punctuation or Enter)
 * is tagged, so existing text never changes by itself. Each tag is its own undo step (one Ctrl+Z
 * puts the plain word back) and a tag you take off is not put back.
 *
 * Words the lists do not know yet (a new topic, a new name) go to the small model a moment after you
 * finish the line (see `hooks.suggest`); they are tagged only if the line is still exactly as it was.
 */
export interface TagSettings {
  enabled: boolean
  ai: boolean
  /** Lowercase words never to tag. */
  ignore: string[]
}

export interface TagHooks {
  suggest(line: string): Promise<Suggested[]>
  learn(names: { name: string; category: Exclude<Suggested['kind'], 'topic'> }[]): Promise<void>
  /** The model tagged something: tell the person (with a way to undo). */
  onTagged(labels: string[]): void
  /** A tag was taken off right after it was written: remember not to put it back. */
  onReject(word: string): void
  /** A shared name was tagged: it is waiting in Review Names. */
  onReview?(word: string): void
}

interface Cfg {
  v: CompiledTagVocab
  enabled: boolean
  ai: boolean
  ignore: Set<string>
}
const off: Cfg = { v: emptyTagVocab, enabled: false, ai: false, ignore: new Set() }

export const setTagConfig = StateEffect.define<{
  entries: TagVocabEntry[]
  settings: TagSettings
}>()

const cfgField = StateField.define<Cfg>({
  create: () => off,
  update(value, tr) {
    for (const e of tr.effects)
      if (e.is(setTagConfig))
        return {
          v: compileTagVocab(e.value.entries),
          enabled: e.value.settings.enabled,
          ai: e.value.settings.ai,
          ignore: new Set(e.value.settings.ignore.map((w) => w.toLowerCase()))
        }
    return value
  }
})

const BOUNDARY = /^[\s.,;:!?)\]}"'”’»]$/

/** End of a leading `---` frontmatter block (0 when there is none). */
function frontmatterEnd(state: EditorState): number {
  const d = state.doc
  if (d.lines < 2 || d.line(1).text.trim() !== '---') return 0
  for (let i = 2; i <= d.lines; i++) if (d.line(i).text.trim() === '---') return d.line(i).to + 1
  return 0
}

/** Is this line inside a fenced code block? */
function inFence(state: EditorState, lineNo: number): boolean {
  let open = false
  for (let i = 1; i < lineNo; i++) if (/^\s*```/.test(state.doc.line(i).text)) open = !open
  return open || /^\s*```/.test(state.doc.line(lineNo).text)
}

const typed = (tr: Transaction): boolean =>
  tr.docChanged &&
  (tr.isUserEvent('input.type') ||
    (tr.isUserEvent('input') &&
      !tr.isUserEvent('input.paste') &&
      !tr.isUserEvent('input.drop') &&
      !tr.isUserEvent('input.complete') &&
      !tr.isUserEvent('input.autotag')))

/** The line whose last word just ended, and where in it. */
export function lineBefore(
  state: EditorState,
  enter: boolean
): { from: number; text: string; end: number; no: number } | null {
  const head = state.selection.main.head
  const cur = state.doc.lineAt(head)
  if (enter) {
    if (cur.number < 2) return null
    const prev = state.doc.line(cur.number - 1)
    return { from: prev.from, text: prev.text, end: prev.text.length, no: prev.number }
  }
  const end = head - cur.from - 1
  if (end < 1 || !BOUNDARY.test(cur.text[end] ?? '')) return null
  return { from: cur.from, text: cur.text, end, no: cur.number }
}

/** The tag to write for the word that was just finished, or null. Pure: used by the editor and tests. */
export function planTag(
  state: EditorState,
  enter: boolean,
  rejected: ReadonlySet<string> = new Set()
): { pos: number; sigil: '@' | '#'; word: string; review: boolean } | null {
  const cfg = state.field(cfgField)
  if (!cfg.enabled || !state.selection.main.empty) return null
  const w = lineBefore(state, enter)
  if (!w || w.from < frontmatterEnd(state) || inFence(state, w.no)) return null
  const prefix = w.text.slice(0, w.end)
  if ((prefix.match(/`/g)?.length ?? 0) % 2 === 1) return null // inside inline code
  if (prefix.lastIndexOf('[') > prefix.lastIndexOf(']')) return null // inside link text
  const ignore = new Set([...cfg.ignore, ...rejected])
  const hit = findTags(prefix, cfg.v, { ignore }).find((h) => h.to === prefix.length)
  if (!hit) return null
  return {
    pos: w.from + hit.from,
    sigil: hit.sigil,
    word: prefix.slice(hit.from, hit.to),
    review: hit.review
  }
}

export function autoTagTyping(hooks: () => TagHooks | null): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      /** The sigil we just wrote: if it is deleted straight away, that word is not tagged again. */
      last: { pos: number; word: string } | null = null
      rejected = new Set<string>()
      asked = new Set<string>()
      timer: ReturnType<typeof setTimeout> | null = null

      constructor(readonly view: EditorView) {}

      update(u: ViewUpdate): void {
        for (const tr of u.transactions) {
          if (this.last && !tr.isUserEvent('input.autotag')) {
            let gone = false
            const pos = this.last.pos
            tr.changes.iterChanges((fa, ta, fb, tb) => {
              if (fa === pos && ta === pos + 1 && tb === fb) gone = true
            })
            if (gone) {
              this.rejected.add(this.last.word.toLowerCase())
              hooks()?.onReject(this.last.word)
              this.last = null
            } else if (tr.docChanged) this.last.pos = tr.changes.mapPos(this.last.pos, -1)
          }
        }
        const tr = u.transactions.find(typed)
        if (!tr) return
        // A finished word is a single typed boundary character or a new line.
        let ins = ''
        let n = 0
        tr.changes.iterChanges((_fa, _ta, _fb, _tb, t) => {
          ins = t.toString()
          n++
        })
        if (n !== 1) return
        const enter = ins.startsWith('\n')
        if (!enter && !(ins.length === 1 && BOUNDARY.test(ins))) return
        queueMicrotask(() => this.tagWord(enter))
        this.scheduleAi(enter)
      }

      tagWord(enter: boolean): void {
        const view = this.view
        if (view.composing) return
        const plan = planTag(view.state, enter, this.rejected)
        if (!plan) return
        view.dispatch({
          changes: { from: plan.pos, insert: plan.sigil },
          annotations: [Transaction.userEvent.of('input.autotag'), isolateHistory.of('full')]
        })
        this.last = { pos: plan.pos, word: plan.word }
        if (plan.review) hooks()?.onReview?.(plan.word)
      }

      scheduleAi(enter: boolean): void {
        if (this.timer) clearTimeout(this.timer)
        const cfg = this.view.state.field(cfgField)
        if (!cfg.enabled || !cfg.ai) return
        // After a finished line (Enter), or a pause after a sentence.
        this.timer = setTimeout(() => void this.askAi(enter), enter ? 300 : 1600)
      }

      async askAi(enter: boolean): Promise<void> {
        const view = this.view
        const st = view.state
        const cfg = st.field(cfgField)
        const h = hooks()
        if (!h || !cfg.enabled || !cfg.ai || view.composing) return
        const w =
          lineBefore(st, enter) ??
          (() => {
            const l = st.doc.lineAt(st.selection.main.head)
            return { from: l.from, text: l.text, end: l.text.length, no: l.number }
          })()
        const text = w.text
        if (w.from < frontmatterEnd(st) || inFence(st, w.no)) return
        if (text.trim().length < 8 || this.asked.has(text)) return
        this.asked.add(text)
        const tags = await h.suggest(text).catch((): Suggested[] => [])
        if (!tags.length) return
        // Only if the line is exactly as it was and the cursor is not in the middle of a tagged word.
        const now = view.state
        if (w.from > now.doc.length) return
        const line = now.doc.lineAt(Math.min(w.from, now.doc.length))
        if (line.from !== w.from || line.text !== text) {
          this.asked.delete(text)
          return
        }
        const placed = placeSuggested(text, tags, { ignore: cfg.ignore }).filter((p) => {
          const head = now.selection.main.head - line.from
          return !(head > p.from && head <= p.to)
        })
        if (!placed.length) return
        const names = placed
          .filter((p) => p.tag.kind !== 'topic')
          .map((p) => ({
            name: p.tag.text,
            category: p.tag.kind as Exclude<Suggested['kind'], 'topic'>
          }))
        if (names.length) await h.learn(names).catch(() => undefined)
        // Re-check after the (possibly slow) learn call.
        const after = view.state
        const l2 = after.doc.lineAt(Math.min(w.from, after.doc.length))
        if (l2.from !== w.from || l2.text !== text) return
        view.dispatch({
          changes: placed.map((p) => ({ from: line.from + p.from, insert: p.sigil })),
          annotations: [Transaction.userEvent.of('input.autotag'), isolateHistory.of('full')]
        })
        h.onTagged(placed.map((p) => `${p.sigil}${p.tag.text}`))
      }

      destroy(): void {
        if (this.timer) clearTimeout(this.timer)
      }
    }
  )
  return [cfgField, plugin]
}
