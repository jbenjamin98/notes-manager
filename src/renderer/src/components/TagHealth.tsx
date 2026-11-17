import { useEffect, useState } from 'react'
import type { Output } from '@shared/contract'

type Health = Output<'tags:health'>

/**
 * Tag Health: how often automatic tags are kept versus taken off, and which words keep getting
 * removed. A word you take off is added to "never tag these"; it can be allowed again here.
 */
export default function TagHealth(): React.JSX.Element {
  const [h, setH] = useState<Health | null>(null)
  const [ignore, setIgnore] = useState<string[]>([])

  const load = (): void => {
    void window.api.invoke('tags:health').then((r) => r.ok && setH(r.data))
    void window.api.invoke('settings:get').then((r) => r.ok && setIgnore(r.data.autoTag.ignore))
  }
  useEffect(load, [])

  const allow = async (word: string): Promise<void> => {
    const next = ignore.filter((w) => w.toLowerCase() !== word)
    setIgnore(next)
    await window.api.invoke('settings:update', { autoTag: { ignore: next } })
    load()
  }

  if (!h) return <></>
  const kept = h.tagged + h.accepted
  const total = kept + h.rejected
  const rate = total ? Math.round((kept / total) * 100) : null
  const trouble = h.words.filter((w) => w.rejected > 0).slice(0, 12)

  return (
    <div className="mt-5" data-testid="tag-health">
      <p className="text-sm font-medium">Tag health</p>
      {total === 0 ? (
        <p className="mt-1 text-xs text-muted">
          Nothing yet. As you write, this shows how many automatic tags you keep and which ones you
          take off.
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted" data-testid="tag-health-summary">
            {kept} of {total} automatic tags kept ({rate}%): {h.tagged} written, {h.accepted}{' '}
            accepted with Tab, {h.rejected} taken off.
          </p>
          {trouble.length > 0 && (
            <ul className="mt-2 space-y-1" data-testid="tag-health-words">
              {trouble.map((w) => (
                <li key={`${w.sigil}${w.word}`} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    {w.sigil}
                    {w.word}
                    <span className="text-muted">
                      {' '}
                      · kept {w.tagged + w.accepted}, removed {w.rejected}
                    </span>
                  </span>
                  {w.ignored ? (
                    <button
                      className="rounded-md border border-line bg-field px-2 py-0.5 hover:bg-hover"
                      onClick={() => void allow(w.word)}
                    >
                      Allow again
                    </button>
                  ) : (
                    <span className="text-muted">still tagged</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
