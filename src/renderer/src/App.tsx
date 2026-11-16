import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { navReset, navRestore, navSnapshot, subscribeNav } from './nav'
import { ArrowLeftIcon } from './components/Icons'
import { filterTitle } from './tasks'
import Sidebar, { type Tab } from './components/Sidebar'
import NoteView from './components/NoteView'
import Settings from './components/Settings'
import TasksView from './components/TasksView'
import EntityView from './components/EntityView'
import InsightsView from './components/InsightsView'
import EmailView from './components/EmailView'
import InboxView from './components/InboxView'
import NudgesView from './components/NudgesView'
import CalendarView from './components/CalendarView'
import PrepView from './components/PrepView'
import AssistantDrawer, { type ActionReq } from './components/AssistantDrawer'
import RollupView from './components/RollupView'
import Dashboard from './components/Dashboard'
import EntitiesManager from './components/EntitiesManager'
import SetupGuide from './components/SetupGuide'
import HomeView from './components/HomeView'
import NewNoteModal from './components/NewNoteModal'
import Confetti from './components/Confetti'
import { useAmbient } from './ambient'
import CommandPalette, { type PaletteAction } from './components/CommandPalette'
import type { NudgeAction } from '@shared/contract'
import EntityEditor, { type EditorValue } from './components/EntityEditor'
import type { Dossier } from '@shared/contract'
import type { TaskFilter } from './tasks'
import { useAppData } from './hooks'
import { useTheme } from './theme'
import { setAppTimezone, todayIso } from './format'

const TAB_KEY = 'nm-tab'
const readTab = (): Tab => {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'tasks' || v === 'explore' ? v : 'notes'
  } catch {
    return 'notes'
  }
}

const PLACE: Record<string, string> = {
  note: 'Home',
  tasks: 'Tasks',
  entity: 'Profile',
  insights: 'Word Map',
  email: 'Email Follow-Ups',
  chat: 'Inbox',
  nudges: 'Nudges',
  calendar: 'Calendar',
  prep: 'Meeting Prep',
  rollup: 'Weekly Review',
  library: 'Your Notes',
  manage: 'Knowledge'
}

/** A short name for a place in the app ("Inbox", "Due Today", "the note"), for the Back bar. */
function placeName(l: {
  view: string
  selected: string | null
  settingsOpen: boolean
  taskFilter: string
}): string {
  if (l.settingsOpen) return 'Settings'
  if (l.view === 'note' && l.selected) {
    const base = l.selected.split('/').pop() ?? ''
    return (
      base
        .replace(/^\d{4}-\d{2}-\d{2}-/, '')
        .replace(/\.md$/, '')
        .replace(/-/g, ' ') || 'Note'
    )
  }
  if (l.view === 'tasks') return filterTitle(l.taskFilter as never)
  return PLACE[l.view] ?? 'Previous'
}

type ViewName =
  | 'note'
  | 'tasks'
  | 'entity'
  | 'insights'
  | 'email'
  | 'chat'
  | 'nudges'
  | 'calendar'
  | 'prep'
  | 'rollup'
  | 'library'
  | 'manage'

/** Which sidebar tab the page you are on belongs to (null = none, e.g. Home or Settings). */
function tabForView(v: ViewName, hasNote: boolean): Tab | null {
  switch (v) {
    case 'note':
      return hasNote ? 'notes' : null
    case 'library':
      return 'notes'
    case 'tasks':
    case 'email':
    case 'chat':
    case 'calendar':
    case 'rollup':
    case 'prep':
      return 'tasks'
    case 'entity':
    case 'insights':
    case 'manage':
      return 'explore'
    default:
      return null
  }
}

