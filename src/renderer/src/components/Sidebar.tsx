import { useMemo, useState } from 'react'
import type {
  CalendarStatus,
  EntitySummary,
  GmailStatus,
  NoteSummary,
  TaskItem,
  UpcomingEvent
} from '@shared/contract'
import { countFilters, type TaskFilter } from '../tasks'
import { dayLabel, fmtTime, noteBucket, relativeTime, shortDate, todayIso } from '../format'
import { useNow } from '../hooks'
import {
  BellIcon,
  SparkleIcon,
  CalendarIcon,
  CheckCircleIcon,
  GearIcon,
  GraphIcon,
  NoteIcon,
  PlusIcon,
  RefreshIcon
} from './Icons'

export type Tab = 'meetings' | 'notes' | 'tasks' | 'explore'

interface Props {
  notes: NoteSummary[]
  entities: EntitySummary[]
  /** 'insights' for the word map, an entity id, or null. */
  exploreActive: string | null
  onOpenEntity: (id: string) => void
  onInsights: () => void
  onAddEntity: () => void
  gmail: GmailStatus
  mailAttention: number
  onCalendar: () => void
  calendarActive: boolean
  onOpenPrep: (eventId: string) => void
  unreadNudges: number
  nudgesActive: boolean
  onNudges: () => void
  emailActive: boolean
  onEmail: () => void
  tasks: TaskItem[]
  taskFilter: TaskFilter | null
  onTaskFilter: (f: TaskFilter) => void
  upcoming: UpcomingEvent[]
  cal: CalendarStatus
  selected: string | null
  tab: Tab
  onTab: (t: Tab) => void
  onSelect: (path: string) => void
  onOpenEvent: (id: string) => void
  onNew: () => void
  onSync: () => void
  onConnect: () => void
  onSettings: () => void
  settingsOpen: boolean
  copilotOpen: boolean
  onCopilot: () => void
}

function Row({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        active ? 'bg-accent-soft text-fg' : 'hover:bg-hover'
      }`}
    >
      {children}
    </button>
  )
}

function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h2 className="sticky top-0 z-[1] bg-sticky backdrop-blur-md px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
      {children}
    </h2>
  )
}

function Meetings({
  upcoming,
  cal,
  selected,
  onOpenEvent,
  onConnect,
  onOpenPrep
}: Pick<
  Props,
  'upcoming' | 'cal' | 'selected' | 'onOpenEvent' | 'onConnect' | 'onOpenPrep'
>): React.JSX.Element {
  const now = useNow()
  const today = todayIso(new Date(now))
  const nowHm = new Date(now).toTimeString().slice(0, 5)

  const days = useMemo(() => {
    const m = new Map<string, UpcomingEvent[]>()
    for (const e of upcoming.filter((e) => e.date >= today))
      m.set(e.date, [...(m.get(e.date) ?? []), e])
    return [...m.entries()]
  }, [upcoming, today])

  if (cal.state === 'needs-auth' && upcoming.length === 0) {
    return (
      <div className="m-2 rounded-lg border border-line bg-field p-4 text-sm">
        <p className="font-medium">Connect Google Calendar</p>
        <p className="mt-1 text-muted">
          Sign in once and your meetings show up here, ready for notes.
        </p>
        <button
          onClick={onConnect}
          className="mt-3 w-full rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg hover:opacity-90"
        >
          Sign in
        </button>
      </div>
    )
  }
  if (days.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-muted">
        {cal.state === 'syncing' || (cal.lastSyncAt === null && cal.state !== 'error')
          ? 'Loading your meetings…'
          : 'No upcoming meetings.'}
      </p>
    )
  }
  return (
    <>
      {cal.state === 'needs-auth' && (
        <button
          onClick={onConnect}
          className="mx-2 mt-2 w-[calc(100%-1rem)] rounded-md bg-warn/15 px-2 py-1.5 text-left text-xs text-warn"
        >
          Google sign-in expired. <span className="underline">Reconnect</span>
        </button>
      )}
      {days.map(([date, events]) => (
        <section key={date}>
          <Heading>{dayLabel(date, new Date(now))}</Heading>
          {events.map((e) => {
            const past = e.date === today && !!e.endTime && e.endTime < nowHm
            return (
              <div key={e.id} className="group relative">
                <Row
                  active={!!e.notePath && e.notePath === selected}
                  onClick={() => onOpenEvent(e.id)}
                >
                  <span
                    className={`w-[4.5rem] shrink-0 text-xs tabular-nums text-muted ${past ? 'opacity-60' : ''}`}
                  >
                    {fmtTime(e.startTime)}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate ${past ? 'text-muted' : ''} ${
                      e.status === 'tentative' ? 'italic' : ''
                    }`}
                  >
                    {e.title}
                  </span>
                  {e.notePath && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-accent"
                      title="Has notes"
                      aria-label="Has notes"
                    />
                  )}
                </Row>
                <button
                  onClick={() => onOpenPrep(e.id)}
                  title="Prep sheet: who is coming, what happened last time"
                  aria-label={`Prep sheet for ${e.title}`}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md border border-line bg-sticky px-1.5 py-0.5 text-[11px] font-medium opacity-0 backdrop-blur-md group-hover:opacity-100 focus-visible:opacity-100"
                >
                  Prep
                </button>
              </div>
            )
          })}
        </section>
      ))}
    </>
  )
}

