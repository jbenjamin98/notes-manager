import { useNavState } from '../nav'
import ActionCenter from './ActionCenter'
import ChatView from './ChatView'
import EmailView from './EmailView'
import FactsPage from './FactsPage'
import type { GmailOverview, GmailStatus } from '@shared/contract'

export type ActionsSection = 'act' | 'facts' | 'mail' | 'chat'

const SECTIONS: { id: ActionsSection; label: string; hint: string }[] = [
  { id: 'act', label: 'Needs action', hint: 'Mail, chat and meeting follow-ups that want you.' },
  {
    id: 'facts',
    label: 'Decisions & facts',
    hint: 'Things worth knowing: nothing to do, just keep or dismiss.'
  },
  {
    id: 'mail',
    label: 'Email',
    hint: 'Every email thread that wants a reply, starred or labelled for follow-up.'
  },
  { id: 'chat', label: 'Chat', hint: 'Google Chat conversations ranked by how much they need you.' }
]

/**
 * The one place for everything found in your mail, chat and meetings: what needs you (ranked, with
 * the unimportant held back under Hidden) and the decisions and facts worth keeping. The fuller
 * mail and chat pages are one click away from the header.
 */
export default function ActionsPage({
  onFlash,
  onSettings,
  mail,
  gmail,
  onConnect,
  onSync
}: {
  onFlash: (m: string, undo?: () => void) => void
  onSettings: () => void
  mail: GmailOverview | null
  gmail: GmailStatus
  onConnect: () => void
  onSync: () => void
}): React.JSX.Element {
  const [section, setSection] = useNavState<ActionsSection>('actions.section', 'act')
  return (
    <div className="flex h-full flex-col px-6 pt-5" data-testid="actions-page">
      <header className="mx-auto mb-3 w-full max-w-3xl">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Action Center</h1>
        </div>
        <p className="mt-1 text-xs text-muted">
          Email, chat and meeting follow-ups that need you, most important first. Mark what matters
          and it learns.
        </p>
        <div
          role="group"
          aria-label="Action Center sections"
          className="mt-3 inline-grid grid-cols-4 gap-1 rounded-full border border-line bg-field/70 p-0.5 text-xs font-semibold"
        >
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              aria-pressed={section === s.id}
              title={s.hint}
              data-testid={`ac-section-${s.id}`}
              onClick={() => setSection(s.id)}
              className={`rounded-full px-3 py-1 ${section === s.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </header>
      <div className="mx-auto min-h-0 w-full max-w-3xl flex-1">
        {section === 'act' ? (
          <ActionCenter onFlash={onFlash} onSettings={onSettings} />
        ) : section === 'facts' ? (
          <FactsPage embedded onFlash={onFlash} />
        ) : section === 'mail' ? (
          <div className="h-full overflow-y-auto pb-6" data-testid="mail-section">
            <EmailView
              embedded
              mail={mail}
              gmail={gmail}
              onConnect={onConnect}
              onSync={onSync}
              onSettings={onSettings}
              onFlash={onFlash}
            />
          </div>
        ) : (
          <div className="h-full overflow-y-auto pb-6" data-testid="chat-section">
            <ChatView embedded onSettings={onSettings} />
          </div>
        )}
      </div>
    </div>
  )
}
