import { useCallback, useEffect, useState } from 'react'
import type { Output } from '@shared/contract'
import CategoryIcon, { type CategoryKind } from './CategoryIcon'

type Item = Output<'tags:discover'>[number]
type Kind = Item['kind']

const KINDS: { id: Kind; label: string }[] = [
  { id: 'person', label: 'Person' },
  { id: 'customer', label: 'Company' },
  { id: 'project', label: 'Project' },
  { id: 'system', label: 'System' },
  { id: 'place', label: 'Place' },
  { id: 'topic', label: 'Topic' }
]

const pill =
  'rounded-full border border-line bg-field px-2.5 py-0.5 text-xs font-medium transition hover:border-accent hover:bg-accent-soft disabled:opacity-50'

/** The sentence with the suggested word in bold, so you can judge what it is. */
function Example({ text, word }: { text: string; word: string }): React.JSX.Element {
  const i = text.indexOf(word)
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-accent-soft px-0.5 font-semibold text-fg">{word}</mark>
      {text.slice(i + word.length)}
    </>
  )
}

/**
 * Names and topics that keep coming up in your notes but are not tagged yet, found by counting
 * (no AI). Add one as the right kind, or dismiss it; nothing is written into a note.
 */
export default function SuggestedTags({
  onFlash
}: {
  onFlash: (m: string) => void
}): React.JSX.Element | null {
  const [items, setItems] = useState<Item[] | null>(null)
  const [kinds, setKinds] = useState<Record<string, Kind>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void window.api.invoke('tags:discover').then((r) => r.ok && setItems(r.data))
  }, [])
  useEffect(() => {
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [load])

  const drop = (text: string): void => setItems((l) => (l ?? []).filter((i) => i.text !== text))

  const add = async (i: Item): Promise<void> => {
    const kind = kinds[i.text] ?? i.kind
    setBusy(true)
    const s = await window.api.invoke('settings:get')
    if (kind === 'topic') {
      if (s.ok)
        await window.api.invoke('settings:update', {
          autoTag: {
            topics: [...new Set([...(s.data.autoTag.topics ?? []), i.text.toLowerCase()])]
          }
        })
    } else {
      await window.api.invoke('tags:learn', { names: [{ name: i.text, category: kind }] })
    }
    setBusy(false)
    drop(i.text)
    onFlash(`${i.text} will be tagged ${kind === 'topic' ? '#' : '@'}${i.text} from now on.`)
  }
  const dismiss = async (i: Item): Promise<void> => {
    setBusy(true)
    const s = await window.api.invoke('settings:get')
    if (s.ok)
      await window.api.invoke('settings:update', {
        autoTag: { ignore: [...new Set([...s.data.autoTag.ignore, i.text.toLowerCase()])] }
      })
    setBusy(false)
    drop(i.text)
  }

  if (!items || items.length === 0) return null
  return (
    <section className="card-modern p-4" data-testid="suggested-tags">
      <h3 className="text-lg font-semibold tracking-tight">Suggested Tags</h3>
      <p className="mt-0.5 text-sm text-muted">
        These keep coming up in your notes but are not tagged yet. Counted on this computer, no AI.
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((i) => {
          const kind = kinds[i.text] ?? i.kind
          return (
            <li key={i.text} className="rounded-xl border border-line bg-field/40 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <CategoryIcon
                  kind={(kind === 'topic' ? 'topic' : kind) as CategoryKind}
                  size={20}
                />
                <span className="font-medium">{i.text}</span>
                <span className="text-xs text-muted">
                  in {i.notes} note{i.notes === 1 ? '' : 's'}
                </span>
                <select
                  aria-label={`What is ${i.text}?`}
                  value={kind}
                  onChange={(e) => setKinds((k) => ({ ...k, [i.text]: e.target.value as Kind }))}
                  className="ml-auto rounded-lg border border-line bg-field px-2 py-0.5 text-xs"
                >
                  {KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <button className={pill} disabled={busy} onClick={() => void add(i)}>
                  Add
                </button>
                <button className={pill} disabled={busy} onClick={() => void dismiss(i)}>
                  Ignore
                </button>
              </div>
              {i.example && (
                <p className="mt-1 text-sm leading-snug text-muted">
                  <Example text={i.example} word={i.text} />
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
