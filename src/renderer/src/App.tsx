import { useCallback, useEffect, useState } from 'react'
import Sidebar, { type Tab } from './components/Sidebar'
import NoteView from './components/NoteView'
import Settings from './components/Settings'
import TasksView from './components/TasksView'
import EntityView from './components/EntityView'
import InsightsView from './components/InsightsView'
import EmailView from './components/EmailView'
import NudgesView from './components/NudgesView'
import CalendarView from './components/CalendarView'
import PrepView from './components/PrepView'
import AssistantDrawer from './components/AssistantDrawer'
import RollupView from './components/RollupView'
import LibraryView from './components/LibraryView'
import SetupGuide from './components/SetupGuide'
import CommandPalette, { type PaletteAction } from './components/CommandPalette'
import type { NudgeAction } from '@shared/contract'
import EntityEditor, { type EditorValue } from './components/EntityEditor'
import type { Dossier } from '@shared/contract'
import type { TaskFilter } from './tasks'
import { NoteIcon } from './components/Icons'
import { useAppData } from './hooks'
import { useTheme } from './theme'
import { todayIso } from './format'

const TAB_KEY = 'nm-tab'
const readTab = (): Tab => {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'notes' || v === 'tasks' || v === 'explore' ? v : 'meetings'
  } catch {
    return 'meetings'
  }
}

