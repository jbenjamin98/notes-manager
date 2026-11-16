import { useCallback, useEffect, useState } from 'react'
import type {
  CalendarStatus,
  EntitySummary,
  GmailOverview,
  GmailStatus,
  GoogleConnection,
  NoteSummary,
  TaskItem,
  UpcomingEvent,
  Output
} from '@shared/contract'

export interface AppData {
  notes: NoteSummary[]
  tasks: TaskItem[]
  entities: EntitySummary[]
  gmail: GmailStatus
  mail: GmailOverview | null
  unreadNudges: number
  assistantUnread: number
  upcoming: UpcomingEvent[]
  cal: CalendarStatus
  refreshNotes: () => Promise<void>
}

/** Notes, upcoming meetings and calendar status, kept live via main-process events. */
export function useAppData(): AppData {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [entities, setEntities] = useState<EntitySummary[]>([])
  const [gmail, setGmail] = useState<GmailStatus>({
    state: 'idle',
    lastSyncAt: null,
    error: null,
    threads: 0,
    health: 'ok',
    healthDetail: null,
    lastRead: 0,
    lastPages: 0,
    partial: false,
    lastFull: false
  })
  const [mail, setMail] = useState<GmailOverview | null>(null)
  const [unreadNudges, setUnreadNudges] = useState(0)
  const [assistantUnread, setAssistantUnread] = useState(0)
  const [upcoming, setUpcoming] = useState<UpcomingEvent[]>([])
  const [cal, setCal] = useState<CalendarStatus>({ state: 'idle', lastSyncAt: null, error: null })

  const refreshNotes = useCallback(async () => {
    const r = await window.api.invoke('notes:list')
    if (r.ok) setNotes(r.data)
  }, [])

  useEffect(() => {
    let alive = true
    const loadNotes = (): void => {
      void window.api.invoke('notes:list').then((r) => alive && r.ok && setNotes(r.data))
    }
    const loadTasks = (): void => {
      void window.api.invoke('tasks:list').then((r) => alive && r.ok && setTasks(r.data))
    }
    const loadEntities = (): void => {
      void window.api.invoke('entities:list').then((r) => alive && r.ok && setEntities(r.data))
    }
    const loadMail = (): void => {
      void window.api.invoke('gmail:overview').then((r) => alive && r.ok && setMail(r.data))
    }
    const loadUpcoming = (): void => {
      void window.api.invoke('calendar:upcoming').then((r) => alive && r.ok && setUpcoming(r.data))
    }
    loadNotes()
    loadTasks()
    loadEntities()
    loadMail()
    loadUpcoming()
    void window.api.invoke('gmail:status').then((r) => alive && r.ok && setGmail(r.data))
    void window.api.invoke('calendar:status').then((r) => alive && r.ok && setCal(r.data))
    const offVault = window.api.on('vault:changed', () => {
      loadNotes()
      loadTasks()
      loadEntities()
      loadUpcoming() // a meeting's "has notes" marker depends on the notes index
    })
    const offGmail = window.api.on('gmail:changed', (st) => {
      setGmail(st)
      loadMail()
    })
    void window.api.invoke('nudges:unread').then((r) => alive && r.ok && setUnreadNudges(r.data))
    const offNudges = window.api.on('nudges:changed', ({ unread }) => setUnreadNudges(unread))
    void window.api
      .invoke('assistant:unread')
      .then((r) => alive && r.ok && setAssistantUnread(r.data))
    const offAssistant = window.api.on('assistant:changed', ({ unread }) =>
      setAssistantUnread(unread)
    )
    const offCal = window.api.on('calendar:changed', (st) => {
      setCal(st)
      loadUpcoming()
    })
    return () => {
      alive = false
      offVault()
      offCal()
      offGmail()
      offNudges()
      offAssistant()
    }
  }, [])

  return {
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
  }
}

/** Re-render every `ms` (for "synced 3m ago" and past-meeting dimming). */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/**
 * The one Google connection state (main computes it), kept live. The sidebar, Settings, Home and
 * the first-run guide all read this, so they always agree.
 */
export function useGoogleConnection(): GoogleConnection | null {
  const [conn, setConn] = useState<GoogleConnection | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api.invoke('google:connection').then((r) => alive && r.ok && setConn(r.data))
    }
    load()
    const offs = [
      window.api.on('google:changed', (c) => alive && setConn(c)),
      window.api.on('calendar:changed', load),
      window.api.on('gmail:changed', load),
      window.api.on('settings:changed', load)
    ]
    return () => {
      alive = false
      offs.forEach((o) => o())
    }
  }, [])
  return conn
}

export type WaitingItem = Output<'waiting:list'>[number]

/** What other people owe you: Waiting On note lines from your notes, kept live. */
export function useWaiting(): { items: WaitingItem[]; reload: () => void } {
  const [items, setItems] = useState<WaitingItem[]>([])
  const reload = useCallback(() => {
    void window.api.invoke('waiting:list').then((r) => r.ok && setItems(r.data))
  }, [])
  useEffect(() => {
    const first = setTimeout(reload, 0)
    const off = window.api.on('vault:changed', reload)
    return () => {
      clearTimeout(first)
      off()
    }
  }, [reload])
  return { items, reload }
}
