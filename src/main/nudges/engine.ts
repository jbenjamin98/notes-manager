import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import { wallClock } from '../../shared/tz'
import type { TaskItem } from '../vault/vault'
import type { GmailOverview } from '../gmail/sync'
import {
  ALL_RULES,
  parseHm,
  isWeekday,
  type Candidate,
  type Env,
  type NudgeAction,
  type RuleId
} from './rules'

export interface NudgeSettings {
  enabled: boolean
  toasts: boolean
  /** Also pop up Windows notifications outside work hours and on weekends. */
  afterHours?: boolean
  /** Per-rule switches; a missing rule is ON. */
  rules: Record<string, boolean>
  eodTime: string
}

export interface EngineSettings {
  /** IANA zone the work day is measured in. Missing = the computer's clock (used by tests). */
  timezone?: string
  nudges: NudgeSettings
  workHours: { start: string; end: string }
  defaultTaskMinutes: number
}

export interface Nudge {
  id: string
  /** 'reminder' is user-set (from the Co-Pilot), not an evaluated rule. */
  rule: RuleId | 'reminder'
  title: string
  body: string
  actions: NudgeAction[]
  status: 'new' | 'read' | 'dismissed' | 'snoozed'
  createdAt: string
}

interface Row {
  id: string
  rule: string
  title: string
  body: string | null
  payload_json: string | null
  status: Nudge['status']
  created_at: string
}

const toNudge = (r: Row): Nudge => ({
  id: r.id,
  rule: r.rule as Nudge['rule'],
  title: r.title,
  body: r.body ?? '',
  actions: r.payload_json ? (JSON.parse(r.payload_json) as NudgeAction[]) : [],
  status: r.status,
  createdAt: r.created_at
})

export interface EngineDeps {
  getSettings: () => EngineSettings
  getTasks: () => TaskItem[]
  getMail: () => GmailOverview | null
  /** Called with nudges created by a tick (for toasts and UI refresh). */
  onNew?: (n: Nudge[], opts?: { force?: boolean }) => void
  onChanged?: () => void
}

const RETENTION_DAYS = 30

