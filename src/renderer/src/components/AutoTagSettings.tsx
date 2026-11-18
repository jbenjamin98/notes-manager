import { useEffect, useState } from 'react'
import TagHealth from './TagHealth'

interface Cfg {
  enabled: boolean
  ai: boolean
  ignore: string[]
  hidden?: string[]
}

/** Writing the missing @ and # as you type: on or off, AI help for new things, and words never tagged. */
export default function AutoTagSettings(): React.JSX.Element {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [word, setWord] = useState('')
  const [usage, setUsage] = useState<{ today: number; cap: number } | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.invoke('settings:get').then((r) => alive && r.ok && setCfg(r.data.autoTag))
    void window.api.invoke('tags:usage').then((r) => alive && r.ok && setUsage(r.data))
    const off = window.api.on('settings:changed', (s) => alive && setCfg(s.autoTag))
    return () => {
      alive = false
      off()
    }
  }, [])

  const save = async (patch: Partial<Cfg>): Promise<void> => {
    setCfg((c) => (c ? { ...c, ...patch } : c))
    await window.api.invoke('settings:update', { autoTag: patch })
  }

  if (!cfg) return <></>
  const add = (): void => {
    const w = word.trim().toLowerCase()
    setWord('')
    if (w && !cfg.ignore.includes(w)) void save({ ignore: [...cfg.ignore, w] })
  }
  return (
    <>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
        />
        <span>
          Tag names and topics as I type
          <span className="block text-xs text-muted">
            Type “Tell Matt he likes cats” and it becomes “Tell @Matt he likes #cats”. Only the word
            you just finished changes, and Ctrl+Z puts it back.
          </span>
        </span>
      </label>
      <label className="mt-2 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={cfg.ai}
          disabled={!cfg.enabled}
          onChange={(e) => void save({ ai: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
        />
        <span>
          Let AI find new topics and names
          <span className="block text-xs text-muted">
            After you finish a line, a small model suggests up to four topics and five names that
            are not in your lists yet. It leans toward tagging too much rather than too little. Only
            that line is sent. New names are added to your lists. It is only asked when the rules
            could not work something out.
            {usage && (
              <span data-testid="tag-usage" className="mt-1 block">
                AI calls today: {usage.today} of {usage.cap}
              </span>
            )}
          </span>
        </span>
      </label>
      <div className="mt-3">
        <p className="text-sm font-medium">Never tag these words</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="tag-ignore">
          {cfg.ignore.length === 0 && (
            <span className="text-xs text-muted">
              None. A tag you delete right after it is written is added here.
            </span>
          )}
          {cfg.ignore.map((w) => (
            <span
              key={w}
              className="flex items-center gap-1 rounded-full border border-line bg-field px-2.5 py-0.5 text-xs"
            >
              {w}
              <button
                aria-label={`Allow tagging ${w} again`}
                className="text-muted hover:text-fg"
                onClick={() => void save({ ignore: cfg.ignore.filter((x) => x !== w) })}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input
            value={word}
            onChange={(e) => setWord(e.target.value)}
            placeholder="Add a word…"
            aria-label="Word to never tag"
            className="w-44 rounded-lg border border-line bg-field px-3 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={!word.trim()}
            className="rounded-md border border-line bg-field px-3 py-1 text-sm font-medium hover:bg-hover disabled:opacity-50"
          >
            Add
          </button>
        </form>
      </div>
      {(cfg.hidden ?? []).length > 0 && (
        <div className="mt-4" data-testid="hidden-names">
          <p className="text-sm font-medium">Deleted names</p>
          <p className="text-xs text-muted">
            Not listed or tagged any more. Your notes were not changed. ✕ brings one back.
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(cfg.hidden ?? []).map((w) => (
              <span
                key={w}
                className="flex items-center gap-1 rounded-full border border-line bg-field px-2.5 py-0.5 text-xs"
              >
                {w}
                <button
                  aria-label={`Bring back ${w}`}
                  className="text-muted hover:text-fg"
                  onClick={() => {
                    void window.api.invoke('entities:hide', { name: w, on: false })
                    setCfg((c) =>
                      c ? { ...c, hidden: (c.hidden ?? []).filter((x) => x !== w) } : c
                    )
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <TagHealth />
    </>
  )
}
