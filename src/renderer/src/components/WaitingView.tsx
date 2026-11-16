import { useMemo } from 'react'
import { shortDate, todayIso } from '../format'
import { daysSince } from '../tasks'
import { useWaiting, type WaitingItem as Item } from '../hooks'

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

/**
 * Waiting On: one card per person, oldest first. These are notes, not your tasks: "Got It" strikes
 * the line through in its note; "Nudge" copies a polite follow-up.
 */
export default function WaitingView({
  onOpenNote,
  onFlash
}: {
  onOpenNote: (path: string) => void
  onFlash: (m: string) => void
}): React.JSX.Element | null {
  const { items, reload } = useWaiting()
  const today = todayIso()
  const groups = useMemo(() => {
    const m = new Map<string, Item[]>()
    for (const i of items) m.set(i.who, [...(m.get(i.who) ?? []), i])
    return [...m.entries()].sort((a, b) => a[1][0].since.localeCompare(b[1][0].since))
  }, [items])

  if (groups.length === 0) return null

  const gotIt = async (i: Item): Promise<void> => {
    const r = await window.api.invoke('waiting:done', { path: i.notePath, line: i.line })
    if (r.ok && r.data) onFlash(`Marked as received from ${i.who}`)
    else onFlash('That line changed in its note. Open the note to update it.')
    reload()
  }
  const nudge = async (i: Item): Promise<void> => {
    const due = i.due ? ` It was due ${shortDate(i.due)}.` : ''
    await navigator.clipboard.writeText(
      `Hi ${i.who.split(' ')[0]}, quick follow-up on "${i.text}" (from ${i.noteTitle}).${due} Do you have an update?`
    )
    onFlash('Follow-up copied. Paste it into chat or email.')
  }

  return (
    <div className="grid gap-3 px-2 pb-4 sm:grid-cols-2" data-testid="waiting-on">
      {groups.map(([who, list]) => (
        <section key={who} className="card-modern p-3">
          <header className="mb-2 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
              {initials(who)}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold">{who}</h3>
              <p className="text-xs text-muted">
                {list.length} open · waiting {daysSince(list[0].since, today)}d
              </p>
            </div>
          </header>
          <ul className="space-y-1.5">
            {list.map((i) => {
              const late = i.due !== null && i.due < today
              return (
                <li
                  key={i.notePath + i.line}
                  className="group rounded-lg border border-line bg-field/50 px-2.5 py-2"
                >
                  <p className="text-sm leading-snug">{i.text}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    {i.due && (
                      <span
                        className={`rounded-full px-1.5 py-0.5 ${late ? 'bg-danger/10 text-danger' : 'bg-hover'}`}
                      >
                        Due {shortDate(i.due)}
                      </span>
                    )}
                    <button
                      className="truncate underline-offset-2 hover:text-fg hover:underline"
                      onClick={() => onOpenNote(i.notePath)}
                    >
                      {i.noteTitle}
                    </button>
                    <span className="ml-auto flex gap-1 opacity-70 group-hover:opacity-100">
                      <button
                        className="rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg"
                        onClick={() => void nudge(i)}
                      >
                        Nudge
                      </button>
                      <button
                        className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-accent-soft"
                        onClick={() => void gotIt(i)}
                      >
                        Got It
                      </button>
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
