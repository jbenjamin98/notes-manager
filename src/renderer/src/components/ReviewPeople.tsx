import { useCallback, useEffect, useState } from 'react'
import type { Output } from '@shared/contract'
import { shortDate } from '../format'
import EmptyState from './EmptyState'
import SuggestedTags from './SuggestedTags'

type Group = Output<'names:review'>[number]

const pill =
  'rounded-full border border-line bg-field px-2.5 py-0.5 text-xs font-medium transition hover:border-accent hover:bg-accent-soft disabled:opacity-50'

/** The short name in bold inside its sentence, so you can tell which Jacob it is. */
function Snippet({ text, short }: { text: string; short: string }): React.JSX.Element {
  const i = text.indexOf(short)
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-accent-soft px-0.5 font-semibold text-fg">{short}</mark>
      {text.slice(i + short.length)}
    </>
  )
}

/**
 * Review Names: every note that says just "Jacob" when there are two (or more) Jacobs. Assign
 * each mention, or a selection at once, to the right person or to someone new. Nothing is guessed.
 */
export default function ReviewPeople({
  onOpenNote,
  onFlash,
  onCount
}: {
  onOpenNote: (path: string) => void
  onFlash: (m: string) => void
  onCount?: (n: number) => void
}): React.JSX.Element {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [sel, setSel] = useState<Record<string, Set<string>>>({})
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState<Record<string, string>>({})
  const [undo, setUndo] = useState<{ paths: string[]; short: string; person: string } | null>(null)

  const load = useCallback(() => {
    void window.api.invoke('names:review').then((r) => {
      if (!r.ok) return
      setGroups(r.data)
      onCount?.(r.data.reduce((n, g) => n + g.mentions.length, 0))
    })
  }, [onCount])
  useEffect(() => {
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [load])

  const assign = async (short: string, paths: string[], person: string): Promise<void> => {
    if (!paths.length || !person.trim()) return
    setBusy(true)
    // A new name is the same kind of thing as the others that share the short name.
    const kind = groups?.find((g) => g.short === short)?.candidates[0]?.category
    const category = ['customer', 'project', 'system', 'place'].includes(kind ?? '')
      ? (kind as 'customer' | 'project' | 'system' | 'place')
      : undefined
    const r = await window.api.invoke('names:assign', {
      paths,
      short,
      person: person.trim(),
      category
    })
    setBusy(false)
    if (!r.ok) return onFlash(r.error.message)
    setSel((s) => ({ ...s, [short]: new Set() }))
    setUndo({ paths, short, person: person.trim() })
    load()
  }
  const undoLast = async (): Promise<void> => {
    if (!undo) return
    setBusy(true)
    await window.api.invoke('names:unassign', { paths: undo.paths, short: undo.short })
    setBusy(false)
    setUndo(null)
    load()
  }

  if (groups === null) return <p className="px-2 py-6 text-sm text-muted">Looking for names…</p>
  if (groups.length === 0)
    return (
      <div className="space-y-5">
        <EmptyState
          title="Every name is sorted"
          body="When two things share a name (two Jacobs, or Acme Corp and Acme Labs), notes that only say “Jacob” or “Acme” appear here so you can say which one."
        />
        <SuggestedTags onFlash={onFlash} />
      </div>
    )

  return (
    <div className="space-y-5" data-testid="review-people">
      {undo && (
        <div className="pop flex items-center gap-2 rounded-xl border border-ok/30 bg-ok/10 px-3 py-2 text-sm">
          <span className="text-ok">✓</span>
          <span className="flex-1">
            {undo.paths.length} note{undo.paths.length === 1 ? '' : 's'}: “{undo.short}” is now{' '}
            <strong>{undo.person}</strong>
          </span>
          <button className={pill} disabled={busy} onClick={() => void undoLast()}>
            Undo
          </button>
        </div>
      )}
      {groups.map((g) => {
        const chosen = sel[g.short] ?? new Set<string>()
        const targets = chosen.size ? [...chosen] : []
        const toggle = (p: string): void =>
          setSel((s) => {
            const next = new Set(s[g.short] ?? [])
            if (next.has(p)) next.delete(p)
            else next.add(p)
            return { ...s, [g.short]: next }
          })
        return (
          <section key={g.short} className="card-modern p-4">
            <header className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold tracking-tight">“{g.short}”</h3>
              <span className="text-sm text-muted">
                {g.mentions.length} note{g.mentions.length === 1 ? '' : 's'} to sort
              </span>
              <span className="ml-auto text-xs text-muted">
                Could be: {g.candidates.map((c) => c.name).join(', ') || 'someone new'}
              </span>
            </header>

            {/* Bulk: assign everything selected (or everything) at once */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-xl bg-hover px-3 py-2 text-xs">
              <label className="mr-1 flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                  checked={chosen.size === g.mentions.length}
                  onChange={(e) =>
                    setSel((s) => ({
                      ...s,
                      [g.short]: e.target.checked
                        ? new Set(g.mentions.map((m) => m.path))
                        : new Set()
                    }))
                  }
                />
                {chosen.size ? `${chosen.size} selected` : 'Select all'}
              </label>
              {chosen.size > 0 && (
                <>
                  <span className="text-muted">Assign to</span>
                  {g.candidates.map((c) => (
                    <button
                      key={c.name}
                      className={pill}
                      disabled={busy}
                      onClick={() => void assign(g.short, targets, c.name)}
                    >
                      {c.name}
                    </button>
                  ))}
                </>
              )}
            </div>

            <ul className="mt-3 space-y-2">
              {g.mentions.map((m) => (
                <li
                  key={m.path}
                  className={`rounded-xl border px-3 py-2.5 transition-colors ${chosen.has(m.path) ? 'border-accent bg-accent-soft/40' : 'border-line bg-field/40'}`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${m.title}`}
                      className="mt-1 h-3.5 w-3.5 accent-[var(--accent)]"
                      checked={chosen.has(m.path)}
                      onChange={() => toggle(m.path)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <button
                          className="truncate font-medium text-fg hover:underline"
                          onClick={() => onOpenNote(m.path)}
                        >
                          {m.title}
                        </button>
                        <span>{shortDate(m.date)}</span>
                        {m.count > 1 && <span>· {m.count} mentions</span>}
                      </div>
                      <p className="mt-1 text-sm leading-snug">
                        <Snippet text={m.snippet} short={g.short} />
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {g.candidates.map((c) => (
                          <button
                            key={c.name}
                            className={pill}
                            disabled={busy}
                            onClick={() => void assign(g.short, [m.path], c.name)}
                          >
                            {c.name}
                          </button>
                        ))}
                        <form
                          className="flex items-center gap-1"
                          onSubmit={(e) => {
                            e.preventDefault()
                            void assign(g.short, [m.path], newName[m.path] ?? '')
                          }}
                        >
                          <input
                            value={newName[m.path] ?? ''}
                            onChange={(e) =>
                              setNewName((n) => ({ ...n, [m.path]: e.target.value }))
                            }
                            placeholder="Someone or something else…"
                            aria-label={`Someone else for ${m.title}`}
                            className="w-36 rounded-full border border-line bg-field px-2.5 py-0.5 text-xs"
                          />
                          {(newName[m.path] ?? '').trim() && (
                            <button className={pill} disabled={busy} type="submit">
                              Add
                            </button>
                          )}
                        </form>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <SuggestedTags onFlash={onFlash} />
    </div>
  )
}
