import type { Db } from '../db'
import type { Vault } from '../vault/vault'
import { openEventNote } from '../calendar/openEvent'
import { getInsight, setStatus, type InsightRow } from './store'
import { addWaiting, ownerIsMe } from '../waiting/waiting'

/** Link text a person can read, pointing back to where an insight came from. */
export const sourceLink = (i: Pick<InsightRow, 'id' | 'sourceLabel'>): string =>
  `[${i.sourceLabel}](nm://src/${i.id})`

const HEADING: Record<string, string> = {
  decision: 'Decisions',
  change: 'Changes',
  risk: 'Risks and blockers',
  question: 'Open questions',
  fact: 'Who is who'
}

const kv = (db: Db, k: string): string | null =>
  (db.prepare('SELECT value FROM kv WHERE key = ?').get(k) as { value: string } | undefined)
    ?.value ?? null
const kvSet = (db: Db, k: string, v: string): void => {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(k, v)
}

/** Put a line under a heading in a note, creating the heading when it is missing. */
export function addUnderHeading(content: string, heading: string, line: string): string {
  const h = `## ${heading}`
  const lines = content.replace(/\s+$/, '').split('\n')
  const at = lines.findIndex((l) => l.trim() === h)
  if (at < 0) return `${lines.join('\n')}\n\n${h}\n${line}\n`
  let end = at + 1
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++
  // Insert after the last non-blank line of the section.
  let ins = end
  while (ins > at + 1 && !lines[ins - 1].trim()) ins--
  lines.splice(ins, 0, line)
  return lines.join('\n') + '\n'
}

export interface AcceptResult {
  kind: 'task' | 'note' | 'waiting'
  path: string
}

/**
 * Accepting turns an insight into something durable: a task (for things to do) or a line in the
 * meeting's note or the month's Insights log (for decisions, risks, questions and facts). Either
 * way it carries a readable link back to the source.
 */
export async function acceptInsight(
  db: Db,
  vault: Vault,
  id: string,
  now: Date,
  edits: { text?: string; owner?: string | null; due?: string | null } = {},
  me: string[] = []
): Promise<AcceptResult> {
  const i = getInsight(db, id)
  if (!i) throw new Error('That item is no longer there.')
  const text = (edits.text ?? i.text).trim()
  const owner = edits.owner === undefined ? i.owner : edits.owner
  const due = edits.due === undefined ? i.due : edits.due
  let res: AcceptResult
  const todo = i.kind === 'action' || i.kind === 'ask' || i.kind === 'promise'
  if (todo && !ownerIsMe(owner, me)) {
    // Only your own work is a task; someone else's action is kept as a Waiting On note line.
    const r = await addWaiting(db, vault, { who: owner!, text, due, link: sourceLink(i) }, now, {
      notePath: i.sourceRef.notePath ?? null,
      eventId: i.sourceRef.eventId ?? null
    })
    res = { kind: 'waiting', path: r.path }
  } else if (todo) {
    const r = await vault.appendInboxTask(
      {
        description: `${text} ${sourceLink(i)}`,
        owner: owner || 'Me',
        due,
        priority: null,
        estMinutes: null,
        ownerExplicit: true
      },
      now
    )
    res = { kind: 'task', path: r.path }
  } else {
    const label = {
      decision: 'Decision',
      change: 'Change',
      risk: 'Risk',
      question: 'Question',
      fact: 'Fact'
    }[i.kind]
    const line = `- **${label}:** ${text}${owner ? ` (${owner})` : ''} ${sourceLink(i)}`
    let path = i.sourceRef.notePath ?? null
    if (!path && i.sourceRef.eventId) path = await openEventNote(db, vault, i.sourceRef.eventId)
    if (!path) {
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      path = kv(db, `insights.log.${ym}`)
      if (!path) {
        path = await vault.createNote({ kind: 'adhoc', title: `Insights ${ym}`, date: `${ym}-01` })
        kvSet(db, `insights.log.${ym}`, path)
      }
    }
    const { content, hash } = await vault.readNote(path)
    await vault.saveNote(path, addUnderHeading(content, HEADING[i.kind] ?? 'Insights', line), hash)
    res = { kind: 'note', path }
  }
  setStatus(db, id, 'accepted')
  return res
}

/** Where to go to see the original: a note to open, or an external page. */
export async function sourceTarget(
  db: Db,
  vault: Vault | null,
  id: string
): Promise<{
  path: string | null
  url: string | null
  thread: { id: string; subject: string } | null
}> {
  const i = getInsight(db, id)
  const none = { path: null, url: null, thread: null }
  if (!i) return none
  const r = i.sourceRef
  if (i.sourceType === 'meeting' || i.sourceType === 'note') {
    if (r.notePath) return { ...none, path: r.notePath }
    if (r.eventId && vault) return { ...none, path: await openEventNote(db, vault, r.eventId) }
    if (r.fileId) return { ...none, url: `https://docs.google.com/document/d/${r.fileId}` }
  }
  if (i.sourceType === 'email' && r.threadId)
    return { ...none, thread: { id: r.threadId, subject: i.sourceLabel.split(' · ')[1] ?? '' } }
  if (i.sourceType === 'chat') return { ...none, url: 'https://chat.google.com/' }
  return none
}
