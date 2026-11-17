import { useEffect, useMemo, useRef, useState } from 'react'
import { compileTagVocab, emptyTagVocab, findTags, type CompiledTagVocab } from '@shared/autotag'
import type { VocabEntry } from '@shared/contract'
import { parseQuickAdd } from '@shared/quickadd'
import { addDays, shortDate, todayIso } from '../format'

type Mode = 'task' | 'note'

const chip = 'pop rounded-full px-2 py-0.5 text-xs'
const tool =
  'rounded-full border border-line bg-field/70 px-2.5 py-0.5 text-xs font-medium text-muted transition hover:bg-hover hover:text-fg'

const DUES = ['today', 'tomorrow', 'Friday', 'next week']
/** Window height at one line, and the tallest the text box gets before it scrolls. */
const BASE_WINDOW = 172
const MAX_INPUT = 150
const PRIOS = ['!high', '!med', '!low']
const TIMES = ['~15m', '~30m', '~1h']

const MODES: Record<Mode, { label: string; color: string; icon: string; placeholder: string }> = {
  task: {
    label: 'Task',
    color: 'var(--accent)',
    icon: '✓',
    placeholder: 'Add a task…  Send deck to Joe tomorrow @Joe !high'
  },
  note: {
    label: 'Note',
    color: 'var(--warn)',
    icon: '✎',
    placeholder: 'Jot a note…  the first line becomes the title'
  }
}

const NOTE_TOOLS = [
  { label: '@ Person', token: '@', line: false },
  { label: '# Topic', token: '#', line: false },
  { label: '☐ To-do', token: '- [ ] ', line: true },
  { label: '• List', token: '- ', line: true },
  { label: '📅 Today', token: 'TODAY', line: false }
]

const loadMode = (): Mode => {
  try {
    return localStorage.getItem('capture.mode') === 'note' ? 'note' : 'task'
  } catch {
    return 'task'
  }
}

