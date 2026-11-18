import type { Db } from '../db'
import type { TaskItem, Vault } from '../vault/vault'
import type { MailBody } from '../google/mailBody'
import { eventsForDay } from '../calendar/sync'
import { loadDetail } from '../calendar/detail'
import { isPersonThread } from '../gmail/relevance'
import { worthwhileThreadIds } from '../gmail/sync'
import { mailExtra } from '../gmail/extra'
import { insightsFor, listInsights } from '../insights/store'
import { triage, topicMatcher } from '../chat/triage'
import { listWaiting } from '../waiting/waiting'
import { entitiesIn } from './context'
import { retrieve } from './retrieve'

/**
 * The things the assistant can look at while it thinks. Every tool is read-only and local, and
 * returns a few short, numbered sources (the agent numbers them across the whole conversation so
 * the model can cite them). Nothing here calls the network except `read_email`, which reads one
 * thread's text in memory (never stored) and only when you have allowed reading email text.
 */
export interface ToolSource {
  kind: 'note' | 'task' | 'meeting' | 'waiting' | 'insight' | 'person' | 'mail' | 'chat'
  label: string
  text: string
  /** A note to open when this is cited. */
  path: string | null
  title: string
  date: string
  heading: string | null
}

export interface ToolDeps {
  db: Db
  vault: () => Vault
  today: string
  me: string[]
  /** Characters a tool may return in total (the mode's budget share). */
  chars: number
  mailBodies?: (ids: string[]) => Promise<MailBody[]>
  readMail: () => boolean
}

export interface ToolSpec {
  name: string
  /** One line telling the model what it is for and what to pass. */
  help: string
  /** What the user sees while it runs ("Checking your calendar…"). */
  working: (args: Args) => string
  run: (deps: ToolDeps, args: Args) => Promise<ToolSource[]> | ToolSource[]
}

export type Args = Record<string, unknown>

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const blank = { path: null, title: '', date: '', heading: null }

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + n)
  return d.toLocaleDateString('en-CA')
}
const isIso = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

const words = (q: string): string[] =>
  [...new Set(q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [])].slice(0, 8)

/** Keep the sources inside the tool's character budget. */
function fit(list: ToolSource[], chars: number): ToolSource[] {
  const out: ToolSource[] = []
  let used = 0
  for (const s of list) {
    const room = chars - used
    if (room < 80) break
    const text = s.text.length > room ? s.text.slice(0, room - 1) + '…' : s.text
    out.push({ ...s, text })
    used += text.length + s.label.length
  }
  return out
}

const taskLine = (t: TaskItem, today: string): string =>
  `${t.description}${t.priority ? ` [${t.priority}]` : ''}${t.due ? ` (due ${t.due}${t.due < today ? ', overdue' : ''})` : ''} · from ${t.noteTitle}`

