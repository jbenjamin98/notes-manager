import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A small rolling log in userData/logs. It records errors and warnings from the app (never note text,
 * email content or API keys), so "something broke" can be diagnosed afterwards.
 */
const MAX_BYTES = 1_000_000
let dir: string | null = null
let installed = false

const file = (): string | null => (dir ? join(dir, 'app.log') : null)

export function logLine(level: 'info' | 'warn' | 'error', msg: string): void {
  const f = file()
  if (!f) return
  try {
    if (existsSync(f) && statSync(f).size > MAX_BYTES) renameSync(f, join(dir!, 'app.1.log'))
    appendFileSync(
      f,
      `${new Date().toISOString()} ${level.toUpperCase()} ${msg.replace(/\s+/g, ' ').slice(0, 600)}\n`
    )
  } catch {
    /* logging must never break the app */
  }
}

const text = (a: unknown[]): string =>
  a
    .map((x) =>
      x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : JSON.stringify(x)
    )
    .join(' ')

export function initLogger(logDir: string): void {
  mkdirSync(logDir, { recursive: true })
  dir = logDir
  if (installed) return
  installed = true
  const err = console.error.bind(console)
  const warn = console.warn.bind(console)
  console.error = (...a: unknown[]): void => {
    logLine('error', text(a))
    err(...a)
  }
  console.warn = (...a: unknown[]): void => {
    logLine('warn', text(a))
    warn(...a)
  }
  process.on('uncaughtException', (e) => logLine('error', `uncaught: ${text([e])}`))
  process.on('unhandledRejection', (e) => logLine('error', `unhandled rejection: ${text([e])}`))
  logLine('info', 'app started')
}

/** The last lines of the log, for the diagnostics report. */
export function recentLog(lines = 40): string {
  const f = file()
  if (!f || !existsSync(f)) return '(no log yet)'
  try {
    return readFileSync(f, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return '(log unreadable)'
  }
}

export const logDir = (): string | null => dir
