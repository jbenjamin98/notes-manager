import CategoryIcon from './CategoryIcon'
import { useMemo, useState } from 'react'
import type {
  CalendarStatus,
  EntitySummary,
  GmailStatus,
  NoteSummary,
  TaskItem
} from '@shared/contract'
import { countFilters } from '../tasks'
import { noteBucket, relativeTime, shortDate, todayIso } from '../format'
import { aiHealth } from '@shared/aiHealth'
import { useGoogleConnection, useLlmStatus, useNow } from '../hooks'
import {
  BellIcon,
  SparkleIcon,
  CheckCircleIcon,
  GearIcon,
  GraphIcon,
  HomeIcon,
  NoteIcon,
  PlusIcon,
  RefreshIcon
} from './Icons'

export type Tab = 'notes' | 'tasks' | 'explore'

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
  onRollup: () => void
  onSeries: () => void
  reviewCount: number
  onReview: () => void
  unreadNudges: number
  nudgesActive: boolean
  onNudges: () => void
  chatCount: number
  tasks: TaskItem[]
  navView: NavView | null
  onDashboard: () => void
  onTasksPage: () => void
  onActions: () => void
  cal: CalendarStatus
  selected: string | null
  /** The panel shown below the tabs. */
  tab: Tab
  /** The tab the current page belongs to; null on Home and Settings (nothing is highlighted). */
  activeTab: Tab | null
  onTab: (t: Tab) => void
  onSelect: (path: string) => void
  onNew: () => void
  /** Go to Home (today at a glance: tasks gauge, next meeting). */
  onHome: () => void
  homeActive: boolean
  onSync: () => void
  onSettings: () => void
  /** Open Settings at the Google section (when the connection needs a fix). */
  onFixGoogle: () => void
  /** Open Settings at the AI section (from the AI status chip). */
  onFixAi: () => void
  settingsOpen: boolean
  onLibrary: () => void
  copilotOpen: boolean
  assistantUnread: number
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
    <h2 className="sticky top-1 z-[1] mx-1 mt-1 rounded-lg bg-sticky/40 backdrop-blur-md px-2.5 py-1 text-xs font-semibold tracking-wide text-muted uppercase">
      {children}
    </h2>
  )
}

const RECENT = 25

function Notes({
  notes,
  selected,
  onSelect,
  onLibrary
}: Pick<Props, 'notes' | 'selected' | 'onSelect' | 'onLibrary'>): React.JSX.Element {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const f = q.trim().toLowerCase()
    const visible = notes.filter((n) => n.type !== 'inbox') // inbox tasks live in the Tasks tab
    const all = f ? visible.filter((n) => n.title.toLowerCase().includes(f)) : visible
    // The sidebar is for jumping back in: the newest few. Everything lives on the All notes page.
    const shown = f ? all.slice(0, 100) : all.slice(0, RECENT)
    const m = new Map<string, NoteSummary[]>()
    for (const n of shown) {
      const b = noteBucket(n.date)
      m.set(b, [...(m.get(b) ?? []), n])
    }
    return [...m.entries()]
  }, [notes, q])

  return (
    <>
      <div className="sticky top-0 z-[2] rounded-xl bg-sticky/40 backdrop-blur-md px-1 pt-2 pb-1.5">
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
      {!q && notes.filter((n) => n.type !== 'inbox').length > RECENT && (
        <button
          onClick={onLibrary}
          className="mx-2 my-3 w-[calc(100%-1rem)] rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-fg"
        >
          See all {notes.filter((n) => n.type !== 'inbox').length} notes →
        </button>
      )}
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
  ['customer', 'Companies'],
  ['project', 'Projects'],
  ['system', 'Systems'],
  ['place', 'Places'],
  ['topic', 'Topics']
]