function App(): React.JSX.Element {
  const {
    notes,
    tasks,
    entities,
    gmail,
    mail,
    unreadNudges,
    assistantUnread,
    upcoming,
    cal,
    refreshNotes
  } = useAppData()
  const [theme, setTheme] = useTheme()
  const [selected, setSelected] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const [focusEditorFor, setFocusEditorFor] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Which Settings section to open at (e.g. 'Google' from the sidebar status).
  const [settingsSection, setSettingsSection] = useState<string | null>(null)
  const [tab, setTabState] = useState<Tab>(readTab)
  const [view, setViewRaw] = useState<ViewName>(() => {
    const t = readTab()
    return t === 'tasks' ? 'tasks' : t === 'explore' ? 'insights' : 'note' // the Home screen: today at a glance
  })
  // Opening a page from the sidebar, a card or a link starts it at its front door.
  const setView = useCallback((v: ViewName) => {
    navReset(v + '.')
    setViewRaw(v)
  }, [])
  const [entityId, setEntityId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorValue | null>(null)
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('mine')
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null)
  const [copilot, setCopilot] = useState(false)
  const [palette, setPalette] = useState(false)
  const [guide, setGuide] = useState(false)
  const [confetti, setConfetti] = useState(0)
  const [manageCat, setManageCat] = useState('person')
  // Tagged names (like @Jacob when two people share it) waiting in Review Names.
  const [reviewCount, setReviewCount] = useState(0)
  useEffect(() => {
    let alive = true
    let t: ReturnType<typeof setTimeout> | null = null
    const load = (): void => {
      void window.api.invoke('names:review').then((r) => {
        if (alive && r.ok) setReviewCount(r.data.reduce((n, g) => n + g.mentions.length, 0))
      })
    }
    const soon = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(load, 1500)
    }
    soon()
    const off = window.api.on('vault:changed', soon)
    return () => {
      alive = false
      if (t) clearTimeout(t)
      off()
    }
  }, [])
  const [action, setAction] = useState<{ req: ActionReq; label: string; nonce: number } | null>(
    null
  )
  const runAI = useCallback((req: ActionReq, label: string) => {
    setCopilot(true)
    setAction({ req, label, nonce: Date.now() })
  }, [])
  const clearConfetti = useCallback(() => setConfetti(0), [])
  useAmbient()
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null)

  // First run: walk through setup once.
  useEffect(() => {
    void window.api.invoke('settings:get').then((r) => {
      if (!r.ok) return
      setAppTimezone(r.data.timezone)
      if (!r.data.setupDone) setGuide(true)
    })
    return window.api.on('settings:changed', (st) => setAppTimezone(st.timezone))
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

  /** Home: today at a glance (the tasks gauge, next meeting). */
  const goHome = useCallback(() => {
    setSettingsOpen(false)
    setSelected(null)
    setView('note')
  }, [setView])

  // Derived, not stored: a note deleted/moved outside the app simply stops being selected.
  const selectedPath = selected && notes.some((n) => n.path === selected) ? selected : null
  // The highlighted tab follows the page you are on (none on Home or Settings).
  const activeTab = settingsOpen ? null : tabForView(view, !!selectedPath)
  const current = notes.find((n) => n.path === selectedPath)

  const flash = useCallback((msg: string, undo?: () => void) => {
    const t = { msg, undo }
    setToast(t)
    setTimeout(() => setToast((cur) => (cur === t ? null : cur)), undo ? 7000 : 5000)
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

  const toggleTask = useCallback(
    (id: string, done: boolean) => {
      const dueLeft = tasks.filter(
        (t) => t.isMine && t.status === 'open' && t.due !== null && t.due <= todayIso()
      )
      const lastOne = done && dueLeft.length === 1 && dueLeft[0].id === id
      void window.api.invoke('tasks:toggle', { id, done }).then((r) => {
        if (r.ok && lastOne) setConfetti((n) => n + 1)
      })
      flash(done ? 'Marked done' : 'Reopened', () => {
        void window.api.invoke('tasks:toggle', { id, done: !done })
        setToast(null)
      })
    },
    [flash, tasks]
  )

  const setDue = useCallback(
    async (id: string, due: string | null) => {
      const r = await window.api.invoke('tasks:set-due', { id, due })
      if (!r.ok) flash(r.error.message)
    },
    [flash]
  )

  const [newNoteOpen, setNewNoteOpen] = useState(false)
  /** "New Note" opens the chooser: type a title, or pick a meeting. */
  const newNote = useCallback(async () => {
    setNewNoteOpen(true)
  }, [])

  const createBlank = useCallback(
    async (title: string) => {
      setNewNoteOpen(false)
      const r = await window.api.invoke('notes:create', {
        kind: 'adhoc',
        title: title || 'Untitled',
        date: todayIso()
      })
      if (!r.ok) return flash(r.error.message)
      await refreshNotes()
      if (!title)
        setJustCreated(r.data.path) // an untitled note puts the cursor in the title
      else setFocusEditorFor(r.data.path)
      open(r.data.path)
    },
    [refreshNotes, open, flash]
  )

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
  const [chatCount, setChatCount] = useState(0)
  useEffect(() => {
    const load = (): void => {
      void Promise.all([window.api.invoke('chat:overview'), window.api.invoke('inbox:list')]).then(
        ([chat, inbox]) => {
          const reply = chat.ok
            ? chat.data.conversations.filter((c) => c.bucket === 'needs-you').length
            : 0
          setChatCount(reply + (inbox.ok ? inbox.data.length : 0))
        }
      )
    }
    const first = setTimeout(load, 1500)
    const t = setInterval(load, 120_000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [])
  const openChat = useCallback(() => {
    setView('chat')
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
      else if (a.type === 'open-chat') openChat()
      else openEmail()
    },
    [openEvent, open, pickFilter, openEmail, openChat, openPrep, openRollup]
  )

  // Clicking a notification from the assistant opens the Co-Pilot.
  useEffect(() => window.api.on('assistant:focus', () => setCopilot(true)), [])
  // Quick capture handed a long note over: open it here to keep writing.
  useEffect(() => window.api.on('app:open-note', ({ path }) => open(path)), [open])

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

  /** Add the missing @ and # to a note written before auto-tagging; the toast can undo it. */
  const autoTagNote = async (): Promise<void> => {
    if (!selectedPath) return
    const path = selectedPath
    const r = await window.api.invoke('tags:tag-note', { path })
    if (!r.ok) return flash(r.error.message)
    if (r.data.count === 0) return flash('Nothing to tag: every known name and topic already is.')
    const before = r.data.before
    flash(`Tagged ${r.data.count} word${r.data.count === 1 ? '' : 's'}.`, () => {
      if (before !== null) void window.api.invoke('notes:force-save', { path, content: before })
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
          },
          {
            id: 'autotag',
            label: 'Auto-Tag This Note',
            hint: 'adds @ and # to known names and topics',
            run: () => void autoTagNote()
          }
        ]
      : []),
    { id: 'home', label: 'Home', hint: 'today at a glance', run: goHome },
    { id: 'new', label: 'New Note', hint: 'Ctrl+N', run: () => void newNote() },
    { id: 'ask', label: 'Open Co-Pilot', hint: 'Ctrl+J', run: () => setCopilot(true) },
    {
      id: 'plan',
      label: 'AI: Plan my day',
      run: () => runAI({ kind: 'day-brief' }, 'What is on my plate today?')
    },
    {
      id: 'week',
      label: 'AI: Draft my weekly update',
      run: () => runAI({ kind: 'week-update' }, 'Draft my weekly update')
    },
    ...(view === 'note' && selectedPath && current && !settingsOpen
      ? (
          [
            ['summarize-note', 'AI: Summarize this note'],
            ['extract-actions', 'AI: Find action items in this note'],
            ['draft-followup', 'AI: Draft a follow-up email']
          ] as const
        ).map(([kind, label]) => ({
          id: kind,
          label,
          run: () =>
            runAI({ kind, path: selectedPath }, `${label.replace('AI: ', '')}: “${current.title}”`)
        }))
      : []),
    { id: 'tasks', label: 'Go to tasks', run: () => setTab('tasks') },
    {
      id: 'library',
      label: 'Browse notes by week, company, person, project...',
      run: () => setTab('notes')
    },
    { id: 'cal', label: 'Go to calendar', run: openCalendar },
    { id: 'mail', label: 'Go to email follow-ups', run: openEmail },
    { id: 'inbox', label: 'Go to inbox (what matters from meetings, email, chat)', run: openChat },
    { id: 'nudges', label: 'Go to nudges', run: openNudges },
    { id: 'rollup', label: 'Weekly Review', hint: 'this week', run: openRollup },
    { id: 'insights', label: 'Go to word map and insights', run: openInsights },
    { id: 'sync', label: 'Refresh calendar and mail', run: sync },
    {
      id: 'theme',
      label: 'Switch between light and dark',
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark')
    },
    { id: 'guide', label: 'Show the setup guide', run: () => setGuide(true) },
    { id: 'settings', label: 'Open Settings', run: () => setSettingsOpen(true) }
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

  // ---- Back: one history of where you have been (the page, what was open, where you were inside
  // it, how far you had scrolled) for the whole app. A Back bar, Alt+Left and the mouse's back
  // button all use it.
  const inside = useSyncExternalStore(subscribeNav, navSnapshot)
  const locKey = JSON.stringify({
    view,
    selected,
    entityId,
    taskFilter,
    settingsOpen,
    settingsSection,
    prepEventId,
    manageCat,
    tab,
    inside
  })
  const navHistory = useRef<{ key: string; scroll: number }[]>([])
  const prevLoc = useRef<string | null>(null)
  const curLoc = useRef(locKey)
  const restoring = useRef<number | null>(null)
  const lastScroll = useRef(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const [backLabel, setBackLabel] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [narrowNav, setNarrowNav] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  useEffect(() => {
    const m = window.matchMedia('(max-width: 760px)')
    const on = (): void => {
      setNarrowNav(m.matches)
      if (!m.matches) setNavOpen(false)
    }
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  // The page's main scroller (the first one in the content area): its position is what Back restores.
  const mainScroller = (): HTMLElement | null =>
    contentRef.current?.querySelector<HTMLElement>('.overflow-y-auto') ?? null
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const on = (e: Event): void => {
      const t = e.target as HTMLElement | null
      if (t && t === mainScroller()) lastScroll.current = t.scrollTop
    }
    el.addEventListener('scroll', on, true)
    return () => el.removeEventListener('scroll', on, true)
  }, [])
  useEffect(() => {
    curLoc.current = locKey
    const prev = prevLoc.current
    prevLoc.current = locKey
    if (prev === null || prev === locKey) return
    if (restoring.current !== null) {
      // Back: put the scroll position back once the page has its content (it may load a moment later).
      const y = restoring.current
      restoring.current = null
      let tries = 0
      const put = (): void => {
        const sc = mainScroller()
        if (sc) {
          sc.scrollTop = y
          if (Math.abs(sc.scrollTop - y) < 2 || y === 0) return
        }
        if (++tries < 20) setTimeout(put, 50)
      }
      requestAnimationFrame(put)
    } else {
      navHistory.current.push({ key: prev, scroll: lastScroll.current })
      if (navHistory.current.length > 60) navHistory.current.shift()
    }
    lastScroll.current = 0
    const top = navHistory.current[navHistory.current.length - 1]

    setBackLabel(top ? placeName(JSON.parse(top.key)) : null)
  }, [locKey])
  const goBack = useCallback(() => {
    // Skip entries identical to where you already are (they would look like Back did nothing).
    let h = navHistory.current.pop()
    while (h && h.key === curLoc.current) h = navHistory.current.pop()
    if (!h) {
      setBackLabel(null)
      return
    }
    const l = JSON.parse(h.key) as {
      view: ViewName
      selected: string | null
      entityId: string | null
      taskFilter: TaskFilter
      settingsOpen: boolean
      settingsSection: string | null
      prepEventId: string | null
      manageCat: string
      tab: Tab
      inside: string
    }
    restoring.current = h.scroll
    navRestore(l.inside)
    setTabState(l.tab)
    setViewRaw(l.view)
    setSelected(l.selected)
    setEntityId(l.entityId)
    setTaskFilter(l.taskFilter)
    setSettingsOpen(l.settingsOpen)
    setSettingsSection(l.settingsSection)
    setPrepEventId(l.prepEventId)
    setManageCat(l.manageCat)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        goBack()
      }
    }
    const onMouse = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault()
        goBack()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [goBack])

  return (
    <div className="flex h-screen gap-3 p-3 text-fg">
      {/* Narrow windows: the sidebar becomes a drawer, opened from the menu button. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 min-[761px]:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}
      <div
        className={`flex shrink-0 max-[760px]:fixed max-[760px]:inset-y-3 max-[760px]:left-3 max-[760px]:z-40 ${navOpen ? '' : 'max-[760px]:hidden'}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) setNavOpen(false)
        }}
      >
        <Sidebar
          onFixGoogle={() => {
            setSettingsSection('Google')
            setSettingsOpen(true)
          }}
          notes={notes}
          entities={entities}
          gmail={gmail}
          mailAttention={mail?.attention ?? 0}
          emailActive={view === 'email' && !settingsOpen}
          onEmail={openEmail}
          chatActive={view === 'chat' && !settingsOpen}
          onChat={openChat}
          chatCount={chatCount}
          unreadNudges={unreadNudges}
          nudgesActive={view === 'nudges' && !settingsOpen}
          onNudges={openNudges}
          onCalendar={openCalendar}
          onRollup={openRollup}
          calendarActive={(view === 'calendar' || view === 'prep') && !settingsOpen}
          rollupActive={view === 'rollup' && !settingsOpen}
          reviewCount={reviewCount}
          onReview={() => {
            setManageCat('review')
            setView('manage')
          }}
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
          tab={activeTab ?? tab}
          activeTab={activeTab}
          onTab={setTab}
          onSelect={open}
          onOpenEvent={(id) => void openEvent(id)}
          onNew={() => void newNote()}
          onHome={goHome}
          homeActive={view === 'note' && !selectedPath && !settingsOpen}
          onSync={sync}
          onConnect={connect}
          onSettings={() => setSettingsOpen((v) => !v)}
          settingsOpen={settingsOpen}
          copilotOpen={copilot}
          assistantUnread={assistantUnread}
          onLibrary={() => {
            setView('library')
            setSettingsOpen(false)
          }}
          onCopilot={() => setCopilot((v) => !v)}
        />
      </div>
      <div
        ref={contentRef}
        className="glass flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl"
      >
        {((backLabel && !settingsOpen) || narrowNav) && (
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line/60 px-2">
            {narrowNav && (
              <button
                onClick={() => setNavOpen(true)}
                aria-label="Open menu"
                className="rounded-md px-2 py-0.5 text-sm text-muted hover:bg-hover hover:text-fg"
              >
                ☰
              </button>
            )}
            {backLabel && !settingsOpen && (
              <button
                onClick={goBack}
                data-testid="nav-back"
                title="Back (Alt+Left)"
                className="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
              >
                <ArrowLeftIcon width={12} height={12} /> Back to {backLabel}
              </button>
            )}
          </div>
        )}
        <div
          key={settingsOpen ? 'settings' : `${view}:${view === 'note' ? (selectedPath ?? '') : ''}`}
          className="view-in min-h-0 flex-1"
        >
          {settingsOpen ? (
            <Settings
              theme={theme}
              onTheme={setTheme}
              cal={cal}
              gmail={gmail}
              onSync={sync}
              onConnect={connect}
              section={settingsSection}
              onBack={() => {
                setSettingsOpen(false)
                setSettingsSection(null)
              }}
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
              onBrief={(id, title) =>
                runAI({ kind: 'prep-brief', eventId: id }, `Brief me for “${title}”`)
              }
              onOpenNote={open}
              onOpenEntity={openEntity}
              onToggle={toggleTask}
              onSetDue={(id, due) => void setDue(id, due)}
              onConnect={connect}
              onFlash={flash}
            />
          ) : view === 'library' ? (
            <Dashboard
              notes={notes}
              tasks={tasks}
              upcoming={upcoming}
              mail={mail}
              onOpenNote={open}
              onOpenEntity={openEntity}
              onTasks={(f) => pickFilter(f as TaskFilter)}
              onEmail={openEmail}
              onRollup={openRollup}
              onInsights={openInsights}
              onManage={(c) => {
                setManageCat(c)
                setView('manage')
              }}
            />
          ) : view === 'manage' ? (
            <EntitiesManager
              initial={manageCat}
              onBack={() => setView('library')}
              onOpenEntity={openEntity}
              onEdit={(r) =>
                setEditor({
                  category: r.category,
                  name: r.name,
                  aliases: r.aliases,
                  originalName: r.inRegistry ? r.name : undefined
                })
              }
              onAdd={(category) => setEditor({ category, name: '', aliases: [] })}
              onFlash={flash}
              onOpenNote={open}
            />
          ) : view === 'rollup' ? (
            <RollupView
              onOpenNote={open}
              onFlash={flash}
              onDraft={(ws, label) =>
                runAI({ kind: 'week-update', weekStart: ws }, `Draft my update for ${label}`)
              }
            />
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
          ) : view === 'chat' ? (
            <InboxView onSettings={() => setSettingsOpen(true)} onOpenNote={open} onFlash={flash} />
          ) : view === 'insights' ? (
            <InsightsView onOpenEntity={openEntity} />
          ) : view === 'entity' && entityId ? (
            <EntityView
              key={entityId}
              id={entityId}
              onOpenNote={open}
              onEdit={editEntity}
              onCatchUp={(id, name) =>
                runAI({ kind: 'catch-up', entityId: id }, `Catch me up on ${name}`)
              }
              onToggle={toggleTask}
              onSetDue={(id, due) => void setDue(id, due)}
              onFlash={flash}
              onReview={() => {
                setManageCat('review')
                setView('manage')
              }}
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
              onFlash={flash}
              path={selectedPath}
              summary={current}
              autoFocusTitle={selectedPath === justCreated}
              autoFocusEditor={selectedPath === focusEditorFor}
              onAI={(kind) =>
                runAI(
                  { kind, path: selectedPath },
                  kind === 'summarize-note'
                    ? `Summarize “${current?.title ?? 'this note'}”`
                    : kind === 'extract-actions'
                      ? `Find action items in “${current?.title ?? 'this note'}”`
                      : `Draft a follow-up email for “${current?.title ?? 'this note'}”`
                )
              }
              onOpenPath={open}
              onOpenEntity={openEntity}
              onRenamed={(p) => {
                setJustCreated(null)
                setFocusEditorFor(p) // renaming remounts the note; keep typing in the body
                void refreshNotes().then(() => open(p))
              }}
            />
          ) : (
            <HomeView
              tasks={tasks}
              upcoming={upcoming}
              onNewNote={() => void newNote()}
              onOpenEvent={(id) => void openEvent(id)}
              onOpenTasks={() => setTab('tasks')}
              onCopilot={() => setCopilot(true)}
              onPlan={() => runAI({ kind: 'day-brief' }, 'What is on my plate today?')}
              onSettings={() => setSettingsOpen(true)}
              onInbox={openChat}
              onEmail={openEmail}
              mailAttention={mail?.attention ?? 0}
            />
          )}
        </div>
      </div>
      {newNoteOpen && (
        <NewNoteModal
          cal={cal}
          onClose={() => setNewNoteOpen(false)}
          onBlank={(t) => void createBlank(t)}
          onMeeting={(id) => {
            setNewNoteOpen(false)
            void openEvent(id)
          }}
          onSync={async () => {
            await window.api.invoke('calendar:sync')
          }}
          onConnect={connect}
        />
      )}
      {confetti > 0 && <Confetti key={confetti} nonce={confetti} onDone={clearConfetti} />}
      {guide && <SetupGuide onFinish={finishGuide} />}
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
          action={action}
          context={
            view === 'note' && selectedPath && current
              ? { path: selectedPath, title: current.title }
              : null
          }
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
          className="toast-in fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-fg px-4 py-2 text-sm text-[var(--app)] shadow-lg"
        >
          {toast.msg}
          {toast.undo && (
            <button
              className="ml-3 font-semibold underline underline-offset-2"
              onClick={toast.undo}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default App