export class NudgeEngine {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private db: Db,
    private deps: EngineDeps
  ) {}

  private env(now: Date): Env {
    const s = this.deps.getSettings()
    const rules = s.nudges.rules
    return {
      now,
      db: this.db,
      tasks: this.deps.getTasks(),
      mail: this.deps.getMail(),
      workStartMin: parseHm(s.workHours.start, 8 * 60),
      workEndMin: parseHm(s.workHours.end, 18 * 60),
      eodMin: parseHm(s.nudges.eodTime, 16 * 60 + 45),
      defaultTaskMinutes: s.defaultTaskMinutes,
      enabled: (r) => rules[r] !== false
    }
  }

  /**
   * Evaluate every enabled rule at `now`. Safe to call as often as you like (every minute, on
   * resume from sleep, after a calendar sync): each candidate is stored under a unique key, so only
   * genuinely new ones come back.
   */
  tick(real: Date = new Date()): Nudge[] {
    const now = wallClock(real, this.deps.getSettings().timezone)
    const created: Nudge[] = this.promoteReminders(real)
    if (!this.deps.getSettings().nudges.enabled) {
      if (created.length) {
        this.deps.onNew?.(created)
        this.deps.onChanged?.()
      }
      return created
    }
    const env = this.env(now)
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO nudges (id, dedupe_key, rule, title, body, payload_json, status, created_at)
       VALUES (?,?,?,?,?,?, 'new', ?)`
    )
    for (const [rule, fn] of Object.entries(ALL_RULES) as [RuleId, (e: Env) => Candidate[]][]) {
      if (!env.enabled(rule)) continue
      let cands: Candidate[] = []
      try {
        cands = fn(env)
      } catch (err) {
        console.error(`[nudges] rule ${rule} failed`, err)
      }
      for (const c of cands) {
        const id = randomUUID()
        const r = ins.run(
          id,
          c.key,
          c.rule,
          c.title,
          c.body,
          JSON.stringify(c.actions),
          real.toISOString()
        )
        if (Number(r.changes) > 0) {
          created.push({
            id,
            rule: c.rule,
            title: c.title,
            body: c.body,
            actions: c.actions,
            status: 'new',
            createdAt: real.toISOString()
          })
        }
      }
    }
    this.db.exec(
      `DELETE FROM nudges WHERE created_at < datetime('now','-${RETENTION_DAYS} days') AND NOT (rule = 'reminder' AND status = 'snoozed')`
    )
    if (created.length) {
      this.deps.onNew?.(created)
      this.deps.onChanged?.()
    }
    return created
  }

  /** A reminder is a nudge that starts snoozed and wakes at its time. Returns the new id. */
  addReminder(text: string, at: Date, now: Date = new Date()): string {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO nudges (id, dedupe_key, rule, title, body, payload_json, status, snooze_until, created_at)
         VALUES (?,?,?,?,?,?, 'snoozed', ?, ?)`
      )
      .run(
        id,
        `reminder:${id}`,
        'reminder',
        text,
        'Reminder you set',
        '[]',
        at.toISOString(),
        now.toISOString()
      )
    this.deps.onChanged?.()
    return id
  }

  /** Reminders whose time has come become real, unread nudges (and toast). */
  private promoteReminders(now: Date): Nudge[] {
    const rows = this.db
      .prepare(
        `SELECT id, rule, title, body, payload_json, status, created_at FROM nudges
          WHERE rule = 'reminder' AND status = 'snoozed' AND snooze_until <= ?`
      )
      .all(now.toISOString()) as unknown as Row[]
    const up = this.db.prepare("UPDATE nudges SET status = 'new', created_at = ? WHERE id = ?")
    return rows.map((r) => {
      up.run(now.toISOString(), r.id)
      return { ...toNudge(r), status: 'new' as const, createdAt: now.toISOString() }
    })
  }

  /** New and read nudges, plus snoozed ones whose time has come. Newest first. */
  list(now: Date = new Date()): Nudge[] {
    return (
      this.db
        .prepare(
          `SELECT id, rule, title, body, payload_json, status, created_at FROM nudges
            WHERE status IN ('new','read') OR (status = 'snoozed' AND snooze_until <= ?)
            ORDER BY created_at DESC LIMIT 100`
        )
        .all(now.toISOString()) as unknown as Row[]
    ).map((r) => ({ ...toNudge(r), status: r.status === 'snoozed' ? 'new' : r.status }))
  }

  unread(now: Date = new Date()): number {
    return (
      this.db
        .prepare(
          `SELECT count(*) AS c FROM nudges WHERE status = 'new' OR (status = 'snoozed' AND snooze_until <= ?)`
        )
        .get(now.toISOString()) as { c: number }
    ).c
  }

  markRead(id?: string): void {
    if (id)
      this.db.prepare("UPDATE nudges SET status = 'read' WHERE id = ? AND status = 'new'").run(id)
    else this.db.exec("UPDATE nudges SET status = 'read' WHERE status = 'new'")
    this.deps.onChanged?.()
  }

  dismiss(id: string): void {
    this.db.prepare("UPDATE nudges SET status = 'dismissed' WHERE id = ?").run(id)
    this.deps.onChanged?.()
  }

  snooze(id: string, minutes = 60, now: Date = new Date()): void {
    const until = new Date(now.getTime() + minutes * 60_000).toISOString()
    this.db
      .prepare("UPDATE nudges SET status = 'snoozed', snooze_until = ? WHERE id = ?")
      .run(until, id)
    this.deps.onChanged?.()
  }

  /** A harmless sample so the user can confirm toasts work on their machine. */
  test(now: Date = new Date()): Nudge {
    const n: Nudge = {
      id: randomUUID(),
      rule: 'brief',
      title: 'Notifications are working',
      body: 'This is how nudges will look. You can turn any of them off in Settings.',
      actions: [],
      status: 'new',
      createdAt: now.toISOString()
    }
    this.db
      .prepare(
        `INSERT INTO nudges (id, dedupe_key, rule, title, body, payload_json, status, created_at) VALUES (?,?,?,?,?,?, 'new', ?)`
      )
      .run(n.id, `test:${n.id}`, n.rule, n.title, n.body, '[]', n.createdAt)
    this.deps.onNew?.([n], { force: true }) // a test must always try, whatever the hour
    this.deps.onChanged?.()
    return n
  }

  /** Tick once a minute. Pass a catch-up tick after sleep/resume. */
  start(everyMs = 60_000): void {
    this.stop()
    setTimeout(() => this.tick(), 15_000) // after the first calendar sync has had a chance
    this.timer = setInterval(() => this.tick(), everyMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Time-critical nudges notify at any hour; the rest wait for work hours unless the user allows after-hours. */
  static readonly ALWAYS: string[] = ['prep', 'reminder', 'assistant']

  /** Whether a toast should pop up now: weekday, inside work hours (the feed always gets it). */
  shouldToast(real: Date = new Date()): boolean {
    const s = this.deps.getSettings()
    const now = wallClock(real, s.timezone)
    if (!s.nudges.toasts) return false
    if (s.nudges.afterHours) return true
    const m = now.getHours() * 60 + now.getMinutes()
    return (
      isWeekday(now) &&
      m >= parseHm(s.workHours.start, 480) - 15 &&
      m <= parseHm(s.workHours.end, 1080) + 90
    )
  }
}