function Explore({
  entities,
  active,
  onOpen,
  onInsights,
  onAdd,
  reviewCount,
  onReview
}: {
  entities: EntitySummary[]
  active: string | null
  onOpen: (id: string) => void
  onInsights: () => void
  onAdd: () => void
  /** Tagged names waiting for you to say which person they mean. */
  reviewCount: number
  onReview: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const f = q.trim().toLowerCase()
  const shown = f ? entities.filter((e) => e.name.toLowerCase().includes(f)) : entities
  const LIMIT = 8

  return (
    <div className="pt-2">
      <Row active={active === 'insights'} onClick={onInsights}>
        <CategoryIcon kind="wordmap" size={22} />
        <span className="flex-1 font-medium">Topics &amp; Insights</span>
      </Row>
      <Row active={false} onClick={onReview}>
        <CategoryIcon kind="review" size={22} />
        <span className="flex-1 font-medium">Review Names</span>
        {reviewCount > 0 && (
          <span
            data-testid="review-count"
            className="rounded-full bg-warn/15 px-1.5 text-xs font-semibold tabular-nums text-warn"
          >
            {reviewCount}
          </span>
        )}
      </Row>
      <div className="sticky top-0 z-[2] rounded-xl bg-sticky/40 px-1 pt-2 pb-1.5 backdrop-blur-md">
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

export type NavView = 'dashboard' | 'tasks' | 'actions' | 'calendar' | 'rollup' | 'series'

/** The places in the Tasks tab: overview, the full task list, the Action Center, and the calendar with its reviews. */
function TaskLists({
  tasks,
  navView,
  actionCount,
  onDashboard,
  onTasksPage,
  onActions,
  onCalendar,
  onRollup,
  onSeries
}: {
  tasks: TaskItem[]
  navView: NavView | null
  actionCount: number
  onDashboard: () => void
  onTasksPage: () => void
  onActions: () => void
  onCalendar: () => void
  onRollup: () => void
  onSeries: () => void
}): React.JSX.Element {
  const today = todayIso()
  const c = countFilters(tasks, today)
  const badge = (n: number, tone = 'bg-accent-soft text-accent'): React.JSX.Element | null =>
    n > 0 ? <span className={`rounded-full px-1.5 text-xs tabular-nums ${tone}`}>{n}</span> : null
  return (
    <div className="space-y-0.5 pt-2" role="navigation" aria-label="Tasks">
      <Row active={navView === 'dashboard'} onClick={onDashboard}>
        <CategoryIcon kind="weeks" size={16} />
        <span className="min-w-0 flex-1 truncate">Overview</span>
      </Row>
      <Row active={navView === 'tasks'} onClick={onTasksPage}>
        <CategoryIcon kind="tasks" size={16} />
        <span className="min-w-0 flex-1 truncate">All Tasks</span>
        {badge(c.mine, 'bg-hover text-muted')}
      </Row>
      <Row active={navView === 'actions'} onClick={onActions}>
        <CategoryIcon kind="inbox" size={16} />
        <span className="min-w-0 flex-1 truncate">Action Center</span>
        <span data-testid="action-badge" className="contents">
          {badge(actionCount)}
        </span>
      </Row>
      <Row active={navView === 'calendar'} onClick={onCalendar}>
        <CategoryIcon kind="calendar" size={16} />
        <span className="min-w-0 flex-1 truncate">Calendar</span>
      </Row>
      <Row active={navView === 'rollup'} onClick={onRollup}>
        <CategoryIcon kind="review" size={16} />
        <span className="min-w-0 flex-1 truncate">Weekly Review</span>
      </Row>
      <Row active={navView === 'series'} onClick={onSeries}>
        <CategoryIcon kind="weeks" size={16} />
        <span className="min-w-0 flex-1 truncate">Meeting Series</span>
      </Row>
    </div>
  )
}

export default function Sidebar(props: Props): React.JSX.Element {
  const { cal, tab, activeTab, onTab, onNew, onSync, onSettings, settingsOpen } = props
  const now = useNow()
  const gmail = props.gmail
  const syncing = cal.state === 'syncing' || gmail.state === 'syncing'
  const needsAuth = cal.state === 'needs-auth' || gmail.state === 'needs-auth'
  const failed = cal.state === 'error' || gmail.state === 'error'
  const degraded = gmail.health === 'degraded' && gmail.lastSyncAt !== null
  const latest = [cal.lastSyncAt, gmail.lastSyncAt].filter(Boolean).sort().pop() ?? null

  const conn = useGoogleConnection()
  const ai = aiHealth(useLlmStatus(), now)
  // Anything that needs you (not set up, sign in, key missing, out of date) opens the Google settings.
  const needsFix = !!conn && !['ok', 'syncing', 'busy', 'error'].includes(conn.state) && !syncing
  const status = syncing
    ? 'Syncing…'
    : needsFix
      ? conn!.label
      : needsAuth
        ? 'Sign in to Google'
        : failed
          ? 'Sync failed'
          : degraded
            ? 'Mail may be out of date'
            : latest
              ? `Synced ${relativeTime(latest, now)}`
              : 'Not synced yet'
  const statusTone = failed
    ? 'text-danger'
    : needsFix || needsAuth || degraded
      ? 'text-warn'
      : 'text-muted'

  const tabBtn = (t: Tab, label: string, icon: React.ReactNode): React.JSX.Element => (
    <button
      role="tab"
      aria-selected={activeTab === t}
      onClick={() => onTab(t)}
      title={label}
      aria-label={label}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-xs font-medium transition-colors ${
        activeTab === t ? 'bg-field text-fg shadow-sm' : 'text-muted hover:text-fg'
      }`}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <nav className="glass flex h-full w-72 shrink-0 flex-col rounded-2xl">
      <div className="flex gap-2 p-3 pb-2">
        <button
          onClick={onNew}
          className="btn-primary flex min-w-0 flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold"
          title="New note (Ctrl+N)"
        >
          <PlusIcon />
          New Note
        </button>
        <button
          onClick={props.onHome}
          aria-label="Home"
          aria-current={props.homeActive ? 'page' : undefined}
          data-testid="nav-home"
          title="Home: today at a glance"
          className={`flex w-10 shrink-0 items-center justify-center rounded-xl border transition-colors ${
            props.homeActive
              ? 'border-transparent bg-accent-soft text-accent'
              : 'border-line bg-field text-muted hover:bg-hover hover:text-fg'
          }`}
        >
          <HomeIcon width={18} height={18} />
        </button>
      </div>
      <div role="tablist" className="mx-3 mb-1 flex gap-1 rounded-lg bg-hover p-1">
        {tabBtn('notes', 'Notes', <NoteIcon width={14} height={14} />)}
        {tabBtn('tasks', 'Tasks', <CheckCircleIcon width={14} height={14} />)}
        {tabBtn('explore', 'Knowledge', <GraphIcon width={14} height={14} />)}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" role="tabpanel">
        {tab === 'notes' ? (
          <Notes
            notes={props.notes}
            selected={props.selected}
            onSelect={props.onSelect}
            onLibrary={props.onLibrary}
          />
        ) : tab === 'tasks' ? (
          <TaskLists
            tasks={props.tasks}
            navView={props.navView}
            actionCount={props.mailAttention + props.chatCount}
            onDashboard={props.onDashboard}
            onTasksPage={props.onTasksPage}
            onActions={props.onActions}
            onCalendar={props.onCalendar}
            onRollup={props.onRollup}
            onSeries={props.onSeries}
          />
        ) : (
          <Explore
            entities={props.entities}
            active={props.exploreActive}
            onOpen={props.onOpenEntity}
            onInsights={props.onInsights}
            onAdd={props.onAddEntity}
            reviewCount={props.reviewCount}
            onReview={props.onReview}
          />
        )}
      </div>

      {!ai.hidden && (
        <button
          onClick={props.onFixAi}
          data-testid="ai-status"
          data-tone={ai.tone}
          title={`${ai.detail} Click for details.`}
          aria-label={`${ai.label}. ${ai.detail}`}
          className={`mx-2 mb-1 flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-hover ${
            ai.tone === 'bad' ? 'text-danger' : ai.tone === 'warn' ? 'text-warn' : 'text-muted'
          }`}
        >
          <SparkleIcon width={14} height={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{ai.label}</span>
          {ai.budgetShare > 0 && (
            <span aria-hidden className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-hover">
              <span
                className={`block h-full rounded-full ${
                  ai.tone === 'bad' ? 'bg-danger' : ai.tone === 'warn' ? 'bg-warn' : 'bg-accent'
                }`}
                style={{ width: `${Math.round(ai.budgetShare * 100)}%` }}
              />
            </span>
          )}
        </button>
      )}
      <div className="flex items-center gap-1 border-t border-line px-2 py-2">
        <button
          onClick={needsFix || needsAuth ? props.onFixGoogle : onSync}
          disabled={syncing}
          data-testid="google-status"
          data-state={conn?.state ?? 'unknown'}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover disabled:cursor-default ${needsFix ? 'bg-warn/10 ring-1 ring-warn/30' : ''}`}
          title={
            needsFix
              ? `${conn!.detail} Click to fix.`
              : (cal.error ?? gmail.error ?? gmail.healthDetail ?? 'Refresh calendar and mail now')
          }
          aria-label={
            needsFix ? `${conn!.label}: open Google settings` : 'Refresh calendar and mail'
          }
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
          className={`relative rounded-md p-2 ${props.copilotOpen ? 'bg-accent-soft' : 'text-muted hover:bg-hover hover:text-fg'}`}
        >
          <SparkleIcon />
          {props.assistantUnread > 0 && (
            <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-accent-fg">
              {props.assistantUnread > 9 ? '9+' : props.assistantUnread}
            </span>
          )}
        </button>
        <button
          onClick={props.onNudges}
          aria-label={`Reminders${props.unreadNudges ? `, ${props.unreadNudges} unread` : ''}`}
          title="Reminders"
          className={`relative rounded-md p-2 ${props.nudgesActive ? 'bg-accent-soft' : 'text-muted hover:bg-hover hover:text-fg'}`}
        >
          <BellIcon />
          {props.unreadNudges > 0 && (
            <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-accent-fg">
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