function Notes({
  notes,
  selected,
  onSelect
}: Pick<Props, 'notes' | 'selected' | 'onSelect'>): React.JSX.Element {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const f = q.trim().toLowerCase()
    const visible = notes.filter((n) => n.type !== 'inbox') // inbox tasks live in the Tasks tab
    const shown = f ? visible.filter((n) => n.title.toLowerCase().includes(f)) : visible
    const m = new Map<string, NoteSummary[]>()
    for (const n of shown) {
      const b = noteBucket(n.date)
      m.set(b, [...(m.get(b) ?? []), n])
    }
    return [...m.entries()]
  }, [notes, q])

  return (
    <>
      <div className="sticky top-0 z-[2] bg-sticky backdrop-blur-md px-1 pt-2 pb-1">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search notes"
          aria-label="Search notes"
          className="w-full rounded-md border border-line bg-field px-2.5 py-1.5 text-sm placeholder:text-muted"
        />
      </div>
      {groups.map(([bucket, items]) => (
        <section key={bucket}>
          <Heading>{bucket}</Heading>
          {items.map((n) => (
            <Row key={n.path} active={selected === n.path} onClick={() => onSelect(n.path)}>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{n.title}</span>
                <span className="block text-xs text-muted">
                  {shortDate(n.date)}
                  {n.isConflict && <span className="text-warn"> · conflict copy</span>}
                </span>
              </span>
              {n.openTasks > 0 && (
                <span className="rounded-full bg-hover px-1.5 text-xs text-muted tabular-nums">
                  {n.openTasks}
                </span>
              )}
            </Row>
          ))}
        </section>
      ))}
      {groups.length === 0 && !q && (
        <p className="px-3 py-6 text-center text-sm text-muted">No notes yet.</p>
      )}
      {groups.length === 0 && q && (
        <p className="px-3 py-6 text-center text-sm text-muted">No matches.</p>
      )}
    </>
  )
}

const SECTIONS: [string, string][] = [
  ['person', 'People'],
  ['customer', 'Accounts'],
  ['system', 'Systems'],
  ['topic', 'Topics']
]

