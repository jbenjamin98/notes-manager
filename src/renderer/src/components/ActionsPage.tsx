import ActionCenter from './ActionCenter'

/**
 * The Action Center as a page of its own: everything from email, chat and meetings that wants a
 * decision, ranked by how much it matters, with the unimportant held back under Hidden.
 */
export default function ActionsPage({
  onFlash,
  onSettings
}: {
  onFlash: (m: string, undo?: () => void) => void
  onSettings: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col px-6 pt-5" data-testid="actions-page">
      <header className="mx-auto mb-3 w-full max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Action Center</h1>
        <p className="mt-1 text-xs text-muted">
          Email, chat and meeting follow-ups that need you, most important first. Mark what matters
          and it learns.
        </p>
      </header>
      <div className="mx-auto min-h-0 w-full max-w-3xl flex-1">
        <ActionCenter onFlash={onFlash} onSettings={onSettings} />
      </div>
    </div>
  )
}