/** The small global quick-capture window (Ctrl+Shift+Space): a task or an ad hoc note. */
export default function CaptureWindow(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(loadMode)
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [doneMsg, setDoneMsg] = useState('')
  const [people, setPeople] = useState<VocabEntry[]>([])
  const [tagVocab, setTagVocab] = useState<CompiledTagVocab>(emptyTagVocab)
  const [tagOn, setTagOn] = useState(true)
  const [help, setHelp] = useState(false)
  const [pulse, setPulse] = useState(0) // bumps on every mode switch, to replay the glow
  const [shown, setShown] = useState(0) // bumps on every show, to replay the entrance
  const input = useRef<HTMLTextAreaElement>(null)
  const parsed = useMemo(
    () => (mode === 'task' && text.trim() ? parseQuickAdd(text) : null),
    [mode, text]
  )
  const m = MODES[mode]
  // The names and topics that will be tagged (@Matt, #cats) when you save, from your lists.
  const willTag = useMemo(() => {
    if (!tagOn) return []
    const body =
      mode === 'task' ? (parsed?.description ?? '') : text.split('\n').slice(1).join('\n')
    return findTags(body, tagVocab).map((h) => `${h.sigil}${body.slice(h.from, h.to)}`)
  }, [tagOn, tagVocab, mode, parsed, text])
  // Everything a task is about: names you tagged with @ plus the ones your lists will tag. The task
  // is always yours; these only say who or what it concerns.
  const involves = useMemo(() => {
    if (mode !== 'task') return []
    const typed = (parsed?.description ?? '').match(
      /(?<![\p{L}\p{N}])@[\p{L}][\p{L}\p{N}._-]*(?:\s+\p{Lu}[\p{L}\p{N}._-]*)?/gu
    )
    return [...new Set([...(typed ?? []), ...willTag])]
  }, [mode, parsed, willTag])
  // Past a short paragraph the small box is the wrong place: offer to continue in the app.
  const long = text.length > 280 || text.split('\n').length > 6

  const switchTo = (next: Mode): void => {
    if (next !== mode) setPulse((n) => n + 1)
    setMode(next)
    setError(null)
    try {
      localStorage.setItem('capture.mode', next)
    } catch {
      /* remembering the mode is a nicety */
    }
    input.current?.focus()
  }
  const toggle = (): void => switchTo(mode === 'task' ? 'note' : 'task')

  useEffect(() => {
    const loadTags = (): void => {
      void Promise.all([
        window.api.invoke('tags:vocabulary'),
        window.api.invoke('settings:get')
      ]).then(([v, st]) => {
        if (v.ok) setTagVocab(compileTagVocab(v.data))
        if (st.ok) setTagOn(st.data.autoTag.enabled)
      })
    }
    loadTags()
    const loadPeople = (): void => {
      void window.api
        .invoke('entities:vocabulary')
        .then(
          (r) =>
            r.ok &&
            setPeople(r.data.filter((v) => v.category !== 'topic' && v.category !== 'event'))
        )
    }
    input.current?.focus()
    loadPeople()
    return window.api.on('capture:shown', () => {
      setText('')
      setState('idle')
      setError(null)
      setHelp(false)
      setMode(loadMode())
      setShown((n) => n + 1)
      input.current?.focus()
      loadPeople()
      loadTags()
    })
  }, [])

  // The whole window is re-mounted on every show (to replay the entrance), so focus the NEW text box
  // once it exists; focusing in the event handler hit the old one and keys went nowhere.
  useEffect(() => {
    const focus = (): void => {
      const el = input.current
      if (el && document.activeElement !== el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
    const raf = requestAnimationFrame(focus)
    window.addEventListener('focus', focus)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('focus', focus)
    }
  }, [shown])

  // Grow with the text (the window grows too), up to about eight lines; past that, offer the app.
  const baseH = useRef(0)
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    const want = el.scrollHeight
    if (!baseH.current || !text) baseH.current = Math.min(want, 48)
    el.style.height = Math.min(want, MAX_INPUT) + 'px'
    el.style.overflowY = want > MAX_INPUT ? 'auto' : 'hidden'
    const extra = Math.max(0, Math.min(want, MAX_INPUT) - baseH.current)
    void window.api.invoke('capture:resize', { height: BASE_WINDOW + extra + (long ? 34 : 0) })
  }, [text, mode, long])

  const handoff = async (): Promise<void> => {
    if (!text.trim() || state === 'busy') return
    setState('busy')
    const r = await window.api.invoke('capture:handoff', { text })
    if (!r.ok) {
      setState('idle')
      setError(r.error.message)
    }
  }

  // "@Sa" or "@John Sm" at the end of the text: suggest people, companies, places, projects, systems.
  const mention =
    mode === 'task'
      ? /(^|\s)@([\p{L}][\p{L}\p{N}._-]*(?: [\p{L}][\p{L}\p{N}._-]*)?)$/u.exec(text)
      : null
  const suggestions = useMemo(
    () =>
      mention
        ? people
            .filter((p) => p.name.toLowerCase().startsWith(mention[2].toLowerCase()))
            .slice(0, 4)
        : [],
    [mention, people]
  )
  const pickName = (name: string): void => {
    setText((t) =>
      t.replace(/@[\p{L}][\p{L}\p{N}._-]*(?: [\p{L}][\p{L}\p{N}._-]*)?$/u, `@${name} `)
    )
    input.current?.focus()
  }

  /** Put a token in the text, replacing any earlier one of the same kind (so clicks cycle). */
  const setToken = (existing: RegExp, token: string | null): void => {
    setText((t) => {
      const cleaned = t
        .replace(existing, ' ')
        .replace(/\s{2,}/g, ' ')
        .trimStart()
      if (!token) return cleaned
      return `${cleaned}${cleaned && !cleaned.endsWith(' ') ? ' ' : ''}${token} `
    })
    input.current?.focus()
  }
  const cycle = (list: string[], existing: RegExp, current: string | undefined): void => {
    const i = current ? list.indexOf(current) : -1
    setToken(existing, i + 1 < list.length ? list[i + 1] : null)
  }
  const curDue = DUES.find((d) => new RegExp(`(^|\\s)${d}(\\s|$)`, 'i').test(text))
  const curPrio = PRIOS.find((p) => text.includes(p))
  const curTime = TIMES.find((x) => text.includes(x))
  const DUE_RE = /(^|\s)(today|tomorrow|friday|next week)(?=\s|$)/gi

  const addInline = (token: string): void => {
    setText((t) => `${t}${t && !/\s$/.test(t) ? ' ' : ''}${token}`)
    input.current?.focus()
  }
  const addLine = (prefix: string): void => {
    setText((t) => `${t}${t && !t.endsWith('\n') ? '\n' : ''}${prefix}`)
    input.current?.focus()
  }

  const submit = async (): Promise<void> => {
    if (state === 'busy') return
    if (mode === 'task' ? !parsed?.description : !text.trim()) return
    setState('busy')
    const r =
      mode === 'task'
        ? await window.api.invoke('tasks:quick-add', { text })
        : await window.api.invoke('notes:quick-note', { text })
    if (!r.ok) {
      setState('idle')
      return setError(r.error.message)
    }
    const d = r.data as { kind?: string; owner?: string }
    setDoneMsg(
      mode === 'note'
        ? 'Note saved ✓'
        : d.kind === 'waiting'
          ? `Saved to Waiting On: ${d.owner} ✓`
          : 'Added to your tasks ✓'
    )
    setState('done')
    setTimeout(() => void window.api.invoke('capture:hide'), 750)
  }

  const t0 = todayIso()
  const noFocusLoss = (e: React.MouseEvent): void => e.preventDefault()

  return (
    <div
      key={shown}
      className="cap-shell relative flex h-screen flex-col gap-2 overflow-hidden bg-[var(--app)] px-4 py-3 text-fg"
      style={{ ['--cap' as string]: m.color }}
    >
      <span
        aria-hidden
        className="cap-sweep pointer-events-none absolute inset-x-0 top-0 h-[2px]"
      />
      {/* Mode switch: a pill that slides under the active label */}
      <div className="flex items-center gap-2">
        <div
          role="tablist"
          aria-label="What to add"
          className="relative grid w-44 grid-cols-2 rounded-full border border-line bg-field/70 p-0.5 text-xs font-semibold"
        >
          <span
            aria-hidden
            className="cap-pill absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full"
            style={{ transform: mode === 'task' ? 'translateX(0)' : 'translateX(100%)' }}
          />
          {(['task', 'note'] as Mode[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={mode === k}
              onMouseDown={noFocusLoss}
              onClick={() => switchTo(k)}
              className={`relative z-10 flex items-center justify-center gap-1 rounded-full py-1 transition-colors ${
                mode === k
                  ? k === 'note'
                    ? 'text-[#2a1a02]'
                    : 'text-white'
                  : 'text-muted hover:text-fg'
              }`}
            >
              <span
                aria-hidden
                key={mode === k ? `on-${pulse}` : 'off'}
                className={mode === k ? 'pop inline-block' : 'inline-block'}
              >
                {MODES[k].icon}
              </span>
              {MODES[k].label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">
          <kbd className="rounded border border-line bg-field px-1 font-mono">Tab</kbd> or{' '}
          <kbd className="rounded border border-line bg-field px-1 font-mono">↑ ↓</kbd> to switch
        </span>
        <button
          className="ml-auto rounded-full border border-line px-2 text-xs text-muted hover:text-fg"
          onMouseDown={noFocusLoss}
          onClick={() => setHelp((h) => !h)}
          aria-expanded={help}
          aria-label="Text shortcuts"
        >
          ?
        </button>
      </div>

      <textarea
        ref={input}
        rows={1}
        value={text}
        disabled={state !== 'idle'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault()
            return toggle()
          }
          const single = !text.includes('\n')
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && single) {
            e.preventDefault()
            return toggle()
          }
          if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !text) {
            e.preventDefault()
            return toggle()
          }
          if (e.key === 'Enter' && e.ctrlKey && long) {
            e.preventDefault()
            return void handoff()
          }
          if (e.key === 'Enter' && !(mode === 'note' && e.shiftKey)) {
            e.preventDefault()
            if (suggestions[0]) return pickName(suggestions[0].name)
            void submit()
          }
          if (e.key === 'Escape') void window.api.invoke('capture:hide')
        }}
        placeholder={m.placeholder}
        aria-label={mode === 'task' ? 'Quick task' : 'Quick note'}
        data-pulse={pulse % 2}
        className="cap-input w-full resize-none overflow-hidden rounded-xl border bg-field px-3.5 py-2.5 text-[15px] leading-snug outline-none"
      />

      {long && state === 'idle' && (
        <button
          data-testid="capture-handoff"
          onMouseDown={noFocusLoss}
          onClick={() => void handoff()}
          className="cap-chip flex items-center justify-between gap-2 rounded-xl border border-line bg-accent-soft px-3 py-1.5 text-left text-xs font-medium hover:brightness-105"
        >
          <span>This is getting long. Keep writing in Note Manager</span>
          <kbd className="rounded border border-line bg-field px-1 font-mono">Ctrl+Enter</kbd>
        </button>
      )}

      {/* Shortcuts change with the context: a task needs who/when/how urgent; a note needs structure. */}
      <div
        key={mode}
        className="cap-row flex min-h-[26px] items-center gap-1.5"
        aria-label={mode === 'task' ? 'Task details' : 'Note helpers'}
      >
        {mode === 'task' ? (
          suggestions.length > 0 ? (
            suggestions.map((p, n) => (
              <button
                key={p.id}
                className={`${tool} cap-chip`}
                style={{ animationDelay: `${n * 40}ms` }}
                onMouseDown={noFocusLoss}
                onClick={() => pickName(p.name)}
              >
                @{p.name}
              </button>
            ))
          ) : (
            <>
              <button
                className={`${tool} cap-chip`}
                style={{ animationDelay: '0ms' }}
                onMouseDown={noFocusLoss}
                onClick={() => setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@`)}
              >
                @ Assign
              </button>
              <button
                className={`${tool} cap-chip ${curDue ? 'cap-on' : ''}`}
                style={{ animationDelay: '40ms' }}
                onMouseDown={noFocusLoss}
                onClick={() => {
                  const nextI = curDue ? DUES.indexOf(curDue) + 1 : 0
                  const v =
                    nextI < DUES.length
                      ? DUES[nextI] === 'next week'
                        ? `due:${addDays(t0, 7)}`
                        : DUES[nextI]
                      : null
                  setToken(new RegExp(`${DUE_RE.source}|(^|\\s)due:\\S+`, 'gi'), v)
                }}
              >
                📅 {curDue ? curDue : 'Due'}
              </button>
              <button
                className={`${tool} cap-chip ${curPrio ? 'cap-on' : ''}`}
                style={{ animationDelay: '80ms' }}
                onMouseDown={noFocusLoss}
                onClick={() => cycle(PRIOS, /(^|\s)![a-z]+(?=\s|$)/gi, curPrio)}
              >
                ! {curPrio ? curPrio.slice(1) : 'Priority'}
              </button>
              <button
                className={`${tool} cap-chip ${curTime ? 'cap-on' : ''}`}
                style={{ animationDelay: '120ms' }}
                onMouseDown={noFocusLoss}
                onClick={() => cycle(TIMES, /(^|\s)~\d+[mh](?=\s|$)/gi, curTime)}
              >
                ⏱ {curTime ? curTime.slice(1) : 'Time'}
              </button>
            </>
          )
        ) : (
          <>
            {NOTE_TOOLS.map((t, n) => (
              <button
                key={t.label}
                className={`${tool} cap-chip`}
                style={{ animationDelay: `${n * 40}ms` }}
                onMouseDown={noFocusLoss}
                onClick={() =>
                  t.line
                    ? addLine(t.token)
                    : addInline(t.token === 'TODAY' ? shortDate(t0) : t.token)
                }
              >
                {t.label}
              </button>
            ))}
          </>
        )}
      </div>

      <div className="mt-auto flex min-h-5 flex-wrap items-center gap-1.5 text-xs text-muted">
        {state === 'done' ? (
          <span className="pop text-ok">{doneMsg}</span>
        ) : error ? (
          <span className="text-danger">{error}</span>
        ) : help ? (
          <span>
            {mode === 'task'
              ? 'Tasks are always yours · @Name says who it is about · tomorrow / Friday · !high !med !low · ~30m ~1h'
              : 'First line is the title. Shift+Enter adds a line. Saved as an ad hoc note.'}
          </span>
        ) : parsed?.description ? (
          <>
            {parsed.due && (
              <span className={chip} style={{ background: 'var(--accent-soft)' }}>
                Due {shortDate(parsed.due)}
              </span>
            )}
            {parsed.priority && (
              <span className={chip} style={{ background: 'var(--accent-soft)' }}>
                {parsed.priority} priority
              </span>
            )}
            {parsed.estMinutes && (
              <span className={chip} style={{ background: 'var(--accent-soft)' }}>
                {parsed.estMinutes} min
              </span>
            )}
            {mode === 'task' && involves.length > 0 && <span>Involves</span>}
            {(mode === 'task' ? involves : willTag).map((t) => (
              <span key={t} className={chip} style={{ background: 'var(--accent-soft)' }}>
                {t}
              </span>
            ))}
            <span>Enter to add · Esc to cancel</span>
          </>
        ) : willTag.length > 0 ? (
          <>
            <span>Will tag</span>
            {willTag.map((t) => (
              <span key={t} className={chip} style={{ background: 'var(--accent-soft)' }}>
                {t}
              </span>
            ))}
            <span>· Enter to save</span>
          </>
        ) : (
          <span>
            {mode === 'task'
              ? 'Enter to add · Esc to cancel'
              : 'Enter to save · Shift+Enter for a new line · Esc to cancel'}
          </span>
        )}
      </div>
    </div>
  )
}