function Explore({
  entities,
  active,
  onOpen,
  onInsights,
  onAdd
}: {
  entities: EntitySummary[]
  active: string | null
  onOpen: (id: string) => void
  onInsights: () => void
  onAdd: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const f = q.trim().toLowerCase()
  const shown = f ? entities.filter((e) => e.name.toLowerCase().includes(f)) : entities
  const LIMIT = 8

  return (
    <div className="pt-2">
      <Row active={active === 'insights'} onClick={onInsights}>
        <GraphIcon width={15} height={15} className="shrink-0 text-accent" />
        <span className="flex-1 font-medium">Word map</span>
      </Row>
      <div className="sticky top-0 z-[2] bg-sticky px-1 pt-2 pb-1 backdrop-blur-md">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a person, account, topic"
          aria-label="Find a person, account, system or topic"
          className="w-full rounded-md border border-line bg-field px-2.5 py-1.5 text-sm placeholder:text-muted"
        />
      </div>
      {SECTIONS.map(([cat, label]) => {
        const items = shown.filter((e) => e.category === cat)
        if (items.length === 0 && (cat === 'topic' || f)) return null
        const all = expanded.has(cat) || !!f
        const visible = all ? items : items.slice(0, LIMIT)
        return (
          <section key={cat}>
            <div className="flex items-center">
              <div className="flex-1">
                <Heading>{label}</Heading>
              </div>
              {cat !== 'topic' && !f && (
                <button
                  onClick={onAdd}
                  title={`Add ${label.toLowerCase().replace(/s$/, '')}`}
                  aria-label={`Add ${label.toLowerCase().replace(/s$/, '')}`}
                  className="mr-1 rounded p-1 text-muted hover:bg-hover hover:text-fg"
                >
                  <PlusIcon width={13} height={13} />
                </button>
              )}
            </div>
            {items.length === 0 && (
              <p className="px-2 pb-1 text-xs text-muted">
                None yet.{' '}
                {cat === 'system'
                  ? 'Add one to track it across notes.'
                  : 'They appear as you write @names.'}
              </p>
            )}
            {visible.map((e) => (
              <Row key={e.id} active={active === e.id} onClick={() => onOpen(e.id)}>
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {e.notes > 0 && (
                  <span className="rounded-full bg-hover px-1.5 text-xs tabular-nums text-muted">
                    {e.notes}
                  </span>
                )}
              </Row>
            ))}
            {!all && items.length > LIMIT && (
              <button
                onClick={() => setExpanded(new Set(expanded).add(cat))}
                className="px-2 py-1 text-xs text-muted hover:text-fg"
              >
                Show {items.length - LIMIT} more
              </button>
            )}
          </section>
        )
      })}
    </div>
  )
}

function TaskLists({
  tasks,
  active,
  onPick,
  emailActive,
  emailCount,
  onEmail
}: {
  tasks: TaskItem[]
  active: TaskFilter | null
  onPick: (f: TaskFilter) => void
  emailActive: boolean
  emailCount: number
  onEmail: () => void
}): React.JSX.Element {
  const today = todayIso()
  const c = countFilters(tasks, today)
  const item = (f: TaskFilter, label: string, count?: number, tone = ''): React.JSX.Element => (
    <Row key={f} active={active === f} onClick={() => onPick(f)}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className={`rounded-full bg-hover px-1.5 text-xs tabular-nums ${tone || 'text-muted'}`}
        >
          {count}
        </span>
      )}
    </Row>
  )
  return (
    <div className="pt-2">
      {item('mine', 'My tasks', c.mine)}
      {item('today', 'Due today', c.today)}
      {item('overdue', 'Overdue', c.overdue, 'text-danger')}
      {item('waiting', 'Waiting on others', c.waiting)}
      {item('done', 'Completed')}
      <Heading>From email</Heading>
      <Row active={emailActive} onClick={onEmail}>
        <span className="min-w-0 flex-1 truncate">Email follow-ups</span>
        {emailCount > 0 && (
          <span className="rounded-full bg-accent-soft px-1.5 text-xs tabular-nums text-accent">
            {emailCount}
          </span>
        )}
      </Row>
      {c.accounts.length > 0 && (
        <>
          <Heading>Accounts</Heading>
          {c.accounts.map(([name, n]) => item(`account:${name}` as TaskFilter, name, n))}
        </>
      )}
    </div>
  )
}

