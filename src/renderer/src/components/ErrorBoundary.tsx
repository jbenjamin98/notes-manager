import { Component, type ErrorInfo, type ReactNode } from 'react'

/** A bug in one screen must never blank the whole app: show a way out instead. */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] crashed', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 p-8 text-center text-fg">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted">
          Your notes are safe: they are files in your notes folder and nothing here changes them.
          Reload to carry on.
        </p>
        <pre className="max-w-xl overflow-auto rounded-lg bg-field p-3 text-left text-xs text-muted">
          {this.state.error.message}
        </pre>
        <button
          className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-accent-fg"
          onClick={() => location.reload()}
        >
          Reload
        </button>
      </div>
    )
  }
}
