import { parse as parseYaml } from 'yaml'

export type Priority = 'High' | 'Medium' | 'Low'

export interface ParsedTask {
  /** Inline `^id` marker, or null if not yet assigned. */
  id: string | null
  /** 0-based line index in the file. */
  line: number
  checked: boolean
  description: string
  owner: string
  due: string | null
  priority: Priority | null
  estMinutes: number | null
  /** An `| @owner` / `| due:` field was typed (so nothing is inferred for it). */
  ownerExplicit: boolean
  dueExplicit: boolean
}

export interface Chunk {
  heading: string | null
  text: string
}

export interface Frontmatter {
  data: Record<string, unknown>
  /** Index of the closing `---` line. */
  endLine: number
}

export interface ParsedNote {
  frontmatter: Frontmatter | null
  body: string
  title: string | null
  tasks: ParsedTask[]
  chunks: Chunk[]
  llmBlocked: boolean
}

/** Lines with their original EOLs kept, so edits never change line endings. */
export function splitLines(content: string): string[] {
  return (
    content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((l, i, a) => l !== '' || i < a.length - 1) ??
    []
  )
}

const stripEol = (l: string): string => l.replace(/\r?\n$|\r$/, '')

export function parseFrontmatter(lines: string[]): Frontmatter | null {
  if (!lines.length || stripEol(lines[0]).trim() !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    if (stripEol(lines[i]).trim() === '---') {
      try {
        const data = parseYaml(lines.slice(1, i).join('')) as unknown
        return {
          data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
          endLine: i
        }
      } catch {
        return null
      }
    }
  }
  return null
}

const TASK_RE = /^(\s*)- \[( |x|X)\] (.*)$/
const ID_RE = /\s\^([A-Za-z0-9]{4,12})\s*$/

export function parseEstimate(v: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/i.exec(v.trim())
  if (!m || (!m[1] && !m[2])) return null
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)
}

function normPriority(v: string): Priority | null {
  const s = v.trim().toLowerCase()
  return s === 'high'
    ? 'High'
    : s === 'medium' || s === 'med'
      ? 'Medium'
      : s === 'low'
        ? 'Low'
        : null
}

export function parseTaskLine(line: string, index: number): ParsedTask | null {
  const m = TASK_RE.exec(stripEol(line))
  if (!m) return null
  let rest = m[3]
  let id: string | null = null
  const idm = ID_RE.exec(' ' + rest)
  if (idm) {
    id = idm[1]
    rest = (' ' + rest).replace(ID_RE, '').trim()
  }
  const [desc, ...fields] = rest.split(/\s+\|\s+/)
  const t: ParsedTask = {
    id,
    line: index,
    checked: m[2].toLowerCase() === 'x',
    description: desc.trim(),
    owner: 'Me',
    due: null,
    priority: null,
    estMinutes: null,
    ownerExplicit: false,
    dueExplicit: false
  }
  for (const f of fields) {
    const s = f.trim()
    if (s.startsWith('@')) {
      t.owner = s.slice(1).trim() || 'Me'
      t.ownerExplicit = true
    } else if (/^due:/i.test(s)) {
      t.dueExplicit = true
      t.due = /^\d{4}-\d{2}-\d{2}$/.test(s.slice(4).trim()) ? s.slice(4).trim() : null
    } else if (/^priority:/i.test(s)) t.priority = normPriority(s.slice(9))
    else if (/^est:/i.test(s)) t.estMinutes = parseEstimate(s.slice(4))
  }
  return t.description ? t : null
}

export function parseNote(content: string): ParsedNote {
  const lines = splitLines(content)
  const fm = parseFrontmatter(lines)
  const start = fm ? fm.endLine + 1 : 0
  const tasks: ParsedTask[] = []
  const chunks: Chunk[] = []
  let heading: string | null = null
  let buf: string[] = []
  let title: string | null = null
  const flush = (): void => {
    const text = buf.join('\n').trim()
    if (text) chunks.push({ heading, text })
    buf = []
  }
  for (let i = start; i < lines.length; i++) {
    const raw = stripEol(lines[i])
    const h = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (h) {
      flush()
      heading = h[2].trim()
      if (!title && h[1].length === 1) title = heading
      continue
    }
    const t = parseTaskLine(lines[i], i)
    if (t) tasks.push(t)
    buf.push(raw)
  }
  flush()

  const body = lines.slice(start).join('')
  const d = fm?.data ?? {}
  const tags = Array.isArray(d.tags) ? d.tags.map(String) : []
  const llmBlocked =
    /^cui/i.test(String(d.classification ?? '')) ||
    String(d.llm ?? '').toLowerCase() === 'off' ||
    tags.some((t) => /^#?cui$/i.test(t)) ||
    /(^|\s)#cui\b/i.test(body)
  return { frontmatter: fm, body, title, tasks, chunks, llmBlocked }
}
