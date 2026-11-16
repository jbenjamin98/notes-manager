import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../useFocusTrap'

export type RegCat = 'person' | 'customer' | 'system' | 'project' | 'place'

export interface EditorValue {
  category: RegCat
  name: string
  aliases: string[]
  /** Set when editing an existing registry entry (enables rename and remove). */
  originalName?: string
}

const OPTIONS: [RegCat, string][] = [
  ['person', 'Person'],
  ['customer', 'Company'],
  ['project', 'Project'],
  ['system', 'System'],
  ['place', 'Place']
]

/** Small glass dialog to add or edit a person, account or system and its aliases. */
export default function EntityEditor({
  value,
  onCancel,
  onSave,
  onRemove
}: {
  value: EditorValue
  onCancel: () => void
  onSave: (v: EditorValue) => Promise<string | null>
  onRemove?: (v: EditorValue) => Promise<void>
}): React.JSX.Element {
  const [category, setCategory] = useState<RegCat>(value.category)
  const [name, setName] = useState(value.name)
  const [aliases, setAliases] = useState(value.aliases.join(', '))
  const [err, setErr] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLFormElement>(null)
  useFocusTrap(dialog, onCancel)
  useEffect(() => nameRef.current?.focus(), [])
  const editing = value.originalName !== undefined

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) return setErr('A name is required.')
    const list = aliases
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
    const m = await onSave({
      category,
      name: name.trim(),
      aliases: list,
      originalName: value.originalName
    })
    if (m) setErr(m)
  }

  const field = 'mt-1 w-full rounded-lg border border-line bg-field px-3 py-2 text-sm'
  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <form
        onSubmit={(e) => void submit(e)}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit names' : 'Add to your list'}
        className="glass w-[26rem] rounded-2xl p-5"
        style={{ background: 'var(--sticky)' }}
      >
        <h2 className="mb-3 text-lg font-semibold">
          {editing ? 'Edit' : 'Add a person, account or system'}
        </h2>
        {!editing && (
          <div
            role="radiogroup"
            aria-label="Type"
            className="mb-3 inline-flex gap-1 rounded-lg bg-hover p-1"
          >
            {OPTIONS.map(([c, label]) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                onClick={() => setCategory(c)}
                className={`rounded-md px-3 py-1 text-sm font-medium ${
                  category === c ? 'bg-field shadow-sm' : 'text-muted hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <label className="block text-sm">
          Name
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
          />
        </label>
        <label className="mt-3 block text-sm">
          Also known as
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="Sarah, SC"
            className={field}
          />
          <span className="mt-1 block text-xs text-muted">
            Separate with commas. Every note that uses any of these names counts toward this one.
          </span>
        </label>
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
        <div className="mt-4 flex items-center gap-2">
          {editing && onRemove && (
            <button
              type="button"
              onClick={() => (confirmRemove ? void onRemove(value) : setConfirmRemove(true))}
              className="rounded-lg px-3 py-1.5 text-sm text-danger hover:bg-danger/10"
            >
              {confirmRemove ? 'Click again to remove' : 'Remove'}
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary rounded-lg px-4 py-1.5 text-sm font-semibold"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
