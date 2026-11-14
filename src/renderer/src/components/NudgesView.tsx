import { useEffect, useMemo, useState } from 'react'
import type { NudgeAction, NudgeItem } from '@shared/contract'
import { ageLabel } from '../format'
import { useNow } from '../hooks'

const RULE_LABEL: Record<NudgeItem['rule'], string> = {
  brief: 'Morning brief',
  prep: 'Meeting prep',
  'empty-note': 'Capture notes',
  overload: 'Heavy day',
  followup: 'Follow-up',
  blocker: 'Blocker',
  eod: 'End of day',
  reminder: 'Reminder',
  rollup: 'Weekly review'
}

const localDay = (iso: string): string => new Date(iso).toLocaleDateString('en-CA')

const btn = 'rounded-md border border-line bg-field px-2.5 py-1 text-xs font-medium hover:bg-hover'

export default function NudgesView({
  onAction,
  onSettings
}: {
  onAction: (a: NudgeAction) => void
  onSettings: () => void
}): React.JSX.Element {
  const now = useNow()
  const [items, setItems] = useState<NudgeItem[] | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api.invoke('nudges:list').then((r) => alive && r.ok && setItems(r.data))
    }
    load()
    const off = window.api.on('nudges:changed', load)
    // Opening the feed counts as reading it.
    void window.api.invoke('nudges:read')
    return () => {
      alive = false
      off()
    }
  }, [])

  const groups = useMemo(() => {
    const today = new Date().toLocaleDateString('en-CA')
    const g = new Map<string, NudgeItem[]>()
    for (const n of items ?? []) {
      const label = localDay(n.createdAt) === today ? 'Today' : 'Earlier'
      g.set(label, [...(g.get(label) ?? []), n])
    }
    return [...g.entries()]
  }, [items])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <header className="mb-4 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Nudges</h1>
            <p className="mt-1 text-xs text-muted">
              Reminders worked out on this computer from your calendar, notes, tasks and mail.
            </p>
          </div>
          <button className={btn} onClick={onSettings}>
            Choose which ones
          </button>
        </header>

        {items !== null && items.length === 0 && (
          <div className="py-16 text-center text-sm text-muted">
            <p>Nothing needs you right now.</p>
            <p className="mt-1 text-xs">
              Your morning brief, meeting prep and follow-up reminders will appear here.
            </p>
          </div>
        )}

        {groups.map(([label, list]) => (
          <section key={label} className="mb-6">
            <h2 className="mb-2 px-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
              {label}
            </h2>
            <ul className="space-y-3">
              {list.map((n) => (
                <li key={n.id} className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">
                      {RULE_LABEL[n.rule]}
                    </span>
                    <span>{ageLabel(n.createdAt, now)}</span>
                    <span className="flex-1" />
                    <button
                      className="rounded px-1.5 hover:bg-hover hover:text-fg"
                      title="Remind me in an hour"
                      onClick={() =>
                        void window.api.invoke('nudges:snooze', { id: n.id, minutes: 60 })
                      }
                    >
                      Snooze 1h
                    </button>
                    <button
                      className="rounded px-1.5 hover:bg-hover hover:text-fg"
                      aria-label={`Dismiss "${n.title}"`}
                      title="Dismiss"
                      onClick={() => void window.api.invoke('nudges:dismiss', { id: n.id })}
                    >
                      ✕
                    </button>
                  </div>
                  <h3 className="text-sm font-semibold">{n.title}</h3>
                  {n.body && (
                    <p className="mt-1 text-sm whitespace-pre-line text-muted">{n.body}</p>
                  )}
                  {n.actions.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {n.actions.map((a, i) => (
                        <button key={i} className={btn} onClick={() => onAction(a)}>
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
