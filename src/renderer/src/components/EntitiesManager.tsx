import { useCallback, useEffect, useMemo, useState } from 'react'
import ReviewPeople from './ReviewPeople'
import { useNavState } from '../nav'
import { SparkleIcon } from './Icons'
import type { EntitySuggestion, Output } from '@shared/contract'
import { shortDate } from '../format'
import Modal from './Modal'

type Row = Output<'entities:manage-list'>[number]
type RegCat = 'person' | 'customer' | 'project' | 'system' | 'place'

const TABS: { id: RegCat | 'topic'; label: string; singular: string }[] = [
  { id: 'person', label: 'People', singular: 'person' },
  { id: 'customer', label: 'Companies', singular: 'company' },
  { id: 'project', label: 'Projects', singular: 'project' },
  { id: 'system', label: 'Systems', singular: 'system' },
  { id: 'place', label: 'Places', singular: 'place' },
  { id: 'topic', label: 'Topics', singular: 'topic' }
]
const LABEL: Record<string, string> = {
  person: 'People',
  customer: 'Companies',
  project: 'Projects',
  system: 'Systems',
  place: 'Places',
  topic: 'Topics'
}

const btn =
  'rounded-xl border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover disabled:opacity-50'
const primary = 'btn-primary rounded-xl px-3.5 py-1.5 text-sm font-semibold disabled:opacity-50'

