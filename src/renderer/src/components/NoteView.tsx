import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteEntity, NoteSummary, TaskRow, VocabEntry } from '@shared/contract'
import { dayLabel } from '../format'
import Editor, { type EditorHandle } from './Editor'
import TaskList from './TaskList'

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'
interface Stale {
  content: string
  hash: string
}

const AUTOSAVE_MS = 800
const PLACEHOLDER_TITLE = 'Untitled'

export default function NoteView({
  path,
  summary,
  autoFocusTitle,
  autoFocusEditor,
  onOpenPath,
  onOpenEntity,
  onRenamed
}: {
  path: string
  summary: NoteSummary | undefined
  autoFocusTitle: boolean
  autoFocusEditor: boolean
  onOpenPath: (p: string) => void
  onOpenEntity: (id: string) => void
  onRenamed: (newPath: string) => void
}): React.JSX.Element {
  const [initial, setInitial] = useState<string | null>(null)
  const [docKey, setDocKey] = useState(path)
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [tags, setTags] = useState<NoteEntity[]>([])
  const vocab = useRef<VocabEntry[]>([])
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [stale, setStale] = useState<Stale | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState(
    summary && summary.title !== PLACEHOLDER_TITLE ? summary.title : ''
  )

  const handle = useRef<EditorHandle | null>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const baseHash = useRef('')
  const dirty = useRef(false)
  const saving = useRef<Promise<void> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadTasks = useCallback(async () => {
    const r = await window.api.invoke('tasks:for-note', { path })
    if (r.ok) setTasks(r.data)
  }, [path])

  // Auto-tags for this note (the "Tagged" chips) and the vocabulary the editor underlines.
  const loadTags = useCallback(async () => {
    const [t, v] = await Promise.all([
      window.api.invoke('notes:entities', { path }),
      window.api.invoke('entities:vocabulary')
    ])
    if (t.ok) setTags(t.data)
    if (v.ok) {
      vocab.current = v.data
      handle.current?.setVocab(v.data)
    }
  }, [path])

  // Initial load (component is keyed by path, so this runs once per note).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const r = await window.api.invoke('notes:read', { path })
      if (cancelled) return
      if (!r.ok) return setError(r.error.message)
      baseHash.current = r.data.hash
      setInitial(r.data.content)
      setDocKey(`${path}:${r.data.hash}`)
      void loadTasks()
      void loadTags()
    })()
    return () => {
      cancelled = true
    }
  }, [path, loadTasks, loadTags])

  // The editor mounts after the note loads: hand it the vocabulary once it exists.
  useEffect(() => {
    if (initial !== null) handle.current?.setVocab(vocab.current)
  }, [initial, docKey])

  useEffect(() => {
    if (autoFocusTitle) titleInput.current?.focus()
  }, [autoFocusTitle])

  // Editor mounts once the note has loaded (child effects run first, so the handle exists).
  useEffect(() => {
    if (autoFocusEditor && initial !== null) handle.current?.focus()
  }, [autoFocusEditor, initial])

  const save = useCallback(async (): Promise<void> => {
    if (saving.current) await saving.current
    if (!dirty.current || !handle.current) return
    const run = async (): Promise<void> => {
      const sent = handle.current!.getText()
      setSaveState('saving')
      const r = await window.api.invoke('notes:save', {
        path,
        content: sent,
        baseHash: baseHash.current
      })
      if (!r.ok) {
        setSaveState('error')
        setError(r.error.message)
        return
      }
      if (!r.data.ok) {
        // Disk changed since we loaded (e.g. Drive delivered a newer copy). Never overwrite silently.
        setStale({ content: r.data.content, hash: r.data.hash })
        setSaveState('error')
        return
      }
      baseHash.current = r.data.hash
      if (handle.current?.getText() === sent) {
        dirty.current = false
        setSaveState('saved')
        // The indexer may have added task ids; show them without disturbing the cursor.
        handle.current?.setText(r.data.content)
      } else {
        setSaveState('dirty')
      }
      setError(null)
      void loadTasks()
    }
    saving.current = run().finally(() => (saving.current = null))
    await saving.current
  }, [path, loadTasks])

  const onChange = useCallback(() => {
    dirty.current = true
    setSaveState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), AUTOSAVE_MS)
  }, [save])

  // Flush on unmount / note switch.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (dirty.current) void save()
    },
    [save]
  )

  // External changes (Drive sync, other tools, task toggles, title edits).
  useEffect(() => {
    return window.api.on('vault:changed', ({ paths }) => {
      if (paths.length && !paths.includes(path)) return
      void loadTasks()
      void loadTags()
      if (dirty.current || saving.current) return // detected at save time instead
      void window.api.invoke('notes:read', { path }).then((r) => {
        if (r.ok && r.data.hash !== baseHash.current && !dirty.current) {
          baseHash.current = r.data.hash
          handle.current?.setText(r.data.content)
        }
      })
    })
  }, [path, loadTasks, loadTags])

  const toggle = useCallback(
    async (id: string, done: boolean) => {
      await save() // never patch a file whose latest edits are still unsaved
      await window.api.invoke('tasks:toggle', { id, done })
      void loadTasks()
    },
    [save, loadTasks]
  )

  const commitTitle = async (): Promise<void> => {
    const t = title.trim()
    if (!t || t === summary?.title) return
    await save()
    const r = await window.api.invoke('notes:set-title', { path, title: t })
    if (!r.ok) return setError(r.error.message)
    if (r.data.path !== path) onRenamed(r.data.path)
  }

  const loadDisk = (): void => {
    if (!stale) return
    baseHash.current = stale.hash
    dirty.current = false
    handle.current?.setText(stale.content)
    setStale(null)
    setSaveState('saved')
    void loadTasks()
  }

  const keepMine = async (): Promise<void> => {
    const r = await window.api.invoke('notes:force-save', {
      path,
      content: handle.current?.getText() ?? ''
    })
    if (r.ok && r.data.ok) {
      baseHash.current = r.data.hash
      dirty.current = false
      setStale(null)
      setSaveState('saved')
      void loadTasks()
    }
  }

  const orig = path.replace(/ \(\d+\)(\.md)$/i, '$1')
  const saveLabel: Record<SaveState, string> = {
    saved: 'Saved',
    dirty: 'Editing…',
    saving: 'Saving…',
    error: 'Not saved'
  }

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-5 pb-3">
        <input
          ref={titleInput}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commitTitle().then(() => handle.current?.focus())
            }
          }}
          placeholder={PLACEHOLDER_TITLE}
          aria-label="Note title"
          className="w-full bg-transparent text-2xl font-semibold tracking-tight placeholder:text-muted/60 focus-visible:outline-none"
        />
        <div className="mt-1 flex items-center gap-2 text-xs text-muted">
          {summary && (
            <span>
              {dayLabel(summary.date)}
              {summary.account ? ` · ${summary.account}` : ''}
            </span>
          )}
          <span
            className={`ml-auto ${saveState === 'error' ? 'text-danger' : ''}`}
            aria-live="polite"
          >
            {saveLabel[saveState]}
          </span>
        </div>
      </header>

      {summary?.isConflict && (
        <div className="mx-6 mb-2 rounded-md bg-warn/15 px-3 py-2 text-sm text-warn">
          This looks like a Google Drive conflict copy.
          {orig !== path && (
            <button className="ml-2 underline" onClick={() => onOpenPath(orig)}>
              Open the original
            </button>
          )}
        </div>
      )}
      {stale && (
        <div className="mx-6 mb-2 flex flex-wrap items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          This note changed on disk while you were editing. Nothing was overwritten.
          <button className="rounded-md border border-danger/40 px-2 py-0.5" onClick={loadDisk}>
            Use the disk version
          </button>
          <button
            className="rounded-md border border-danger/40 px-2 py-0.5"
            onClick={() => void keepMine()}
          >
            Keep mine
          </button>
        </div>
      )}
      {error && !stale && (
        <div className="mx-6 mb-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {tags.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 px-6 pb-2"
          aria-label="Tagged in this note"
        >
          <span className="text-xs text-muted">Tagged</span>
          {tags.map((t) => (
            <button
              key={t.id}
              onClick={() => onOpenEntity(t.id)}
              title={`Open ${t.name}`}
              className="flex items-center gap-1.5 rounded-full border border-line bg-field px-2 py-0.5 text-xs hover:bg-hover"
            >
              <span
                className="h-2 w-2 rounded-sm"
                style={{
                  background:
                    t.category === 'person'
                      ? 'var(--s1)'
                      : t.category === 'customer'
                        ? 'var(--s2)'
                        : t.category === 'system'
                          ? 'var(--s3)'
                          : 'var(--muted)',
                  borderRadius:
                    t.category === 'person' ? '9999px' : t.category === 'topic' ? '0' : undefined
                }}
              />
              {t.category === 'topic' ? `#${t.name}` : t.name}
            </button>
          ))}
        </div>
      )}

      <TaskList tasks={tasks} onToggle={(id, done) => void toggle(id, done)} />

      <div className="min-h-0 flex-1 overflow-hidden px-6">
        <div className="mx-auto h-full max-w-3xl">
          {initial !== null && (
            <Editor
              docKey={docKey}
              initial={initial}
              onChange={onChange}
              onSave={() => void save()}
              onOpenEntity={onOpenEntity}
              handleRef={handle}
            />
          )}
        </div>
      </div>
    </div>
  )
}