function App(): React.JSX.Element {
  const { notes, tasks, entities, gmail, mail, unreadNudges, upcoming, cal, refreshNotes } =
    useAppData()
  const [theme, setTheme] = useTheme()
  const [selected, setSelected] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const [focusEditorFor, setFocusEditorFor] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tab, setTabState] = useState<Tab>(readTab)
  const [view, setView] = useState<
    | 'note'
    | 'tasks'
    | 'entity'
    | 'insights'
    | 'email'
    | 'nudges'
    | 'calendar'
    | 'prep'
    | 'rollup'
    | 'library'
  >(() => {
    const t = readTab()
    return t === 'tasks'
      ? 'tasks'
      : t === 'explore'
        ? 'insights'
        : t === 'notes'
          ? 'library'
          : 'note'
  })
  const [entityId, setEntityId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorValue | null>(null)
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('mine')
  const [toast, setToast] = useState<string | null>(null)
  const [copilot, setCopilot] = useState(false)
  const [palette, setPalette] = useState(false)
  const [guide, setGuide] = useState(false)
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null)

  // First run: walk through setup once.
  useEffect(() => {
    void window.api.invoke('settings:get').then((r) => {
      if (r.ok && !r.data.setupDone) setGuide(true)
    })
  }, [])
  const finishGuide = (): void => {
    setGuide(false)
    void window.api.invoke('settings:update', { setupDone: true })
  }

  const setTab = (t: Tab): void => {
    setTabState(t)
    if (t === 'tasks') {
      setView('tasks')
      setSettingsOpen(false)
    } else if (t === 'notes') {
      setView('library')
      setSettingsOpen(false)
    } else if (t === 'explore' && view !== 'entity') {
      setView('insights')
      setSettingsOpen(false)
    }
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      /* ignore */
    }
  }

  // Derived, not stored: a note deleted/moved outside the app simply stops being selected.
  const selectedPath = selected && notes.some((n) => n.path === selected) ? selected : null
  const current = notes.find((n) => n.path === selectedPath)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 5000)
  }, [])

  const open = useCallback((path: string) => {
    setSelected(path)
    setView('note')
    setSettingsOpen(false)
  }, [])

  const openEntity = useCallback((id: string) => {
    setEntityId(id)
    setView('entity')
    setSettingsOpen(false)
    setTabState('explore')
  }, [])

  const openInsights = useCallback(() => {
    setView('insights')
    setSettingsOpen(false)
  }, [])

  const editEntity = useCallback((d: Dossier) => {
    if (d.category === 'topic' || d.category === 'event') return
    setEditor({
      category: d.category,
      name: d.name,
      aliases: d.aliases,
      originalName: d.inRegistry ? d.name : undefined
    })
  }, [])

  const saveEntity = useCallback(
    async (v: EditorValue): Promise<string | null> => {
      const r = await window.api.invoke('entities:upsert', {
        category: v.category,
        name: v.name,
        aliases: v.aliases,
        originalName: v.originalName
      })
      if (!r.ok) return r.error.message
      setEditor(null)
      flash('Saved. Your notes were re-scanned.')
      openEntity(`${v.category}:${v.name.toLowerCase()}`)
      return null
    },
    [flash, openEntity]
  )

  const removeEntity = useCallback(
    async (v: EditorValue) => {
      const r = await window.api.invoke('entities:remove', {
        category: v.category,
        name: v.originalName ?? v.name
      })
      if (!r.ok) return flash(r.error.message)
      setEditor(null)
      flash('Removed from your list.')
      openInsights()
    },
    [flash, openInsights]
  )

  const pickFilter = useCallback((f: TaskFilter) => {
    setTaskFilter(f)
    setView('tasks')
    setSettingsOpen(false)
  }, [])

  const toggleTask = useCallback((id: string, done: boolean) => {
    void window.api.invoke('tasks:toggle', { id, done })
  }, [])

  const setDue = useCallback(
    async (id: string, due: string | null) => {
      const r = await window.api.invoke('tasks:set-due', { id, due })
      if (!r.ok) flash(r.error.message)
    },
    [flash]
  )

  const newNote = useCallback(async () => {
    const r = await window.api.invoke('notes:create', {
      kind: 'adhoc',
      title: 'Untitled',
      date: todayIso()
    })
    if (!r.ok) return flash(r.error.message)
    await refreshNotes()
    setJustCreated(r.data.path)
    open(r.data.path)
  }, [refreshNotes, open, flash])

  const openEvent = useCallback(
    async (id: string) => {
      const r = await window.api.invoke('calendar:open-event', { id })
      if (!r.ok) return flash(r.error.message)
      await refreshNotes()
      // A meeting that had no notes yet is ready to type into straight away.
      if (!upcoming.find((e) => e.id === id)?.notePath) setFocusEditorFor(r.data.path)
      open(r.data.path)
    },
    [refreshNotes, open, flash, upcoming]
  )

  const sync = useCallback(() => {
    void window.api.invoke('calendar:sync')
    void window.api.invoke('gmail:sync')
  }, [])

  const [prepEventId, setPrepEventId] = useState<string | null>(null)
  const [backTo, setBackTo] = useState<typeof view>('calendar')

  const openCalendar = useCallback(() => {
    setView('calendar')
    setSettingsOpen(false)
  }, [])

  const openPrep = useCallback(
    (id: string) => {
      setBackTo(view === 'prep' ? backTo : view)
      setPrepEventId(id)
      setView('prep')
      setSettingsOpen(false)
    },
    [view, backTo]
  )

  const openNudges = useCallback(() => {
    setView('nudges')
    setSettingsOpen(false)
  }, [])

  const openRollup = useCallback(() => {
    setView('rollup')
    setSettingsOpen(false)
  }, [])

  const openEmail = useCallback(() => {
    setView('email')
    setSettingsOpen(false)
  }, [])
  const connect = useCallback(() => void window.api.invoke('google:open-login'), [])

  // What a nudge's buttons do.
  const runAction = useCallback(
    async (a: NudgeAction) => {
      if (a.type === 'open-prep') openPrep(a.id)
      else if (a.type === 'open-event') await openEvent(a.id)
      else if (a.type === 'open-note') open(a.path)
      else if (a.type === 'open-tasks') pickFilter(a.filter as TaskFilter)
      else if (a.type === 'open-rollup') openRollup()
      else openEmail()
    },
    [openEvent, open, pickFilter, openEmail, openPrep, openRollup]
  )

  // Clicking a Windows toast brings the app forward on the Nudges page.
  useEffect(
    () =>
      window.api.on('nudges:focus', () => {
        setView('nudges')
        setSettingsOpen(false)
      }),
    []
  )

  /** Ask the Co-Pilot to restructure the open note. It proposes a NEW tidy note; nothing is overwritten. */
  const tidyNote = async (): Promise<void> => {
    if (!selectedPath) return
    const r = await window.api.invoke('notes:read', { path: selectedPath })
    if (!r.ok) return flash(r.error.message)
    const content = r.data.content
    if (/\bCUI\b/i.test(content))
      return flash('This note is marked CUI, so it is never sent to an AI.')
    const body = content.replace(/^---[\s\S]*?\n---\s*/, '').trim()
    if (body.length < 20) return flash('There is not enough in this note to tidy yet.')
    setCopilot(true)
    setSeed({
      text:
        'Tidy this note into a structured note. Keep every fact and do not invent any.\n\n' +
        body.slice(0, 6000),
      nonce: Date.now()
    })
  }

  const paletteActions: PaletteAction[] = [
    ...(view === 'note' && selectedPath && !settingsOpen
      ? [
          {
            id: 'tidy',
            label: 'Tidy this note with the Co-Pilot',
            hint: 'makes a new note',
            run: () => void tidyNote()
          }
        ]
      : []),
    { id: 'new', label: 'New note', hint: 'Ctrl+N', run: () => void newNote() },
    { id: 'ask', label: 'Open Co-Pilot', hint: 'Ctrl+J', run: () => setCopilot(true) },
    { id: 'tasks', label: 'Go to tasks', run: () => setTab('tasks') },
    { id: 'library', label: 'All notes (by week, account, person...)', run: () => setTab('notes') },
    { id: 'cal', label: 'Go to calendar', run: openCalendar },
    { id: 'mail', label: 'Go to email follow-ups', run: openEmail },
    { id: 'nudges', label: 'Go to nudges', run: openNudges },
    { id: 'rollup', label: 'Weekly review', hint: 'this week', run: openRollup },
    { id: 'insights', label: 'Go to word map and insights', run: openInsights },
    { id: 'sync', label: 'Refresh calendar and mail', run: sync },
    {
      id: 'theme',
      label: 'Switch between light and dark',
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark')
    },
    { id: 'guide', label: 'Show the setup guide', run: () => setGuide(true) },
    { id: 'settings', label: 'Open settings', run: () => setSettingsOpen(true) }
  ]

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newNote()
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setCopilot((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newNote])

  return (
    <div className="flex h-screen gap-3 p-3 text-fg">
      <Sidebar
        notes={notes}
        entities={entities}
        gmail={gmail}
        mailAttention={mail?.attention ?? 0}
        emailActive={view === 'email' && !settingsOpen}
        onEmail={openEmail}
        unreadNudges={unreadNudges}
        nudgesActive={view === 'nudges' && !settingsOpen}
        onNudges={openNudges}
        onCalendar={openCalendar}
        calendarActive={view === 'calendar' && !settingsOpen}
        onOpenPrep={openPrep}
        exploreActive={
          settingsOpen
            ? null
            : view === 'insights'
              ? 'insights'
              : view === 'entity'
                ? entityId
                : null
        }
        onOpenEntity={openEntity}
        onInsights={openInsights}
        onAddEntity={() => setEditor({ category: 'person', name: '', aliases: [] })}
        tasks={tasks}
        taskFilter={view === 'tasks' && !settingsOpen ? taskFilter : null}
        onTaskFilter={pickFilter}
        upcoming={upcoming}
        cal={cal}
        selected={view === 'note' && !settingsOpen ? selectedPath : null}
        tab={tab}
        onTab={setTab}
        onSelect={open}
        onOpenEvent={(id) => void openEvent(id)}
        onNew={() => void newNote()}
        onSync={sync}
        onConnect={connect}
        onSettings={() => setSettingsOpen((v) => !v)}
        settingsOpen={settingsOpen}
        copilotOpen={copilot}
        onCopilot={() => setCopilot((v) => !v)}
      />
      <div className="glass min-w-0 flex-1 overflow-hidden rounded-2xl">
        {settingsOpen ? (
          <Settings
            theme={theme}
            onTheme={setTheme}
            cal={cal}
            gmail={gmail}
            onSync={sync}
            onConnect={connect}
            onBack={() => setSettingsOpen(false)}
            onShowGuide={() => {
              setSettingsOpen(false)
              setGuide(true)
            }}
          />
        ) : view === 'calendar' ? (
          <CalendarView onOpenPrep={openPrep} onOpenNote={open} />
        ) : view === 'prep' && prepEventId ? (
          <PrepView
            key={prepEventId}
            eventId={prepEventId}
            onBack={() => setView(backTo === 'prep' ? 'calendar' : backTo)}
            onStartNotes={(id) => void openEvent(id)}
            onOpenNote={open}
            onOpenEntity={openEntity}
            onToggle={toggleTask}
            onSetDue={(id, due) => void setDue(id, due)}
            onConnect={connect}
            onFlash={flash}
          />
        ) : view === 'library' ? (
          <LibraryView notes={notes} onOpen={open} />
        ) : view === 'rollup' ? (
          <RollupView onOpenNote={open} onFlash={flash} />
        ) : view === 'nudges' ? (
          <NudgesView
            onAction={(a) => void runAction(a)}
            onSettings={() => setSettingsOpen(true)}
          />
        ) : view === 'email' ? (
          <EmailView
            mail={mail}
            gmail={gmail}
            onConnect={connect}
            onSync={sync}
            onSettings={() => setSettingsOpen(true)}
            onFlash={flash}
          />
        ) : view === 'insights' ? (
          <InsightsView onOpenEntity={openEntity} />
        ) : view === 'entity' && entityId ? (
          <EntityView
            key={entityId}
            id={entityId}
            onOpenNote={open}
            onEdit={editEntity}
            onToggle={toggleTask}
            onSetDue={(id, due) => void setDue(id, due)}
            onFlash={flash}
          />
        ) : view === 'tasks' ? (
          <TasksView
            tasks={tasks}
            filter={taskFilter}
            onToggle={toggleTask}
            onOpenNote={open}
            onSetDue={(id, due) => void setDue(id, due)}
            onFlash={flash}
          />
        ) : selectedPath ? (
          <NoteView
            key={selectedPath}
            path={selectedPath}
            summary={current}
            autoFocusTitle={selectedPath === justCreated}
            autoFocusEditor={selectedPath === focusEditorFor}
            onOpenPath={open}
            onOpenEntity={openEntity}
            onRenamed={(p) => {
              setJustCreated(null)
              setFocusEditorFor(p) // renaming remounts the note; keep typing in the body
              void refreshNotes().then(() => open(p))
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
            <NoteIcon width={36} height={36} className="opacity-50" />
            <p className="text-sm">Pick a meeting or a note, or press Ctrl+N to start a new one.</p>
          </div>
        )}
      </div>
      {guide && <SetupGuide cal={cal} onConnect={connect} onFinish={finishGuide} />}
      {palette && (
        <CommandPalette
          actions={paletteActions}
          notes={notes}
          tasks={tasks}
          entities={entities}
          onOpenNote={open}
          onOpenEntity={openEntity}
          onClose={() => setPalette(false)}
        />
      )}
      {copilot && (
        <AssistantDrawer
          onClose={() => setCopilot(false)}
          onOpenNote={open}
          onOpenSettings={() => {
            setSettingsOpen(true)
            setCopilot(false)
          }}
          onFlash={flash}
          seed={seed}
        />
      )}
      {editor && (
        <EntityEditor
          value={editor}
          onCancel={() => setEditor(null)}
          onSave={saveEntity}
          onRemove={editor.originalName !== undefined ? removeEntity : undefined}
        />
      )}
      {toast && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-fg px-4 py-2 text-sm text-[var(--app)] shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  )
}

export default App
