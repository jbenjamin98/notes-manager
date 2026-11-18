import type { TaskItem } from '@shared/contract'
import { useNavState } from '../nav'
import ActionCenter from './ActionCenter'
import MiniCalendar from './MiniCalendar'
import TasksView from './TasksView'

/**
 * The Tasks front page: a small calendar, your task list (search, filter, sort, quick add) and the
 * Action Center for email, chat and what came out of meetings. Two columns (tasks on the left; on the right a calendar and the
 * Action Center, one open at a time), or one column when the window is narrow.
 */
export default function TasksDashboard({
  tasks,
  onViewAll,
  onToggle,
  onOpenNote,
  onSetDue,
  onFlash,
  onOpenPrep,
  onOpenCalendar,
  onSettings
}: {
  tasks: TaskItem[]
  onViewAll: () => void
  onToggle: (id: string, done: boolean) => void
  onOpenNote: (path: string) => void
  onSetDue: (id: string, due: string | null) => void
  onFlash: (m: string, undo?: () => void) => void
  onOpenPrep: (eventId: string) => void
  onOpenCalendar: () => void
  onSettings: () => void
}): React.JSX.Element {
  // One side panel is open at a time; the Action Center is the default.
  const [panel, setPanel] = useNavState<'calendar' | 'action'>('dash.panel', 'action')
  return (
    <div className="@container h-full min-h-0" data-testid="tasks-dashboard">
      <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-y-auto p-4 @3xl:grid-cols-[minmax(0,1fr)_360px] @3xl:grid-rows-[minmax(0,1fr)] @3xl:overflow-hidden">
        <main className="min-h-[28rem] @3xl:min-h-0">
          <TasksView
            tasks={tasks}
            filter="mine"
            dashboard
            onViewAll={onViewAll}
            onToggle={onToggle}
            onOpenNote={onOpenNote}
            onSetDue={onSetDue}
            onFlash={onFlash}
          />
        </main>
        <aside className="flex min-h-0 flex-col gap-2">
          <PanelHeader
            id="calendar"
            title="Calendar"
            open={panel === 'calendar'}
            onToggle={() => setPanel(panel === 'calendar' ? 'action' : 'calendar')}
          />
          {panel === 'calendar' && (
            <div className="min-h-0 overflow-y-auto">
              <MiniCalendar onOpenPrep={onOpenPrep} onOpenCalendar={onOpenCalendar} />
            </div>
          )}
          <PanelHeader
            id="action"
            title="Action Center"
            open={panel === 'action'}
            onToggle={() => setPanel(panel === 'action' ? 'calendar' : 'action')}
          />
          {panel === 'action' && (
            <div className="min-h-[24rem] flex-1 @3xl:min-h-0">
              <ActionCenter onFlash={onFlash} onSettings={onSettings} />
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function PanelHeader({
  id,
  title,
  open,
  onToggle
}: {
  id: string
  title: string
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      data-testid={`panel-${id}`}
      aria-expanded={open}
      onClick={onToggle}
      className="card-modern flex w-full shrink-0 items-center gap-2 px-3 py-2 text-left text-sm font-semibold hover:bg-hover"
    >
      <span
        aria-hidden
        className={`text-xs text-muted transition-transform ${open ? 'rotate-90' : ''}`}
      >
        ▶
      </span>
      {title}
    </button>
  )
}
