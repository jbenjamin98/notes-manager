import { ulid } from './ids'

export type NoteKind = 'meeting' | 'adhoc'

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Safe, readable filename slug: lowercase ascii, hyphens, Windows-reserved names avoided. */
export function slugify(title: string): string {
  let s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  if (!s) s = 'untitled'
  if (RESERVED.test(s)) s += '-note'
  return s
}

export function notePath(date: string, title: string, n = 1): string {
  const year = date.slice(0, 4)
  const suffix = n > 1 ? `-${n}` : ''
  return `notes/${year}/${date}-${slugify(title)}${suffix}.md`
}

const q = (s: string): string => JSON.stringify(s)

export interface NewNote {
  kind: NoteKind
  title: string
  date: string
  account?: string
  attendees?: string[]
  calendarEventId?: string
  /** e.g. "09:00-10:00" for notes created from a calendar event. */
  time?: string
  /** Ready-made body (e.g. from the Co-Pilot). Replaces the template sections. */
  body?: string
}

/** Template text. Task lines use the inline syntax; ids are added by the indexer on first save. */
export function renderTemplate(n: NewNote): string {
  const fm = [
    '---',
    `id: ${q(ulid())}`,
    `title: ${q(n.title)}`,
    `type: ${q(n.kind)}`,
    `date: ${q(n.date)}`
  ]
  if (n.account) fm.push(`account: ${q(n.account)}`)
  if (n.attendees?.length) fm.push(`attendees: [${n.attendees.map(q).join(', ')}]`)
  if (n.time) fm.push(`time: ${q(n.time)}`)
  if (n.calendarEventId) fm.push(`calendar_event_id: ${q(n.calendarEventId)}`)
  fm.push('---', '')
  if (n.body !== undefined) return fm.join('\n') + '\n' + n.body.trim() + '\n'
  if (n.kind === 'adhoc') {
    // Title lives in frontmatter and the header; the body starts empty.
    return fm.join('\n') + '\n'
  }
  return (
    fm.join('\n') +
    [
      '',
      '## Context & Objective',
      '',
      '',
      '## Key Decisions & Insights',
      '- ',
      '',
      '## Open Questions / Parking Lot',
      '- ',
      '',
      '## Action Items',
      '- [ ] ',
      ''
    ].join('\n')
  )
}
