import Modal from './Modal'

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Anywhere',
    rows: [
      ['Ctrl + K', 'Search everything and run any action'],
      ['Ctrl + N', 'Start a new note'],
      ['Ctrl + J', 'Open or close the Co-Pilot'],
      ['Ctrl + Shift + Space', 'Add a task or note from any app'],
      ['Alt + Left', 'Go back to where you were'],
      ['?', 'Show this list'],
      ['Esc', 'Close a dialog, the Co-Pilot or Settings']
    ]
  },
  {
    title: 'In a note',
    rows: [['Ctrl + Shift + M', 'Switch between writing and reading view']]
  }
]

/** The keyboard shortcuts in one place (also opened from the command palette or by pressing ?). */
export default function ShortcutsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Modal label="Keyboard shortcuts" onClose={onClose} className="w-[28rem] p-5">
      <div className="mb-3 flex items-center">
        <h2 className="flex-1 text-lg font-semibold">Keyboard Shortcuts</h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-fg"
        >
          ✕
        </button>
      </div>
      {GROUPS.map((g) => (
        <section key={g.title} className="mb-3 last:mb-0">
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
            {g.title}
          </h3>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
            {g.rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt>
                  <kbd className="rounded-md border border-line bg-field px-2 py-0.5 text-xs">
                    {k}
                  </kbd>
                </dt>
                <dd className="text-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Modal>
  )
}