export default function Sidebar(props: Props): React.JSX.Element {
  const { cal, tab, onTab, onNew, onSync, onSettings, settingsOpen } = props
  const now = useNow()
  const gmail = props.gmail
  const syncing = cal.state === 'syncing' || gmail.state === 'syncing'
  const needsAuth = cal.state === 'needs-auth' || gmail.state === 'needs-auth'
  const failed = cal.state === 'error' || gmail.state === 'error'
  const degraded = gmail.health === 'degraded' && gmail.lastSyncAt !== null
  const latest = [cal.lastSyncAt, gmail.lastSyncAt].filter(Boolean).sort().pop() ?? null

  const status = syncing
    ? 'Syncing…'
    : needsAuth
      ? 'Not connected'
      : failed
        ? 'Sync failed'
        : degraded
          ? 'Mail may be out of date'
          : `Synced ${relativeTime(latest, now)}`
  const statusTone = failed ? 'text-danger' : needsAuth || degraded ? 'text-warn' : 'text-muted'

  const tabBtn = (t: Tab, label: string, icon: React.ReactNode): React.JSX.Element => (
    <button
      role="tab"
      aria-selected={tab === t}
      onClick={() => onTab(t)}
      title={label}
      aria-label={label}
      className={`flex items-center justify-center gap-1.5 rounded-md py-1 text-sm font-medium transition-all ${
        tab === t ? 'flex-[2.4] bg-field text-fg shadow-sm' : 'flex-1 text-muted hover:text-fg'
      }`}
    >
      {icon}
      {tab === t && label}
    </button>
  )

  return (
    <nav className="glass flex h-full w-72 shrink-0 flex-col rounded-2xl">
      <div className="p-3 pb-2">
        <button
          onClick={onNew}
          className="btn-primary flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold"
          title="New note (Ctrl+N)"
        >
          <PlusIcon />
          New note
        </button>
      </div>
      <div role="tablist" className="mx-3 mb-1 flex gap-1 rounded-lg bg-hover p-1">
        {tabBtn('meetings', 'Meetings', <CalendarIcon width={14} height={14} />)}
        {tabBtn('notes', 'Notes', <NoteIcon width={14} height={14} />)}
        {tabBtn('tasks', 'Tasks', <CheckCircleIcon width={14} height={14} />)}
        {tabBtn('explore', 'Explore', <GraphIcon width={14} height={14} />)}
      </div>

      {tab === 'meetings' && (
        <button
          onClick={props.onCalendar}
          className={`mx-3 mt-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium ${
            props.calendarActive ? 'bg-accent-soft' : 'hover:bg-hover'
          }`}
        >
          <CalendarIcon width={15} height={15} className="text-accent" />
          Calendar
        </button>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" role="tabpanel">
        {tab === 'meetings' ? (
          <Meetings
            onOpenPrep={props.onOpenPrep}
            upcoming={props.upcoming}
            cal={cal}
            selected={props.selected}
            onOpenEvent={props.onOpenEvent}
            onConnect={props.onConnect}
          />
        ) : tab === 'notes' ? (
          <Notes notes={props.notes} selected={props.selected} onSelect={props.onSelect} />
        ) : tab === 'tasks' ? (
          <TaskLists
            tasks={props.tasks}
            active={props.taskFilter}
            onPick={props.onTaskFilter}
            emailActive={props.emailActive}
            emailCount={props.mailAttention}
            onEmail={props.onEmail}
          />
        ) : (
          <Explore
            entities={props.entities}
            active={props.exploreActive}
            onOpen={props.onOpenEntity}
            onInsights={props.onInsights}
            onAdd={props.onAddEntity}
          />
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-line px-2 py-2">
        <button
          onClick={needsAuth ? props.onConnect : onSync}
          disabled={syncing}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover disabled:cursor-default"
          title={cal.error ?? gmail.error ?? gmail.healthDetail ?? 'Refresh calendar and mail now'}
          aria-label="Refresh calendar and mail"
        >
          <RefreshIcon
            width={14}
            height={14}
            className={syncing ? 'spin shrink-0' : 'shrink-0 text-muted'}
          />
          <span className={`truncate ${statusTone}`}>{status}</span>
        </button>
        <button
          onClick={props.onCopilot}
          aria-label="Co-Pilot (Ctrl+J)"
          title="Co-Pilot (Ctrl+J)"
          className={`rounded-md p-2 ${props.copilotOpen ? 'bg-accent-soft' : 'text-muted hover:bg-hover hover:text-fg'}`}
        >
          <SparkleIcon />
        </button>
        <button
          onClick={props.onNudges}
          aria-label={`Nudges${props.unreadNudges ? `, ${props.unreadNudges} unread` : ''}`}
          title="Nudges"
          className={`relative rounded-md p-2 ${props.nudgesActive ? 'bg-accent-soft' : 'text-muted hover:bg-hover hover:text-fg'}`}
        >
          <BellIcon />
          {props.unreadNudges > 0 && (
            <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg">
              {props.unreadNudges > 9 ? '9+' : props.unreadNudges}
            </span>
          )}
        </button>
        <button
          onClick={onSettings}
          aria-label="Settings"
          title="Settings"
          className={`rounded-md p-2 ${settingsOpen ? 'bg-accent-soft' : 'text-muted hover:bg-hover hover:text-fg'}`}
        >
          <GearIcon />
        </button>
      </div>
    </nav>
  )
}
