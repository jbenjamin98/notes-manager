import type { Db } from '../db'
import { loadDetail } from '../calendar/detail'
import { listWaiting } from '../waiting/waiting'
import { isPersonThread } from '../gmail/relevance'
import { worthwhileThreadIds } from '../gmail/sync'
import { mailExtra } from '../gmail/extra'
import { listInsights } from '../insights/store'
import type { Vault } from '../vault/vault'
import { buildDossier } from '../prep/dossier'
import { buildRollup, rollupMarkdown, weekStartOf, addDays } from '../rollup/rollup'
import { tasksTiedTo } from '../entities/store'
import { eventsForDay } from '../calendar/sync'
import { todayIn, wallClock } from '../../shared/tz'
import type { ActionSources } from './assistant'

const FRONTMATTER = /^---[\s\S]*?\n---\s*/
const md = (iso: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/**
 * Builds the plain-text context for each one-click AI action from the user's own data. Only titles,
 * dates, names, task wording and short snippets go in; nothing here calls the network.
 */
export function makeSources(deps: {
  db: Db
  vault: () => Vault
  zone: () => string | undefined
}): ActionSources {
  const { db } = deps
  const today = (): string => todayIn(deps.zone())

  return {
    async note(path) {
      const row = db.prepare('SELECT title, date FROM notes WHERE file_path = ?').get(path) as
        { title: string; date: string } | undefined
      if (!row) return null
      try {
        // readNote validates the path: inside the vault, under notes/ or inbox/ only.
        const { content } = await deps.vault().readNote(path)
        return {
          title: row.title,
          date: row.date,
          body: content.replace(FRONTMATTER, '').trim()
        }
      } catch {
        return null
      }
    },
    prep(eventId) {
      const v = deps.vault()
      const selfEmail =
        (
          db.prepare("SELECT value FROM kv WHERE key = 'gmail.selfEmail'").get() as
            { value: string } | undefined
        )?.value ?? null
      const d = buildDossier(db, eventId, {
        tasks: v.listTasks(),
        selfEmail,
        guessAccount: (t) => v.guessAccount(t)
      })
      if (!d) return null
      const L: string[] = [
        `Meeting: ${d.event.title}`,
        `When: ${d.event.date}${d.event.startTime ? ' ' + d.event.startTime : ''}`
      ]
      if (d.account) L.push(`Account: ${d.account}`)
      if (d.attendees.length)
        L.push(
          'Attendees: ' +
            d.attendees
              .map(
                (a) =>
                  `${a.name}${a.theyOwe ? ` (owes ${a.theyOwe})` : ''}${a.lastNoteDate ? `, last in notes ${a.lastNoteDate}` : ''}`
              )
              .join('; ')
        )
      if (d.series.previous.length)
        L.push(
          'Previous meetings in this series:\n' +
            d.series.previous
              .map((p) => `- ${p.date} ${p.title} (${p.openTasks} open tasks)`)
              .join('\n')
        )
      if (d.series.questions.length)
        L.push(
          'Open questions from last time:\n' + d.series.questions.map((q) => `- ${q}`).join('\n')
        )
      const open = [...d.series.openTasks, ...d.attendeeTasks, ...d.accountTasks]
      const seen = new Set<string>()
      const lines = open
        .filter((t) => !seen.has(t.id) && seen.add(t.id))
        .slice(0, 20)
        .map((t) => `- ${t.description} (${t.owner}${t.due ? ', due ' + t.due : ''})`)
      if (lines.length) L.push('Open tasks:\n' + lines.join('\n'))
      // Recent Google Chat from the people in this meeting (only present with the API connection).
      const first = d.attendees
        .map((x) => x.name.split(/\s+/)[0].toLowerCase())
        .filter((n) => n.length >= 3)
      if (first.length) {
        const chat = (
          db
            .prepare(
              "SELECT sender, text, space_name AS sp FROM chat_messages WHERE created_at > datetime('now','-7 days') ORDER BY created_at DESC LIMIT 60"
            )
            .all() as { sender: string; text: string; sp: string }[]
        )
          .filter((m) => first.some((n) => m.sender.toLowerCase().startsWith(n)))
          .slice(0, 5)
        if (chat.length)
          L.push(
            'Recent Google Chat with these people:\n' +
              chat.map((m) => `- ${m.sender} in ${m.sp}: ${m.text.slice(0, 160)}`).join('\n')
          )
      }
      if (d.emails.length)
        L.push(
          'Recent emails with these people:\n' +
            d.emails
              .slice(0, 5)
              .map((e) => `- ${e.subject}`)
              .join('\n')
        )
      if (d.attendees.length) {
        const names = [...new Set(d.attendees.map((a) => a.name.toLowerCase()))]
        const chats = db
          .prepare(
            `SELECT sender, space_name AS spaceName, text FROM chat_messages
              WHERE lower(sender) IN (${names.map(() => '?').join(',')})
              ORDER BY created_at DESC LIMIT 5`
          )
          .all(...names) as { sender: string; spaceName: string; text: string }[]
        if (chats.length)
          L.push(
            'Recent Google Chat messages:\n' +
              chats.map((c) => `- ${c.sender} (${c.spaceName}): ${c.text}`).join('\n')
          )
      }
      return { title: d.event.title, text: L.join('\n\n') }
    },
    week(weekStart) {
      const ws = weekStart ?? weekStartOf(wallClock(new Date(), deps.zone()))
      const r = buildRollup(db, deps.vault().listTasks(), ws, today())
      return {
        label: `${md(ws)} – ${md(addDays(ws, 6))}`,
        weekStart: ws,
        markdown: rollupMarkdown(r)
      }
    },
    day() {
      const t = today()
      const v = deps.vault()
      const mine = v
        .listTasks()
        .filter((x) => x.isMine && x.status === 'open' && x.due && x.due <= t)
      const events = eventsForDay(db, t).map((e) => ({ ...e, startTime: e.start, endTime: e.end }))
      const L = [`Today is ${t}.`]
      L.push(
        mine.length
          ? 'Tasks due or overdue:\n' +
              mine
                .map(
                  (x) =>
                    `- ${x.description}${x.priority ? ' [' + x.priority + ']' : ''}${x.due! < t ? ' (overdue since ' + x.due + ')' : ''}${x.estMinutes ? ' ~' + x.estMinutes + 'm' : ''}`
                )
                .join('\n')
          : 'No tasks are due today.'
      )
      L.push(
        events.length
          ? 'Meetings today:\n' +
              events
                .map(
                  (e) =>
                    `- ${e.startTime ?? 'all day'}${e.endTime ? '-' + e.endTime : ''} ${e.title}`
                )
                .join('\n')
          : 'No meetings today.'
      )
      // The rest of the picture: who is in the meetings, what people owe me, replies I owe,
      // and what came out of meetings, mail and chat.
      const guestLines = events
        .map((e) => {
          const g = (loadDetail(db, e.id)?.detail.guests ?? [])
            .slice(0, 6)
            .map((x) => x.name ?? x.email.split('@')[0])
          return g.length ? `- ${e.title}: ${g.join(', ')}` : ''
        })
        .filter(Boolean)
      if (guestLines.length) L.push('Who is in the meetings:\n' + guestLines.join('\n'))
      const soon = v
        .listTasks()
        .filter(
          (x) => x.isMine && x.status === 'open' && x.due && x.due > t && x.due <= addDays(t, 3)
        )
      if (soon.length)
        L.push(
          'Due in the next three days:\n' +
            soon
              .slice(0, 8)
              .map((x) => `- ${x.description} (due ${x.due})`)
              .join('\n')
        )
      const owed = listWaiting(db).slice(0, 8)
      if (owed.length)
        L.push(
          'Waiting on other people:\n' +
            owed
              .map(
                (w) => `- ${w.who}: ${w.text}${w.due ? ` (due ${w.due})` : ''}, since ${w.since}`
              )
              .join('\n')
        )
      const worthy = worthwhileThreadIds(db, {}, mailExtra(v, { meAliases: [] }))
      const replies = (
        db
          .prepare(
            `SELECT id, subject, sender_name AS n, sender_email AS e, last_message_at AS at FROM email_threads
              WHERE in_inbox = 1 AND last_sender_is_me = 0 ORDER BY last_message_at DESC LIMIT 40`
          )
          .all() as {
          id: string
          subject: string
          n: string | null
          e: string | null
          at: string | null
        }[]
      )
        .filter((r) => isPersonThread({ senderEmail: r.e, senderName: r.n, subject: r.subject }))
        .filter((r) => worthy.has(r.id))
        .slice(0, 6)
      if (replies.length)
        L.push(
          'Email that may need a reply:\n' +
            replies
              .map((r) => `- "${r.subject}" from ${r.n ?? r.e} (${(r.at ?? '').slice(0, 10)})`)
              .join('\n')
        )
      const ins = listInsights(db, 'new', 40).slice(0, 8)
      if (ins.length)
        L.push(
          'New from meetings, mail and chat:\n' +
            ins
              .map(
                (i) => `- ${i.kind}: ${i.text}${i.owner ? ` (${i.owner})` : ''} [${i.sourceLabel}]`
              )
              .join('\n')
        )
      return { text: L.join('\n\n') }
    },
    entity(id) {
      const v = deps.vault()
      const d = v.entityDossier(id)
      if (!d) return null
      const paths = d.notes.map((n) => n.path)
      const tasks = tasksTiedTo(v.listTasks(), d, new Set(paths)).filter((t) => t.status === 'open')
      const L = [`${d.name} (${d.category})`]
      L.push(
        'Notes, newest first:\n' +
          d.notes
            .slice(0, 12)
            .map((n) => `- ${n.date} ${n.title}: ${n.snippet.replace(/\s+/g, ' ').slice(0, 260)}`)
            .join('\n')
      )
      if (tasks.length)
        L.push(
          'Open tasks:\n' +
            tasks
              .slice(0, 15)
              .map((t) => `- ${t.description} (${t.owner}${t.due ? ', due ' + t.due : ''})`)
              .join('\n')
        )
      const chats = db
        .prepare(
          `SELECT sender, space_name AS spaceName, text FROM chat_messages
            WHERE lower(sender) = lower(?) OR lower(space_name) LIKE '%' || lower(?) || '%'
            ORDER BY created_at DESC LIMIT 5`
        )
        .all(d.name, d.name) as { sender: string; spaceName: string; text: string }[]
      if (chats.length)
        L.push(
          'Recent Google Chat messages:\n' +
            chats.map((c) => `- ${c.sender} (${c.spaceName}): ${c.text}`).join('\n')
        )
      return { name: d.name, text: L.join('\n\n') }
    }
  }
}
