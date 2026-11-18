import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarStatus, GmailStatus, LabelHandler, Output, ThemeMode } from '@shared/contract'
import { relativeTime } from '../format'
import { NUDGE_RULES } from '../nudgeRules'
import { ArrowLeftIcon } from './Icons'
import AiSettings from './AiSettings'
import PersonaPicker from './PersonaPicker'
import CaptureSettings from './CaptureSettings'
import AutoTagSettings from './AutoTagSettings'
import { BridgeSetup } from './BridgeSetup'
import {
  ConnectionPanel,
  GoogleSettings,
  PrivacySettings,
  SupportSettings,
  TimeZoneSettings
} from './SettingsExtras'

type Info = Output<'app:info'>
type Health = Output<'db:health'>

const slug = (t: string): string => 'set-' + t.toLowerCase().replace(/[^a-z]+/g, '-')

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section id={slug(title)} className="scroll-mt-16 border-b border-line py-6">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

const SECTION_INDEX = [
  'Appearance',
  'About You',
  'Time Zone',
  'Google',
  'Nudges and Notifications',
  'Quick Capture',
  'Auto-Tagging',
  'Your Assistant',
  'AI Co-Pilot',
  'Privacy',
  'Gmail Follow-Ups',
  'Backup and Support',
  'Notes Folder'
]

/** Which section is on screen, for the nav highlight. */
function useScrollSpy(ids: string[], root: React.RefObject<HTMLElement | null>): string {
  const [active, setActive] = useState(ids[0])
  useEffect(() => {
    const el = root.current
    if (!el) return
    const onScroll = (): void => {
      const top = el.getBoundingClientRect().top + 90
      let cur = ids[0]
      for (const id of ids) {
        const s = document.getElementById(id)
        if (s && s.getBoundingClientRect().top <= top) cur = id
      }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) cur = ids[ids.length - 1]
      setActive(cur)
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ids, root])
  return active
}

const btn =
  'rounded-md border border-line bg-field px-3 py-1.5 text-sm font-medium hover:bg-hover disabled:opacity-50'