export const TOOLS: ToolSpec[] = [
  {
    name: 'search_notes',
    help: 'Search the text of your notes. args: {"query": words to look for}',
    working: (a) => `Searching your notes for “${str(a.query, 40)}”…`,
    run: (d, a) =>
      retrieve(d.db, str(a.query), 6, Math.round(d.chars / 5)).map((h) => ({
        kind: 'note' as const,
        label: `${h.title} (${h.date})${h.heading ? ' - ' + h.heading : ''}`,
        text: h.text,
        path: h.path,
        title: h.title,
        date: h.date,
        heading: h.heading
      }))
  },
  {
    name: 'read_note',
    help: 'Read one whole note. args: {"path": the note path from an earlier source}',
    working: () => 'Reading a note…',
    run: async (d, a) => {
      const path = str(a.path, 300)
      const n = await d.vault().readNote(path)
      const body = n.content.replace(/^---[\s\S]*?\n---\s*/, '').trim()
      const row = d.db.prepare('SELECT title, date FROM notes WHERE file_path = ?').get(path) as
        { title: string; date: string } | undefined
      return [
        {
          kind: 'note',
          label: `${row?.title ?? path} (${row?.date ?? ''}), the whole note`,
          text: body,
          path,
          title: row?.title ?? path,
          date: row?.date ?? '',
          heading: null
        }
      ]
    }
  },
  {
    name: 'list_tasks',
    help: 'Your own tasks. args: {"filter": "open"|"overdue"|"today"|"week"|"done", "query": optional words}',
    working: () => 'Looking at your tasks…',
    run: (d, a) => {
      const f = str(a.filter) || 'open'
      const q = words(str(a.query))
      let tasks: TaskItem[]
      try {
        tasks = d.vault().listTasks()
      } catch {
        return []
      }
      const mine = tasks.filter((t) => t.isMine)
      let pick = mine.filter((t) => t.status === 'open')
      if (f === 'done') pick = mine.filter((t) => t.status === 'completed').slice(0, 20)
      if (f === 'overdue') pick = pick.filter((t) => t.due !== null && t.due < d.today)
      if (f === 'today') pick = pick.filter((t) => t.due !== null && t.due <= d.today)
      if (f === 'week') pick = pick.filter((t) => t.due !== null && t.due <= addDays(d.today, 7))
      if (q.length)
        pick = pick.filter((t) =>
          q.some((w) =>
            `${t.description} ${t.noteTitle} ${t.account ?? ''}`.toLowerCase().includes(w)
          )
        )
      pick.sort((x, y) => (x.due ?? '9999').localeCompare(y.due ?? '9999'))
      return pick.slice(0, 25).map((t) => ({
        kind: 'task' as const,
        label: `Your task${t.due ? ` · due ${t.due}` : ''}`,
        text: taskLine(t, d.today),
        path: t.notePath,
        title: t.noteTitle,
        date: t.since,
        heading: null
      }))
    }
  },
  {
    name: 'waiting_on',
    help: 'What other people owe you (note lines "Waiting on …"). args: {"who": optional name}',
    working: (a) =>
      str(a.who) ? `Checking what ${str(a.who, 30)} owes you…` : 'Checking what people owe you…',
    run: (d, a) => {
      const who = str(a.who).toLowerCase()
      return listWaiting(d.db)
        .filter((w) => !who || w.who.toLowerCase().includes(who.split(/\s+/)[0]))
        .slice(0, 20)
        .map((w) => ({
          kind: 'waiting' as const,
          label: `Waiting on ${w.who}`,
          text: `${w.text}${w.due ? ` (due ${w.due})` : ''}, waiting since ${w.since}`,
          path: w.notePath,
          title: w.noteTitle,
          date: w.since,
          heading: null
        }))
    }
  },
  {
    name: 'calendar',
    help: 'Meetings between two dates, with who is invited. args: {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"} (max 14 days)',
    working: () => 'Checking your calendar…',
    run: (d, a) => {
      const from = isIso(str(a.from)) ? str(a.from) : d.today
      let to = isIso(str(a.to)) ? str(a.to) : from
      if (to < from) to = from
      if (to > addDays(from, 13)) to = addDays(from, 13)
      const out: ToolSource[] = []
      for (let day = from; day <= to; day = addDays(day, 1))
        for (const e of eventsForDay(d.db, day)) {
          const det = loadDetail(d.db, e.id)
          const guests = (det?.detail.guests ?? [])
            .slice(0, 8)
            .map((g) => g.name ?? g.email.split('@')[0])
          const note = d.db
            .prepare('SELECT file_path AS p FROM notes WHERE calendar_event_id = ? LIMIT 1')
            .get(e.id) as { p: string } | undefined
          out.push({
            kind: 'meeting',
            label: `Meeting · ${day} ${e.start}`,
            text: `${e.start}-${e.end} ${e.title}${e.status === 'tentative' ? ' (tentative)' : ''}${guests.length ? `. With: ${guests.join(', ')}` : ''}${note ? '. Has a meeting note.' : ''}`,
            path: note?.p ?? null,
            title: e.title,
            date: day,
            heading: null
          })
        }
      return out.slice(0, 40)
    }
  },
  {
    name: 'person_or_topic',
    help: 'Everything about one person, company, project or topic: notes, open tasks, what came out of mail/chat/meetings. args: {"name": the name}',
    working: (a) => `Pulling together what you have on ${str(a.name, 40)}…`,
    run: (d, a) => {
      const name = str(a.name)
      if (!name) return []
      const ents = entitiesIn(d.db, ` ${name} `)
      const ent =
        ents[0] ??
        (d.db
          .prepare(
            `SELECT e.id, e.name, e.category, 0 AS notes, NULL AS last FROM entities e WHERE lower(e.name) LIKE lower(?) ORDER BY length(e.name) LIMIT 1`
          )
          .get(`%${name}%`) as
          | { id: string; name: string; category: string; notes: number; last: string | null }
          | undefined)
      const out: ToolSource[] = []
      if (ent) {
        const dos = d.vault().entityDossier(ent.id)
        if (dos) {
          out.push({
            kind: 'person',
            label: `${dos.category === 'person' ? 'Person' : 'Topic'} · ${dos.name}`,
            text: `${dos.name}${dos.aliases.length ? ` (also: ${dos.aliases.join(', ')})` : ''}: in ${dos.totalNotes} notes, ${dos.totalMentions} mentions.`,
            ...blank
          })
          for (const n of dos.notes.slice(0, 6))
            out.push({
              kind: 'note',
              label: `${n.title} (${n.date})`,
              text: n.snippet,
              path: n.path,
              title: n.title,
              date: n.date,
              heading: null
            })
          const first = dos.name.split(/\s+/)[0].toLowerCase()
          const all = ((): TaskItem[] => {
            try {
              return d.vault().listTasks()
            } catch {
              return []
            }
          })()
          for (const t of all
            .filter(
              (x) =>
                x.status === 'open' &&
                (x.owner.toLowerCase().includes(first) ||
                  x.description.toLowerCase().includes(first) ||
                  x.noteTitle.toLowerCase().includes(first))
            )
            .slice(0, 6))
            out.push({
              kind: 'task',
              label: `Open task · ${t.owner}${t.due ? ` · due ${t.due}` : ''}`,
              text: taskLine(t, d.today),
              path: t.notePath,
              title: t.noteTitle,
              date: t.since,
              heading: null
            })
        }
        for (const i of insightsFor(d.db, ent.name, 8))
          out.push({
            kind: 'insight',
            label: `${i.kind[0].toUpperCase()}${i.kind.slice(1)} · ${i.sourceLabel}`,
            text: `${i.text}${i.owner ? ` (owner: ${i.owner})` : ''}${i.due ? ` (due ${i.due})` : ''}`,
            ...blank,
            date: (i.sourceAt ?? '').slice(0, 10)
          })
      } else {
        // Not a known name: fall back to a text search so the question is not a dead end.
        for (const h of retrieve(d.db, name, 5, Math.round(d.chars / 6)))
          out.push({
            kind: 'note',
            label: `${h.title} (${h.date})`,
            text: h.text,
            path: h.path,
            title: h.title,
            date: h.date,
            heading: h.heading
          })
      }
      const w = name.split(/\s+/)[0].toLowerCase()
      for (const x of listWaiting(d.db)
        .filter((x) => x.who.toLowerCase().includes(w))
        .slice(0, 5))
        out.push({
          kind: 'waiting',
          label: `Waiting on ${x.who}`,
          text: `${x.text}${x.due ? ` (due ${x.due})` : ''}`,
          path: x.notePath,
          title: x.noteTitle,
          date: x.since,
          heading: null
        })
      return out
    }
  },
  {
    name: 'inbox_insights',
    help: 'Actions, decisions, risks and facts pulled from meetings, email and chat. args: {"query": optional words}',
    working: () => 'Checking what came out of your meetings, mail and chat…',
    run: (d, a) => {
      const q = words(str(a.query))
      const rows = [...listInsights(d.db, 'new', 80), ...listInsights(d.db, 'accepted', 80)]
      const pick = q.length
        ? rows.filter((r) =>
            q.some((w) =>
              `${r.text} ${r.owner ?? ''} ${r.entities.join(' ')} ${r.sourceLabel}`
                .toLowerCase()
                .includes(w)
            )
          )
        : rows.slice(0, 20)
      return pick.slice(0, 16).map((i) => ({
        kind: 'insight' as const,
        label: `${i.kind[0].toUpperCase()}${i.kind.slice(1)} · ${i.sourceLabel}`,
        text: `${i.text}${i.owner ? ` (owner: ${i.owner})` : ''}${i.due ? ` (due ${i.due})` : ''}`,
        ...blank,
        date: (i.sourceAt ?? '').slice(0, 10)
      }))
    }
  },
  {
    name: 'mail',
    help: 'Email conversations (subject, who, when; not the text). args: {"query": optional words, "needs_reply": true to list those waiting on you}',
    working: () => 'Looking through your email…',
    run: (d, a) => {
      const q = words(str(a.query))
      type R = {
        id: string
        subject: string
        snippet: string | null
        name: string | null
        email: string | null
        at: string | null
        unread: number
        lastMe: number
        inbox: number
      }
      const rows = d.db
        .prepare(
          `SELECT id, subject, snippet, sender_name AS name, sender_email AS email, last_message_at AS at,
                  unread, last_sender_is_me AS lastMe, in_inbox AS inbox
             FROM email_threads ORDER BY last_message_at DESC LIMIT 400`
        )
        .all() as unknown as R[]
      const worthy = worthwhileThreadIds(d.db, {}, mailExtra(d.vault(), { meAliases: d.me }))
      let pick = rows.filter(
        (r) =>
          worthy.has(r.id) &&
          isPersonThread({ senderEmail: r.email, senderName: r.name, subject: r.subject })
      )
      if (a.needs_reply === true) pick = pick.filter((r) => r.inbox && !r.lastMe)
      if (q.length)
        pick = pick.filter((r) =>
          q.some((w) =>
            `${r.subject} ${r.name ?? ''} ${r.email ?? ''} ${r.snippet ?? ''}`
              .toLowerCase()
              .includes(w)
          )
        )
      return pick.slice(0, 12).map((r) => ({
        kind: 'mail' as const,
        label: `Email · ${r.at?.slice(0, 10) ?? ''}${r.unread ? ' · unread' : ''}`,
        text: `"${r.subject}" from ${r.name ?? r.email ?? 'someone'}${r.lastMe ? ' (you replied last)' : ''}${r.snippet ? `: ${r.snippet.slice(0, 160)}` : ''} [thread ${r.id}]`,
        ...blank,
        date: (r.at ?? '').slice(0, 10),
        title: r.subject
      }))
    }
  },
  {
    name: 'read_email',
    help: 'Read the text of one email thread (only when allowed). args: {"thread": the thread id shown after "thread" in a mail source}',
    working: () => 'Reading an email…',
    run: async (d, a) => {
      if (!d.readMail() || !d.mailBodies) return []
      const id = str(a.thread, 80)
      const [t] = await d.mailBodies([id])
      if (!t) return []
      const text = t.messages
        .slice(-5)
        .map(
          (m) => `${m.from} (${m.at.slice(0, 10)}): ${m.text.replace(/\s+/g, ' ').slice(0, 900)}`
        )
        .join('\n')
      return [
        { kind: 'mail', label: `Email thread: ${t.subject}`, text, ...blank, title: t.subject }
      ]
    }
  },
  {
    name: 'chat',
    help: 'Google Chat conversations: what is waiting on you, what you are waiting on, what you promised. args: {"query": optional words}',
    working: () => 'Checking your chats…',
    run: (d, a) => {
      const q = words(str(a.query))
      let t: ReturnType<typeof triage>
      try {
        t = triage(d.db, { topicHit: topicMatcher(d.db) })
      } catch {
        return []
      }
      const convs = t.conversations
        .filter((c) => c.bucket !== 'noise')
        .filter(
          (c) => !q.length || q.some((w) => `${c.title} ${c.lastText}`.toLowerCase().includes(w))
        )
        .slice(0, 8)
      const out: ToolSource[] = convs.map((c) => ({
        kind: 'chat' as const,
        label: `Chat · ${c.title} · ${c.bucket}`,
        text: `${c.lastSender}: ${c.lastText.slice(0, 220)}${c.awaitingMeHours ? ` (waiting on you ${Math.round(c.awaitingMeHours)}h)` : c.awaitingThemHours ? ` (you are waiting ${Math.round(c.awaitingThemHours)}h)` : ''}`,
        ...blank,
        date: c.lastAt.slice(0, 10)
      }))
      for (const c of t.commitments.slice(-5))
        out.push({
          kind: 'chat',
          label: `You promised · ${c.spaceName}`,
          text: c.text.slice(0, 200),
          ...blank,
          date: c.at.slice(0, 10)
        })
      return out
    }
  }
]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** Run one tool by name; unknown tools and errors become an empty result plus a reason. */
export async function runTool(
  deps: ToolDeps,
  name: string,
  args: Args
): Promise<{ sources: ToolSource[]; note: string | null; working: string }> {
  const spec = TOOL_BY_NAME.get(name)
  if (!spec) return { sources: [], note: `There is no tool called "${name}".`, working: '' }
  try {
    const found = await spec.run(deps, args)
    return {
      sources: fit(found, deps.chars),
      note: found.length ? null : 'Nothing found.',
      working: spec.working(args)
    }
  } catch (err) {
    return {
      sources: [],
      note: `Could not run ${name}: ${(err as Error).message}`,
      working: spec.working(args)
    }
  }
}
