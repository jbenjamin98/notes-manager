import { seriesKey } from './series'

/** Pure grouping for the "All notes" page. No UI, no I/O. */
export type LibraryView = 'newest' | 'weeks' | 'meetings' | 'subjects' | 'people' | 'tasks'

export const LIBRARY_VIEWS: { id: LibraryView; label: string; hint: string }[] = [
  { id: 'newest', label: 'Newest', hint: 'Everything, newest to oldest' },
  { id: 'weeks', label: 'Weeks', hint: 'One section per week' },
  { id: 'meetings', label: 'Meetings', hint: 'Recurring meetings grouped together' },
  { id: 'subjects', label: 'Accounts', hint: 'By customer or project' },
  { id: 'people', label: 'People', hint: 'By who or what is mentioned' },
  { id: 'tasks', label: 'Open tasks', hint: 'Notes that still need action' }
]

export interface LibNote {
  path: string
  title: string
  date: string
  type: 'meeting' | 'adhoc' | 'inbox'
  account: string | null
  openTasks: number
  isConflict: boolean
  entities: { id: string; name: string; category: string }[]
}

export interface LibGroup {
  key: string
  label: string
  sub: string
  notes: LibNote[]
}

export interface LibOptions {
  query?: string
  /** 'all' | 'meeting' | 'adhoc' */
  type?: string
  /** For the people view: 'all' or one category. */
  category?: string
  now?: Date
  /** Paths of notes whose body text matched the query (found by full-text search). */
  extraPaths?: Set<string>
}

const p2 = (n: number): string => String(n).padStart(2, '0')
const isoDay = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const parse = (iso: string): Date => new Date(`${iso}T12:00:00`)
const addDays = (iso: string, n: number): string => {
  const d = parse(iso)
  d.setDate(d.getDate() + n)
  return isoDay(d)
}
export const weekStartOf = (iso: string): string => addDays(iso, -((parse(iso).getDay() + 6) % 7))

const md = (iso: string): string =>
  parse(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const newestFirst = (a: LibNote, b: LibNote): number =>
  b.date.localeCompare(a.date) || a.title.localeCompare(b.title)

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

function bucket(date: string, today: string): string {
  if (date >= today) return 'Today'
  if (date === addDays(today, -1)) return 'Yesterday'
  if (date >= addDays(today, -7)) return 'Previous 7 days'
  if (date >= addDays(today, -30)) return 'Previous 30 days'
  return parse(date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function filter(notes: LibNote[], o: LibOptions): LibNote[] {
  const q = (o.query ?? '').trim().toLowerCase()
  return notes.filter((n) => {
    if (n.type === 'inbox') return false // the inbox holds loose tasks; they live on the Tasks page
    if (o.type && o.type !== 'all' && n.type !== o.type) return false
    if (!q) return true
    if (o.extraPaths?.has(n.path)) return true
    return (
      n.title.toLowerCase().includes(q) ||
      (n.account ?? '').toLowerCase().includes(q) ||
      n.entities.some((e) => e.name.toLowerCase().includes(q))
    )
  })
}

function collect(
  items: LibNote[],
  keyOf: (n: LibNote) => { key: string; label: string } | null
): Map<string, { label: string; notes: LibNote[] }> {
  const m = new Map<string, { label: string; notes: LibNote[] }>()
  for (const n of items) {
    const k = keyOf(n)
    if (!k) continue
    const g = m.get(k.key) ?? { label: k.label, notes: [] }
    g.notes.push(n)
    m.set(k.key, g)
  }
  return m
}

export function groupNotes(view: LibraryView, all: LibNote[], o: LibOptions = {}): LibGroup[] {
  const today = isoDay(o.now ?? new Date())
  const items = filter(all, o).sort(newestFirst)
  const mk = (key: string, label: string, notes: LibNote[], sub?: string): LibGroup => ({
    key,
    label,
    notes,
    sub: sub ?? plural(notes.length, 'note')
  })

  if (view === 'newest') {
    const g = collect(items, (n) => {
      const b = bucket(n.date, today)
      return { key: b, label: b }
    })
    return [...g].map(([k, v]) => mk(k, v.label, v.notes))
  }

  if (view === 'weeks') {
    const thisWeek = weekStartOf(today)
    const g = collect(items, (n) => {
      const ws = weekStartOf(n.date)
      const end = addDays(ws, 6)
      const label =
        ws === thisWeek
          ? 'This week'
          : ws === addDays(thisWeek, -7)
            ? 'Last week'
            : `${md(ws)} – ${md(end)}`
      return { key: ws, label }
    })
    return [...g]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([k, v]) =>
        mk(
          k,
          v.label,
          v.notes,
          `${md(k)} – ${md(addDays(k, 6))} · ${plural(v.notes.length, 'note')}`
        )
      )
  }

  if (view === 'meetings') {
    const meetings = items.filter((n) => n.type === 'meeting')
    const g = collect(meetings, (n) => {
      const k = seriesKey(n.title)
      return { key: k || n.title.toLowerCase(), label: n.title }
    })
    const series: LibGroup[] = []
    const oneOff: LibNote[] = []
    for (const [k, v] of g) {
      if (v.notes.length > 1)
        series.push(
          mk(
            k,
            v.notes[0].title,
            v.notes,
            `${plural(v.notes.length, 'meeting')} · last ${md(v.notes[0].date)}`
          )
        )
      else oneOff.push(v.notes[0])
    }
    series.sort((a, b) => b.notes[0].date.localeCompare(a.notes[0].date))
    if (oneOff.length)
      series.push(
        mk(
          '__oneoff',
          'One-off meetings',
          oneOff.sort(newestFirst),
          plural(oneOff.length, 'meeting')
        )
      )
    return series
  }

  if (view === 'subjects') {
    const g = collect(items, (n) =>
      n.account
        ? { key: n.account.toLowerCase(), label: n.account }
        : { key: '', label: 'No account' }
    )
    return [...g]
      .map(([k, v]) => mk(k, v.label, v.notes))
      .sort((a, b) =>
        a.key === '' ? 1 : b.key === '' ? -1 : b.notes[0].date.localeCompare(a.notes[0].date)
      )
  }

  if (view === 'people') {
    const cat = o.category && o.category !== 'all' ? o.category : null
    const m = new Map<string, { label: string; category: string; notes: LibNote[] }>()
    for (const n of items)
      for (const e of n.entities) {
        if (cat && e.category !== cat) continue
        const g = m.get(e.id) ?? { label: e.name, category: e.category, notes: [] }
        g.notes.push(n)
        m.set(e.id, g)
      }
    return [...m]
      .sort((a, b) => b[1].notes.length - a[1].notes.length || a[1].label.localeCompare(b[1].label))
      .map(([k, v]) => mk(k, v.label, v.notes, `${v.category} · ${plural(v.notes.length, 'note')}`))
  }

  // tasks
  const open = items
    .filter((n) => n.openTasks > 0)
    .sort((a, b) => b.openTasks - a.openTasks || newestFirst(a, b))
  return open.length
    ? [
        mk(
          'open',
          'Needs action',
          open,
          `${plural(
            open.reduce((s, n) => s + n.openTasks, 0),
            'open task'
          )} in ${plural(open.length, 'note')}`
        )
      ]
    : []
}