export default function Settings({
  theme,
  onTheme,
  cal,
  gmail,
  onSync,
  onConnect,
  onBack,
  onShowGuide,
  section = null
}: {
  /** Section title to scroll to when opened. */
  section?: string | null
  theme: ThemeMode
  onTheme: (m: ThemeMode) => void
  cal: CalendarStatus
  gmail: GmailStatus
  onSync: () => void
  onConnect: () => void
  onBack: () => void
  onShowGuide: () => void
}): React.JSX.Element {
  const [vault, setVault] = useState('')
  const [names, setNames] = useState('')
  const [namesSaved, setNamesSaved] = useState(false)
  const [mailOn, setMailOn] = useState(true)
  const [nudges, setNudges] = useState({
    enabled: true,
    toasts: true,
    afterHours: false,
    rules: {} as Record<string, boolean>,
    eodTime: '16:45'
  })
  const [background, setBackground] = useState(true)
  const [login, setLogin] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [days, setDays] = useState(30)
  const [mutes, setMutes] = useState<string[]>([])
  const [newMute, setNewMute] = useState('')
  const [muteErr, setMuteErr] = useState<string | null>(null)
  const [mailStats, setMailStats] = useState<{ stored: number; kept: number } | null>(null)
  const [labels, setLabels] = useState<{ name: string; seen: number; handler: LabelHandler }[]>([])
  const [info, setInfo] = useState<Info | null>(null)
  const [health, setHealth] = useState<Health | null>(null)

  const mainRef = useRef<HTMLElement>(null)
  const sectionIds = useMemo(() => SECTION_INDEX.map(slug), [])
  const active = useScrollSpy(sectionIds, mainRef)
  const jump = (t: string): void =>
    document.getElementById(slug(t))?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  useEffect(() => {
    if (!section) return
    const t = setTimeout(
      () => document.getElementById(slug(section))?.scrollIntoView({ block: 'start' }),
      50
    )
    return () => clearTimeout(t)
  }, [section])

  useEffect(() => {
    let alive = true
    void window.api.invoke('settings:get').then((r) => {
      if (!alive || !r.ok) return
      setVault(r.data.vaultPath)
      setNames(r.data.meAliases.join(', '))
      setMailOn(r.data.gmailEnabled)
      setNudges(r.data.nudges)
      setBackground(r.data.runInBackground)
      setLogin(r.data.startAtLogin)
      setDays(r.data.gmailDays)
    })
    const loadMailBits = (): void => {
      void window.api.invoke('gmail:mutes').then((r) => alive && r.ok && setMutes(r.data))
      void window.api
        .invoke('gmail:overview')
        .then(
          (r) =>
            alive && r.ok && setMailStats({ stored: r.data.stats.stored, kept: r.data.stats.kept })
        )
    }
    loadMailBits()
    const loadLabels = (): void => {
      void window.api.invoke('gmail:labels').then((r) => alive && r.ok && setLabels(r.data))
    }
    loadLabels()
    const offMail = window.api.on('gmail:changed', () => {
      loadLabels()
      loadMailBits()
    })
    void window.api.invoke('app:info').then((r) => alive && r.ok && setInfo(r.data))
    void window.api.invoke('db:health').then((r) => alive && r.ok && setHealth(r.data))
    return () => {
      alive = false
      offMail()
    }
  }, [])

  const toggleMail = async (on: boolean): Promise<void> => {
    setMailOn(on)
    await window.api.invoke('settings:update', { gmailEnabled: on })
    if (on) void window.api.invoke('gmail:sync')
  }

  const changeDays = async (d: number): Promise<void> => {
    setDays(d)
    await window.api.invoke('settings:update', { gmailDays: d })
    void window.api.invoke('gmail:sync', { full: true })
  }

  const addMuteEntry = async (): Promise<void> => {
    if (!newMute.trim()) return
    const r = await window.api.invoke('gmail:mute', { target: newMute })
    if (r.ok) {
      setNewMute('')
      setMuteErr(null)
    } else setMuteErr(r.error.message)
  }

  const setHandler = async (name: string, handler: LabelHandler): Promise<void> => {
    setLabels((ls) => ls.map((l) => (l.name === name ? { ...l, handler } : l)))
    await window.api.invoke('gmail:set-label', { name, handler })
  }

  const saveNudges = async (next: typeof nudges): Promise<void> => {
    setNudges(next)
    await window.api.invoke('settings:update', { nudges: next })
  }

  const saveBackground = async (patch: {
    runInBackground?: boolean
    startAtLogin?: boolean
  }): Promise<void> => {
    if (patch.runInBackground !== undefined) setBackground(patch.runInBackground)
    if (patch.startAtLogin !== undefined) setLogin(patch.startAtLogin)
    await window.api.invoke('settings:update', patch)
  }

  const sendTest = async (): Promise<void> => {
    setTestResult({ ok: true, text: 'Sending…' })
    const r = await window.api.invoke('nudges:test')
    if (!r.ok) return setTestResult({ ok: false, text: r.error.message })
    const t = r.data
    setTestResult(
      !t.supported
        ? { ok: false, text: 'Windows notifications are not available to this app.' }
        : t.error
          ? { ok: false, text: `Windows reported: ${t.error}` }
          : t.shown
            ? {
                ok: true,
                text: 'Windows accepted it. Look at the bottom-right corner of your screen, or open the notification centre.'
              }
            : {
                ok: false,
                text: 'Windows did not confirm it. Check Settings → System → Notifications (turn on Note Manager) and that Focus assist / Do not disturb is off.'
              }
    )
  }

  const saveNames = async (): Promise<void> => {
    const list = [
      ...new Set([
        'Me',
        ...names
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      ])
    ]
    const r = await window.api.invoke('settings:update', { meAliases: list })
    if (r.ok) {
      setNames(r.data.meAliases.join(', '))
      setNamesSaved(true)
      setTimeout(() => setNamesSaved(false), 2500)
    }
  }

  const chooseVault = async (): Promise<void> => {
    const picked = await window.api.invoke('vault:choose-folder')
    if (picked.ok && picked.data) {
      const upd = await window.api.invoke('settings:update', { vaultPath: picked.data })
      if (upd.ok) setVault(upd.data.vaultPath)
    }
  }

  const modes: [ThemeMode, string][] = [
    ['system', 'System'],
    ['light', 'Light'],
    ['dark', 'Dark']
  ]

  return (
    <main ref={mainRef} className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl gap-8 px-6 py-6">
        {/* Wide windows: a quiet list of sections that follows where you are */}
        <nav
          aria-label="Settings sections"
          className="sticky top-6 hidden w-48 shrink-0 self-start lg:block"
        >
          <button
            onClick={onBack}
            className="mb-5 flex items-center gap-1.5 text-sm text-muted hover:text-fg"
          >
            <ArrowLeftIcon width={14} height={14} /> Back
          </button>
          <p className="mb-2 px-3 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
            Settings
          </p>
          <ul className="space-y-0.5">
            {SECTION_INDEX.map((t) => (
              <li key={t}>
                <a
                  href={'#' + slug(t)}
                  aria-current={active === slug(t) ? 'location' : undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    jump(t)
                  }}
                  className={`relative block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    active === slug(t)
                      ? 'bg-accent-soft font-medium text-fg'
                      : 'text-muted hover:bg-hover hover:text-fg'
                  }`}
                >
                  {active === slug(t) && (
                    <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />
                  )}
                  {t}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 max-w-xl flex-1">
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-1.5 text-sm text-muted hover:text-fg lg:hidden"
          >
            <ArrowLeftIcon width={14} height={14} /> Back
          </button>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          {/* Narrow windows: one slim row of tabs with an underline */}
          <nav
            aria-label="Settings sections"
            className="sticky top-0 z-10 -mx-6 mt-2 flex gap-4 overflow-x-auto border-b border-line bg-sticky px-6 backdrop-blur-md lg:hidden"
          >
            {SECTION_INDEX.map((t) => (
              <a
                key={t}
                href={'#' + slug(t)}
                onClick={(e) => {
                  e.preventDefault()
                  jump(t)
                }}
                className={`shrink-0 border-b-2 py-2 text-xs whitespace-nowrap transition-colors ${
                  active === slug(t)
                    ? 'border-accent font-medium text-fg'
                    : 'border-transparent text-muted hover:text-fg'
                }`}
              >
                {t}
              </a>
            ))}
          </nav>

          <Section title="Appearance">
            <div
              role="radiogroup"
              aria-label="Theme"
              className="inline-flex gap-1 rounded-lg bg-hover p-1"
            >
              {modes.map(([m, label]) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={theme === m}
                  onClick={() => onTheme(m)}
                  className={`rounded-md px-4 py-1 text-sm font-medium ${
                    theme === m ? 'bg-field shadow-sm' : 'text-muted hover:text-fg'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Section>

          <Section title="About You">
            <label className="block text-sm">
              Names you go by
              <input
                value={names}
                onChange={(e) => setNames(e.target.value)}
                onBlur={() => void saveNames()}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                placeholder="Me, Jacob"
                className="mt-1 w-full rounded-lg border border-line bg-field px-3 py-2 text-sm"
              />
            </label>
            <p className="mt-2 text-xs text-muted">
              Tasks assigned to any of these count as yours, and you are left out of the People
              list. Separate with commas.{namesSaved && <span className="text-ok"> Saved.</span>}
            </p>
          </Section>

          <Section title="Time Zone">
            <TimeZoneSettings />
          </Section>

          <Section title="Google">
            <ConnectionPanel />
            <div className="mt-3" />
            <BridgeSetup />
            <div className="mt-3" />
            <GoogleSettings cal={cal} onSync={onSync} onConnect={onConnect} />
          </Section>

          <Section title="Nudges and Notifications">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={nudges.enabled}
                onChange={(e) => void saveNudges({ ...nudges, enabled: e.target.checked })}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Remind me about things (morning brief, meeting prep, follow-ups)
            </label>
            {nudges.enabled && (
              <>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={nudges.afterHours}
                    onChange={(e) => void saveNudges({ ...nudges, afterHours: e.target.checked })}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  Also notify me after hours and on weekends
                </label>
                <p className="mt-1 ml-6 text-xs text-muted">
                  Meeting prep and reminders you set always notify, at any hour.
                </p>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={nudges.toasts}
                    onChange={(e) => void saveNudges({ ...nudges, toasts: e.target.checked })}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  Show Windows notifications during work hours
                </label>
                <ul className="mt-3">
                  {NUDGE_RULES.map((r) => (
                    <li key={r.id} className="border-t border-line py-2 first:border-t-0">
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={nudges.rules[r.id] !== false}
                          onChange={(e) =>
                            void saveNudges({
                              ...nudges,
                              rules: { ...nudges.rules, [r.id]: e.target.checked }
                            })
                          }
                          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                        />
                        <span>
                          {r.label}
                          <span className="block text-xs text-muted">{r.description}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  End-of-day nudge at
                  <input
                    type="time"
                    value={nudges.eodTime}
                    onChange={(e) =>
                      e.target.value && void saveNudges({ ...nudges, eodTime: e.target.value })
                    }
                    className="rounded-lg border border-line bg-field px-2 py-1 text-sm"
                  />
                </label>
                <p className="mt-1 text-xs text-muted">
                  Nudges only fire on weekdays. Your work hours are 8 AM to 6 PM.
                </p>
              </>
            )}

            <h3 className="mt-5 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
              Running in the Background
            </h3>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={background}
                onChange={(e) => void saveBackground({ runInBackground: e.target.checked })}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Keep running in the system tray when I close the window
            </label>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={login}
                onChange={(e) => void saveBackground({ startAtLogin: e.target.checked })}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Start automatically when I sign in to Windows
            </label>
            <p className="mt-1 text-xs text-muted">
              Nudges can only arrive while the app is running. Neither option needs administrator
              rights.
            </p>
            <button className={`${btn} mt-3`} onClick={() => void sendTest()}>
              Send a test notification
            </button>
            {testResult && (
              <p className={`mt-2 text-xs ${testResult.ok ? 'text-muted' : 'text-danger'}`}>
                {testResult.text}
              </p>
            )}
          </Section>

          <Section title="Setup Guide">
            <p className="mb-3 text-sm text-muted">
              Walks through your notes folder, connecting Google, and getting an AI key.
            </p>
            <button className={btn} onClick={onShowGuide}>
              Show the setup guide
            </button>
          </Section>

          <Section title="Quick Capture">
            <CaptureSettings />
          </Section>

          <Section title="Auto-Tagging">
            <AutoTagSettings />
          </Section>

          <Section title="Your Assistant">
            <PersonaPicker />
          </Section>

          <Section title="AI Co-Pilot">
            <AiSettings />
          </Section>

          <Section title="Privacy">
            <PrivacySettings />
          </Section>

          <Section title="Gmail Follow-Ups">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={mailOn}
                onChange={(e) => void toggleMail(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Read my Gmail to find follow-ups
            </label>
            <p className="mt-2 text-sm text-muted">
              {!mailOn
                ? 'Off. Nothing is read from Gmail.'
                : gmail.state === 'needs-auth'
                  ? 'Not connected. Sign in above.'
                  : gmail.lastSyncAt
                    ? `Last synced ${relativeTime(gmail.lastSyncAt)} · ${gmail.threads} conversations indexed.`
                    : 'Not synced yet.'}
              {gmail.error && <span className="text-danger"> {gmail.error}</span>}
              {mailOn && gmail.health === 'degraded' && gmail.lastSyncAt && (
                <span className="text-warn"> {gmail.healthDetail}</span>
              )}
            </p>
            <p className="mt-1 text-xs text-muted">
              Subjects, senders, times and labels are kept on this computer. The text of recent
              threads is read in memory to find actions and decisions; only those points and a short
              excerpt are kept, never the message itself. You can turn this off in the Google
              settings.
            </p>
            {mailOn && (
              <div className="mt-4">
                <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                  What to Do With Each Label
                </h3>
                {labels.length === 0 ? (
                  <p className="text-sm text-muted">
                    Your labels appear here after the first mail sync.
                  </p>
                ) : (
                  <ul>
                    {labels.map((l) => (
                      <li
                        key={l.name}
                        className="flex items-center gap-3 border-t border-line py-2 first:border-t-0"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {l.name} <span className="text-xs text-muted">· {l.seen} recent</span>
                        </span>
                        <div
                          role="radiogroup"
                          aria-label={`Handling for ${l.name}`}
                          className="inline-flex gap-1 rounded-lg bg-hover p-1"
                        >
                          {(
                            [
                              ['ignore', 'Ignore'],
                              ['info', 'Counts'],
                              ['tasks', 'Tasks']
                            ] as [LabelHandler, string][]
                          ).map(([h, label]) => (
                            <button
                              key={h}
                              role="radio"
                              aria-checked={l.handler === h}
                              onClick={() => void setHandler(l.name, h)}
                              className={`rounded-md px-2.5 py-0.5 text-xs font-medium ${
                                l.handler === h ? 'bg-field shadow-sm' : 'text-muted hover:text-fg'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-muted">
                  <b>Counts</b> shows an unread count. <b>Tasks</b> lists those emails in the Action
                  Center so you can turn them into tasks. <b>Ignore</b> hides them.
                </p>
              </div>
            )}
          </Section>

          {mailOn && (
            <Section title="Mail Filtering">
              <p className="mb-3 text-sm text-muted">
                Only mail that needs you is brought in: starred mail, mail with a label you made,
                conversations you replied to, and person-to-person mail in your inbox. Newsletters,
                no-reply senders, calendar chatter and unlabeled archived mail are skipped.
                {mailStats && mailStats.stored > 0 && (
                  <>
                    {' '}
                    Right now <b>{mailStats.kept}</b> of {mailStats.stored} conversations are shown.
                  </>
                )}
              </p>

              <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                How Far Back to Read
              </h3>
              <div
                role="radiogroup"
                aria-label="Mail history"
                className="inline-flex gap-1 rounded-lg bg-hover p-1"
              >
                {[14, 30, 60, 90].map((d) => (
                  <button
                    key={d}
                    role="radio"
                    aria-checked={days === d}
                    onClick={() => void changeDays(d)}
                    className={`rounded-md px-3 py-1 text-sm font-medium ${
                      days === d ? 'bg-field shadow-sm' : 'text-muted hover:text-fg'
                    }`}
                  >
                    {d} days
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                {gmail.lastRead > 0
                  ? `Last sync read ${gmail.lastRead} conversations in ${gmail.lastPages} page${gmail.lastPages === 1 ? '' : 's'} (${gmail.lastFull ? 'full history' : 'recent days only'}).`
                  : 'Nothing read yet.'}
                {gmail.partial && gmail.lastRead > 0 && (
                  <span className="text-warn"> It stopped before reaching the full window.</span>
                )}{' '}
                <button
                  className="underline hover:text-fg"
                  onClick={() => void window.api.invoke('gmail:sync', { full: true })}
                  disabled={gmail.state === 'syncing'}
                >
                  Re-read everything now
                </button>
              </p>

              <h3 className="mt-5 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                Blocked Senders
              </h3>
              {mutes.length === 0 ? (
                <p className="text-sm text-muted">
                  None. Use Block on any email in the Action Center to hide a sender (or a whole
                  domain) for good.
                </p>
              ) : (
                <ul>
                  {mutes.map((m) => (
                    <li
                      key={m}
                      className="flex items-center gap-3 border-t border-line py-1.5 first:border-t-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {m.startsWith('@') ? `Everyone at ${m.slice(1)}` : m}
                      </span>
                      <button
                        className="text-xs text-muted underline hover:text-fg"
                        onClick={() => void window.api.invoke('gmail:unmute', { pattern: m })}
                      >
                        Unmute
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex gap-2">
                <input
                  value={newMute}
                  onChange={(e) => setNewMute(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void addMuteEntry()}
                  placeholder="name@example.com or example.com"
                  aria-label="Mute a sender or domain"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-field px-3 py-1.5 text-sm"
                />
                <button className={btn} onClick={() => void addMuteEntry()}>
                  Mute
                </button>
              </div>
              {muteErr && <p className="mt-1 text-xs text-danger">{muteErr}</p>}
            </Section>
          )}

          <Section title="Backup and Support">
            <SupportSettings />
          </Section>

          <Section title="Notes Folder">
            <p className="mb-3 text-sm break-all text-muted">{vault || '…'}</p>
            <button className={btn} onClick={() => void chooseVault()}>
              Change Folder…
            </button>
            <p className="mt-2 text-xs text-muted">
              Notes are plain Markdown files. The search index is rebuilt from them whenever you
              change folders.
            </p>
          </Section>

          <details className="py-6 text-sm">
            <summary className="cursor-pointer font-semibold">Technical details</summary>
            <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1.5 text-muted">
              <dt>App</dt>
              <dd>
                {info ? `${info.version} · Electron ${info.electron} · Node ${info.node}` : '…'}
              </dd>
              <dt>Database</dt>
              <dd>
                {health
                  ? `SQLite ${health.sqliteVersion} · schema v${health.schemaVersion} · full-text search ${health.ftsOk ? 'OK' : 'unavailable'}`
                  : '…'}
              </dd>
              <dt>Index file</dt>
              <dd className="break-all">{health?.path ?? '…'}</dd>
            </dl>
          </details>
        </div>
      </div>
    </main>
  )
}