function MergeDialog({
  rows,
  onClose,
  onDone
}: {
  rows: Row[]
  onClose: () => void
  onDone: (canonical: string, others: string[]) => Promise<void>
}): React.JSX.Element {
  const [canonical, setCanonical] = useState(
    rows.slice().sort((a, b) => b.notes - a.notes || b.name.length - a.name.length)[0].name
  )
  const others = rows.filter((r) => r.name !== canonical)
  const aliases = [
    ...new Set([
      ...others.flatMap((o) => [o.name, ...o.aliases]),
      ...(rows.find((r) => r.name === canonical)?.aliases ?? [])
    ])
  ]
  const [busy, setBusy] = useState(false)
  return (
    <Modal label="Merge" onClose={onClose} className="w-[30rem] p-6">
      <h2 className="text-lg font-semibold">Merge {rows.length} into one</h2>
      <p className="mt-1 text-sm text-muted">
        Pick the name to keep. The others become nicknames, so every note that used them counts for
        it.
      </p>
      <div className="mt-4 space-y-2" role="radiogroup" aria-label="Name to keep">
        {rows.map((r) => (
          <label
            key={r.id}
            className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 ${r.name === canonical ? 'border-[var(--accent)] bg-accent-soft' : 'border-line'}`}
          >
            <input
              type="radio"
              name="canon"
              checked={r.name === canonical}
              onChange={() => setCanonical(r.name)}
              className="accent-[var(--accent)]"
            />
            <span className="flex-1">{r.name}</span>
            <span className="text-xs text-muted">{r.notes} notes</span>
          </label>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">
        <strong className="text-fg">{canonical}</strong> will also be known as:{' '}
        {aliases.length ? aliases.join(', ') : 'nothing else'}.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button className={btn} onClick={onClose}>
          Cancel
        </button>
        <button
          className={primary}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await onDone(
              canonical,
              others.map((o) => o.name)
            )
          }}
        >
          Merge
        </button>
      </div>
    </Modal>
  )
}

/**
 * Keep the cast of your notes tidy: recategorise, merge duplicates ("Joe C", "Joe Cardone"), mark names
 * that are different people, and mark a name like "Joe" as ambiguous so it never links to anyone alone.
 */
export default function EntitiesManager({
  initial,
  onBack,
  onOpenEntity,
  onEdit,
  onAdd,
  onFlash,
  onOpenNote
}: {
  initial: string
  onBack: () => void
  onOpenEntity: (id: string) => void
  onEdit: (row: { category: RegCat; name: string; aliases: string[]; inRegistry: boolean }) => void
  onAdd: (category: RegCat) => void
  onFlash: (m: string) => void
  onOpenNote?: (path: string) => void
}): React.JSX.Element {
  const [tab, setTab] = useNavState<string>(
    'manage.tab',
    TABS.some((t) => t.id === initial) || initial === 'review' ? initial : 'person'
  )
  const [reviewCount, setReviewCount] = useState(0)
  const [rows, setRows] = useState<Row[]>([])
  const [sugg, setSugg] = useState<EntitySuggestion[]>([])
  const [aiNote, setAiNote] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [merge, setMerge] = useState<Row[] | null>(null)
  const [menu, setMenu] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [l, s] = await Promise.all([
      window.api.invoke('entities:manage-list'),
      window.api.invoke('entities:suggestions')
    ])
    if (l.ok) setRows(l.data)
    if (s.ok) setSugg(s.data)
  }, [])
  useEffect(() => {
    // Initial and post-change loads; the registry watcher also refreshes rows after a re-scan.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const shown = useMemo(() => {
    const f = q.trim().toLowerCase()
    return rows
      .filter((r) => r.category === tab)
      .filter(
        (r) =>
          !f ||
          r.name.toLowerCase().includes(f) ||
          r.aliases.some((a) => a.toLowerCase().includes(f))
      )
      .sort((a, b) => b.notes - a.notes || a.name.localeCompare(b.name))
  }, [rows, tab, q])

  const toggle = (id: string): void =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const afterChange = async (msg: string): Promise<void> => {
    setSel(new Set())
    setMerge(null)
    setMenu(null)
    onFlash(msg)
    // A merge re-scans every note; give it a moment, then refresh.
    await new Promise((r) => setTimeout(r, 700))
    await load()
  }

  const doMerge = async (category: string, canonical: string, others: string[]): Promise<void> => {
    const r = await window.api.invoke('entities:merge', {
      category: category as RegCat,
      canonical,
      others
    })
    if (!r.ok) return onFlash(r.error.message)
    await afterChange(`Merged into ${canonical}.`)
  }
  const move = async (row: Row, to: RegCat): Promise<void> => {
    const r = await window.api.invoke('entities:recategorize', {
      from: row.category,
      to,
      name: row.name
    })
    if (!r.ok) return onFlash(r.error.message)
    await afterChange(`${row.name} is now a ${TABS.find((t) => t.id === to)?.singular}.`)
  }
  const notSame = async (a: string, b: string): Promise<void> => {
    const r = await window.api.invoke('entities:not-same', { a, b })
    if (!r.ok) return onFlash(r.error.message)
    setSugg((s) => s.filter((x) => !(x.names.includes(a) && x.names.includes(b))))
    onFlash(`Noted: ${a} and ${b} are different.`)
    void load()
  }
  const setAmbiguous = async (row: Row, on: boolean): Promise<void> => {
    const r = await window.api.invoke('entities:ambiguous', { name: row.name, on })
    if (!r.ok) return onFlash(r.error.message)
    await afterChange(
      on ? `“${row.name}” will no longer link on its own.` : `“${row.name}” links again.`
    )
  }
  const askAi = async (): Promise<void> => {
    setAiBusy(true)
    const r = await window.api.invoke('entities:ai-suggest')
    setAiBusy(false)
    if (!r.ok) return onFlash(r.error.message)
    setSugg(r.data.suggestions)
    setAiNote(
      r.data.via === 'llm'
        ? 'Checked by the Co-Pilot (names only were sent, never note text).'
        : (r.data.notice ?? 'Checked with built-in rules.')
    )
  }

  const selRows = rows.filter((r) => sel.has(r.id))
  const mergeable =
    selRows.length >= 2 &&
    new Set(selRows.map((r) => r.category)).size === 1 &&
    selRows[0].category !== 'topic'
  const tabSugg = sugg.filter(
    (s) =>
      s.category === tab ||
      (s.kind === 'category' &&
        s.names.some((n) => rows.find((r) => r.name === n)?.category === tab))
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <button
          onClick={onBack}
          className="mb-4 rounded-lg px-2 py-1 text-sm text-muted hover:bg-hover hover:text-fg"
        >
          ← Back to Explore
        </button>
        <header className="mb-6 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-semibold tracking-tight">Manage Names</h1>
            <p className="mt-1 text-sm text-muted">
              The people, companies, projects, systems and places in your notes. Merge duplicates
              and fix categories.
            </p>
          </div>
          <button className={btn} onClick={() => void askAi()} disabled={aiBusy}>
            {aiBusy ? (
              'Checking…'
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <SparkleIcon width={14} height={14} /> Check for duplicates
              </span>
            )}
          </button>
        </header>

        <div role="tablist" className="mb-5 flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id)
                setSel(new Set())
              }}
              className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${tab === t.id ? 'border-transparent bg-accent-soft font-medium' : 'border-line text-muted hover:bg-hover hover:text-fg'}`}
            >
              {t.label}
              <span className="ml-1.5 text-xs text-muted">
                {rows.filter((r) => r.category === t.id).length}
              </span>
            </button>
          ))}
          <button
            role="tab"
            aria-selected={tab === 'review'}
            onClick={() => {
              setTab('review')
              setSel(new Set())
            }}
            className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${tab === 'review' ? 'border-transparent bg-accent-soft font-medium' : 'border-line text-muted hover:bg-hover hover:text-fg'}`}
          >
            Review Names
            {reviewCount > 0 && (
              <span className="rounded-full bg-warn/15 px-1.5 text-xs font-semibold text-warn">
                {reviewCount}
              </span>
            )}
          </button>
        </div>

        {tab === 'review' ? (
          <ReviewPeople
            onOpenNote={onOpenNote ?? (() => undefined)}
            onFlash={onFlash}
            onCount={setReviewCount}
          />
        ) : (
          <>
            {aiNote && <p className="mb-3 text-xs text-muted">{aiNote}</p>}
            {tabSugg.length > 0 && (
              <section aria-label="Suggestions" className="mb-6">
                <h2 className="mb-3 text-sm font-semibold">Worth a Look</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {tabSugg.map((s) => (
                    <div
                      key={s.kind + s.names.join('|')}
                      className="lib-item rounded-2xl border border-line bg-surface p-4"
                    >
                      <div className="text-sm font-medium">
                        {s.kind === 'merge'
                          ? s.names.join('  =  ')
                          : `${s.names[0]} → ${LABEL[s.to ?? 'topic']}`}
                      </div>
                      <p className="mt-1 text-xs text-muted">{s.reason}</p>
                      {s.ambiguous && (
                        <p className="mt-1 text-xs text-warn">
                          A first name on its own may be a different person.
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {s.kind === 'merge' ? (
                          <>
                            <button
                              className={primary}
                              onClick={() => void doMerge(s.category, s.names[0], s.names.slice(1))}
                            >
                              {s.ambiguous ? 'Merge Anyway' : 'Merge'}
                            </button>
                            {s.names.length === 2 && (
                              <button
                                className={btn}
                                onClick={() => void notSame(s.names[0], s.names[1])}
                              >
                                Not the Same
                              </button>
                            )}
                          </>
                        ) : (
                          <button
                            className={primary}
                            onClick={() =>
                              void move(
                                rows.find((r) => r.name === s.names[0])!,
                                s.to as RegCat
                              )
                            }
                          >
                            Move
                          </button>
                        )}
                        <button
                          className={btn}
                          onClick={() => setSugg((x) => x.filter((y) => y !== s))}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${LABEL[tab].toLowerCase()}…`}
                aria-label="Search names"
                className="min-w-52 flex-1 rounded-2xl border border-line bg-field px-4 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
              {tab !== 'topic' && (
                <button className={btn} onClick={() => onAdd(tab as RegCat)}>
                  + Add {TABS.find((t) => t.id === tab)?.singular}
                </button>
              )}
              <button
                className={primary}
                disabled={!mergeable}
                title={mergeable ? undefined : 'Tick two or more names of the same kind'}
                onClick={() => setMerge(selRows)}
              >
                Merge{sel.size > 1 ? ` ${sel.size}` : ''}…
              </button>
            </div>

            <ul className="space-y-2">
              {shown.map((r, i) => (
                <li
                  key={r.id}
                  className="lib-item flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3"
                  style={{ animationDelay: `${Math.min(i, 14) * 20}ms` }}
                >
                  <input
                    type="checkbox"
                    checked={sel.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={`Select ${r.name}`}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  <button className="min-w-0 flex-1 text-left" onClick={() => onOpenEntity(r.id)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      {r.ambiguous && (
                        <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">
                          ambiguous
                        </span>
                      )}
                      {!r.inRegistry && tab !== 'topic' && (
                        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                          found in notes
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      {r.notes} note{r.notes === 1 ? '' : 's'}
                      {r.lastDate ? ` · last ${shortDate(r.lastDate)}` : ''}
                      {r.aliases.length ? ` · also: ${r.aliases.join(', ')}` : ''}
                    </div>
                  </button>
                  <div className="relative">
                    <button
                      className="rounded-lg px-2 py-1 text-muted hover:bg-hover hover:text-fg"
                      aria-label={`Actions for ${r.name}`}
                      onClick={() => setMenu(menu === r.id ? null : r.id)}
                    >
                      ⋯
                    </button>
                    {menu === r.id && (
                      <div
                        role="menu"
                        className="glass spring-in absolute top-9 right-0 z-20 w-56 rounded-xl p-1 text-sm"
                        onMouseLeave={() => setMenu(null)}
                      >
                        {tab !== 'topic' && (
                          <button
                            role="menuitem"
                            className="w-full rounded-lg px-3 py-1.5 text-left hover:bg-hover"
                            onClick={() => {
                              setMenu(null)
                              onEdit({
                                category: r.category as RegCat,
                                name: r.name,
                                aliases: r.aliases,
                                inRegistry: r.inRegistry
                              })
                            }}
                          >
                            Edit name and nicknames
                          </button>
                        )}
                        <div className="px-3 pt-1.5 pb-0.5 text-xs text-muted uppercase">
                          Move to
                        </div>
                        {TABS.filter((t) => t.id !== 'topic' && t.id !== r.category).map((t) => (
                          <button
                            key={t.id}
                            role="menuitem"
                            className="w-full rounded-lg px-3 py-1.5 text-left hover:bg-hover"
                            onClick={() => void move(r, t.id as RegCat)}
                          >
                            {t.label}
                          </button>
                        ))}
                        {r.category === 'person' && (
                          <button
                            role="menuitem"
                            className="mt-1 w-full rounded-lg px-3 py-1.5 text-left hover:bg-hover"
                            onClick={() => void setAmbiguous(r, !r.ambiguous)}
                          >
                            {r.ambiguous ? 'Link this name again' : 'Never link this name alone'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {shown.length === 0 && (
              <p className="py-12 text-center text-sm text-muted">Nothing here yet.</p>
            )}
          </>
        )}
      </div>
      {merge && (
        <MergeDialog
          rows={merge}
          onClose={() => setMerge(null)}
          onDone={(c, o) => doMerge(merge[0].category, c, o)}
        />
      )}
    </div>
  )
}
