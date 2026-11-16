import { promises as fs, existsSync } from 'node:fs'
import { ambiguousNames } from '../entities/review'
import { TOPIC_STOP } from '../../shared/autotag'
import { join, relative, sep } from 'node:path'
import type { Db } from '../db'
import {
  appendLine,
  ensureIdentity,
  setFrontmatterMention,
  setFrontmatterTitle,
  setTaskChecked,
  setTaskDue
} from './edit'
import { atomicWrite, patchFile, readText, TMP_SUFFIX } from './fsio'
import { sha256, ulid } from './ids'
import { indexNote, noteIdPath, removeFromIndex, taskOwnerElsewhere } from './indexer'
import { notePath, renderTemplate, type NewNote } from './templates'
import {
  buildMatcher,
  emptyRegistry,
  listOf,
  parseRegistry,
  REG_CATEGORIES,
  REGISTRY_REL,
  removeEntry,
  serializeRegistry,
  upsertEntry,
  type Matcher,
  type PoolSeed,
  type RegCategory,
  type Registry
} from '../entities/registry'
import { buildPersonIndex, inferDue, inferOwner, type PersonIndex } from '../entities/infer'
import {
  analyze,
  entityDossier,
  listEntities,
  syncRegistryRows,
  type Dossier,
  type EntitySummary,
  type Insights
} from '../entities/store'
import { senderNames } from '../gmail/sync'
import { formatTaskLine, parseQuickAdd, type QuickTask } from '../../shared/quickadd'

export interface NoteSummary {
  id: string
  path: string
  title: string
  type: 'meeting' | 'adhoc' | 'inbox'
  date: string
  account: string | null
  openTasks: number
  isConflict: boolean
}

export interface TaskRow {
  id: string
  description: string
  owner: string
  isMine: boolean
  due: string | null
  priority: 'High' | 'Medium' | 'Low' | null
  estMinutes: number | null
  status: 'open' | 'completed'
  autoOwner: boolean
  autoDue: boolean
  /** The insight this task came from (to reopen the source), and how to name it. */
  sourceId: string | null
  sourceLabel: string | null
}

export interface TaskItem {
  id: string
  description: string
  owner: string
  isMine: boolean
  due: string | null
  priority: 'High' | 'Medium' | 'Low' | null
  estMinutes: number | null
  status: 'open' | 'completed'
  autoOwner: boolean
  autoDue: boolean
  /** The insight this task came from (to reopen the source), and how to name it. */
  sourceId: string | null
  sourceLabel: string | null
  /** When we started waiting: the earlier of the note date and first-seen date. */
  since: string
  completedAt: string | null
  notePath: string
  noteTitle: string
  account: string | null
}

export type FileOutcome = 'indexed' | 'unchanged' | 'removed' | 'skipped'

export interface VaultStatus {
  root: string
  notes: number
  tasksOpen: number
  tasksDone: number
}

const SCAN_DIRS = ['notes', 'inbox']
const WATCH_DIRS = [...SCAN_DIRS, 'system']
const SUBDIRS = ['notes', 'inbox', 'attachments', 'system']
/** Drive conflict copies look like "name (1).md" or "name - Conflict ... .md". */
export const CONFLICT_RE = /\(\d+\)\.md$|conflict/i

/** "sarah" -> "Sarah" (first-name terms are stored lowercase in the index). */
const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join('/')

export class Vault {
  private watcher: { close(): Promise<void> } | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  /** In-flight per-path chains so one file is never processed concurrently. */
  private chains = new Map<string, Promise<unknown>>()
  private registry: Registry = emptyRegistry()
  private registryVersion = 0
  private lastRegistryHash = ''
  private matcherCache: { key: string; matcher: Matcher; people: PersonIndex } | null = null

  constructor(
    private db: Db,
    public root: string,
    private meAliases: () => string[],
    private onChanged: (paths: string[]) => void = () => undefined
  ) {}

  abs(rel: string): string {
    return join(this.root, ...rel.split('/'))
  }

  async init(): Promise<void> {
    for (const d of SUBDIRS) await fs.mkdir(join(this.root, d), { recursive: true })
    await this.loadRegistry()
    await this.reconcile()
    await this.startWatching()
  }

  async close(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    await this.watcher?.close()
    this.watcher = null
  }

  /** Serialize work per path. */
  private serial<T>(rel: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(rel) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    this.chains.set(rel, next)
    void next
      .finally(() => {
        if (this.chains.get(rel) === next) this.chains.delete(rel)
      })
      .catch(() => undefined)
    return next
  }

  /**
   * Bring one file and its index entry up to date. Idempotent and keyed on
   * content hash: our own writes (and the watcher echo they cause) hash the
   * same as file_state, so they are no-ops — no echo loop is possible.
   */
  processFile(rel: string): Promise<FileOutcome> {
    return this.serial(rel, () => this.processFileInner(rel))
  }

  private async processFileInner(rel: string): Promise<FileOutcome> {
    if (!rel.toLowerCase().endsWith('.md') || rel.endsWith(TMP_SUFFIX)) return 'skipped'
    const abs = this.abs(rel)
    let content: string
    try {
      content = await readText(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        removeFromIndex(this.db, rel)
        return 'removed'
      }
      throw err
    }
    const known = this.db.prepare('SELECT hash FROM file_state WHERE path = ?').get(rel) as
      { hash: string } | undefined
    if (known?.hash === sha256(content)) return 'unchanged'

    // Normalise identity (note id + unique task ids). Written back at most once.
    const fix = this.identityFix(rel, content)
    if (fix(content) !== content) content = (await patchFile(abs, fix)).content
    const st = await fs.stat(abs)
    indexNote(this.db, {
      relPath: rel,
      content,
      mtimeMs: st.mtimeMs,
      size: st.size,
      meAliases: this.meAliases(),
      matcher: this.matcher(),
      people: this.tagging().people
    })
    this.onChanged([rel])
    return 'indexed'
  }

  // ------------------------------------------------------------- entities

  /**
   * Matcher + person index, rebuilt when the registry or "me" names change and at most every
   * 30 s otherwise (new email senders / discovered people join the pool without a restart).
   */
  private tagging(): { matcher: Matcher; people: PersonIndex } {
    const key = `${this.meAliases().join('|')}#${this.registryVersion}#${Math.floor(Date.now() / 30_000)}`
    if (this.matcherCache?.key !== key) {
      const me = new Set([
        'me',
        ...this.meAliases().map((a) => a.toLowerCase()),
        ...this.registry.me.aliases.map((a) => a.toLowerCase())
      ])
      const reg = this.registry
      const regPeople = new Set(reg.people.map((p) => p.name.toLowerCase()))
      const dbRows = this.db
        .prepare(
          "SELECT name, category FROM entities WHERE in_registry = 0 AND category IN ('person','customer','system','project','place')"
        )
        .all() as unknown as { name: string; category: RegCategory }[]
      const people = new Map<string, { name: string; aliases?: string[] }>()
      for (const p of reg.people)
        people.set(p.name.toLowerCase(), { name: p.name, aliases: p.aliases })
      for (const r of dbRows)
        if (r.category === 'person' && !people.has(r.name.toLowerCase()))
          people.set(r.name.toLowerCase(), { name: r.name })
      for (const n of senderNames(this.db))
        if (!people.has(n.toLowerCase())) people.set(n.toLowerCase(), { name: n })
      const personIndex = buildPersonIndex([...people.values()], me)

      const seeds: PoolSeed[] = []
      for (const [name, canon] of personIndex.lookup) {
        // Registry names/aliases are already matched case-insensitively; pool adds the rest.
        const isRegistryPerson = regPeople.has(canon.toLowerCase())
        if (isRegistryPerson && !personIndex.firstNames.has(name)) continue
        seeds.push({
          category: 'person',
          name: canon,
          terms: [name === canon.toLowerCase() ? canon : title(name)],
          inRegistry: isRegistryPerson
        })
      }
      for (const r of dbRows) {
        if (r.category !== 'person')
          seeds.push({ category: r.category, name: r.name, terms: [r.name], inRegistry: false })
      }
      this.matcherCache = {
        key,
        matcher: buildMatcher(reg, this.meAliases(), seeds, this.sharedNames(reg)),
        people: personIndex
      }
    }
    return this.matcherCache
  }

  private matcher(): Matcher {
    return this.tagging().matcher
  }

  /** What the indexer would infer for plain task text (for quick-add feedback). */
  previewInference(
    description: string,
    ref: Date = new Date()
  ): { owner: string | null; due: string | null } {
    return {
      owner: inferOwner(description, this.tagging().people),
      due: inferDue(description, ref)
    }
  }

  getRegistry(): Registry {
    return this.registry
  }

  private async loadRegistry(): Promise<void> {
    try {
      const text = await readText(this.abs(REGISTRY_REL))
      this.lastRegistryHash = sha256(text)
      this.registry = parseRegistry(text)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.registry = emptyRegistry()
    }
    this.registryVersion++
    syncRegistryRows(this.db, this.registry)
  }

  /** Someone (Drive, a text editor) changed the registry file: reload and re-extract everywhere. */
  private async onRegistryFileChanged(): Promise<void> {
    let text = ''
    try {
      text = await readText(this.abs(REGISTRY_REL))
    } catch {
      /* deleted: fall through to an empty registry */
    }
    if (text && sha256(text) === this.lastRegistryHash) return // our own write echoing back
    await this.loadRegistry()
    await this.reindexAll()
  }

  /** Re-extract entities/tasks ownership for every note (registry or "me" names changed). */
  async reindexAll(): Promise<void> {
    this.db.exec('DELETE FROM file_state')
    await this.reconcile()
    this.onChanged([])
  }

  private async saveRegistry(next: Registry): Promise<void> {
    const text = serializeRegistry(next)
    this.lastRegistryHash = sha256(text)
    await atomicWrite(this.abs(REGISTRY_REL), text)
    this.registry = parseRegistry(text)
    this.registryVersion++
    syncRegistryRows(this.db, this.registry)
    await this.reindexAll()
  }

  upsertRegistryEntry(
    category: RegCategory,
    name: string,
    aliases: string[],
    originalName?: string
  ): Promise<void> {
    return this.saveRegistry(upsertEntry(this.registry, category, name, aliases, originalName))
  }

  /** Change the curated registry (merge, recategorise, mark different...) and re-scan every note. */
  updateRegistry(fn: (reg: Registry) => Registry): Promise<void> {
    return this.saveRegistry(fn(this.registry))
  }

  /** Everything the Manage screen shows: counts plus nicknames and the "ambiguous" flag. */
  manageList(): (EntitySummary & { aliases: string[]; ambiguous: boolean })[] {
    const reg = this.registry
    const amb = new Set(reg.ambiguous.map((a) => a.toLowerCase()))
    return this.listEntities().map((e) => {
      const entry = (REG_CATEGORIES as string[]).includes(e.category)
        ? listOf(reg, e.category as RegCategory).find(
            (x) => x.name.toLowerCase() === e.name.toLowerCase()
          )
        : undefined
      return { ...e, aliases: entry?.aliases ?? [], ambiguous: amb.has(e.name.toLowerCase()) }
    })
  }

  /** Read-only copy of the registry (for suggestions). */
  currentRegistry(): Registry {
    return this.registry
  }

  removeRegistryEntry(category: RegCategory, name: string): Promise<void> {
    return this.saveRegistry(removeEntry(this.registry, category, name))
  }

  /** Entities detected in one note (for the "Tagged" chips). */
  noteEntities(rel: string): { id: string; name: string; category: string; mentions: number }[] {
    this.assertInVault(rel)
    return this.db
      .prepare(
        `SELECT e.id, e.name, e.category, ne.mention_count AS mentions
           FROM note_entities ne JOIN notes n ON n.id = ne.note_id JOIN entities e ON e.id = ne.entity_id
          WHERE n.file_path = ? ORDER BY ne.mention_count DESC, e.name COLLATE NOCASE`
      )
      .all(rel) as unknown as { id: string; name: string; category: string; mentions: number }[]
  }

  /**
   * Every name the editor should recognise as it is typed: curated registry entries (matched
   * case-insensitively) plus the pool of discovered people, senders and first names (exact case).
   */
  vocabulary(): { id: string; name: string; category: string; terms: string[]; exact: boolean }[] {
    const { matcher } = this.tagging()
    const out: { id: string; name: string; category: string; terms: string[]; exact: boolean }[] =
      []
    for (const c of REG_CATEGORIES) {
      for (const e of listOf(this.registry, c)) {
        out.push({
          id: `${c}:${e.name.toLowerCase()}`,
          name: e.name,
          category: c,
          terms: [e.name, ...e.aliases],
          exact: false
        })
      }
    }
    const grouped = new Map<
      string,
      { id: string; name: string; category: string; terms: string[]; exact: boolean }
    >()
    for (const term of matcher.pool?.terms ?? []) {
      const e = matcher.pool!.byTerm.get(term.toLowerCase())
      if (!e) continue
      const key = `${e.category}:${e.name.toLowerCase()}`
      const g = grouped.get(key) ?? {
        id: key,
        name: e.name,
        category: e.category,
        terms: [],
        exact: true
      }
      g.terms.push(term)
      grouped.set(key, g)
    }
    return [...out, ...grouped.values()].slice(0, 3000)
  }

  /**
   * Short names shared by several people ("Jacob") that nobody has claimed: an explicit alias or
   * full name in your lists always wins, so only unclaimed shared names are treated as ambiguous.
   */
  private sharedNames(reg: Registry): string[] {
    const claimed = new Set<string>()
    for (const c of REG_CATEGORIES)
      for (const e of listOf(reg, c))
        for (const t of [e.name, ...e.aliases]) claimed.add(t.toLowerCase())
    return [...ambiguousNames(this.db, reg).keys()].filter((n) => !claimed.has(n.toLowerCase()))
  }

  /** Changes whenever your lists change (so a name you just added is tagged at once). */
  registryRevision(): number {
    return this.registryVersion
  }

  /**
   * What can be auto-tagging: your lists and discovered people, plus every topic you have used.
   * A name shared by two people ("Jacob") or marked ambiguous is included but flagged for review:
   * it is tagged, and waits in Review Names until you say which one. Left out: your own names and
   * everyday words.
   */
  tagVocabulary(): {
    id: string
    name: string
    category: string
    terms: string[]
    exact: boolean
    review?: boolean
  }[] {
    const { matcher } = this.tagging()
    const ambiguous = new Set(this.registry.ambiguous.map((a) => a.toLowerCase()))
    const isMe = (t: string): boolean => matcher.me.has(t.toLowerCase())
    const blocked = (t: string): boolean => isMe(t) || ambiguous.has(t.toLowerCase())
    const out: ReturnType<Vault['tagVocabulary']> = this.vocabulary()
      .map((e) => ({ ...e, terms: e.terms.filter((t) => !blocked(t)) }))
      .filter((e) => e.terms.length > 0)
    const cands = ambiguousNames(this.db, this.registry)
    const shared = new Set<string>(this.sharedNames(this.registry))
    for (const a of this.registry.ambiguous) shared.add(a)
    for (const name of shared) {
      if (isMe(name) || name.trim().length < 2) continue
      // Its kind is the most used one among the things it could be (a person when nobody is known).
      const c = [...(cands.get(name) ?? [])].sort((a, b) => b.notes - a.notes)[0]
      out.push({
        id: `review:${name.toLowerCase()}`,
        name,
        category: c?.category ?? 'person',
        terms: [name],
        exact: false,
        review: true
      })
    }
    const topics = this.db
      .prepare(
        `SELECT e.name AS name, count(ne.note_id) AS n FROM entities e
           JOIN note_entities ne ON ne.entity_id = e.id
          WHERE e.category = 'topic' GROUP BY e.id HAVING n >= 1 ORDER BY n DESC LIMIT 800`
      )
      .all() as unknown as { name: string }[]
    for (const t of topics) {
      const name = t.name.trim()
      if (!name || TOPIC_STOP.has(name.toLowerCase()) || blocked(name)) continue
      out.push({
        id: `topic:${name.toLowerCase()}`,
        name,
        category: 'topic',
        terms: [name],
        exact: false
      })
    }
    return out
  }

  /** The customer/account a meeting title refers to, by registry names/aliases and known accounts. */
  guessAccount(title: string): string | null {
    const names: string[] = []
    for (const a of this.registry.accounts) names.push(a.name, ...a.aliases)
    const rows = this.db
      .prepare("SELECT name FROM entities WHERE category = 'customer'")
      .all() as unknown as { name: string }[]
    for (const r of rows) names.push(r.name)
    const canon = new Map<string, string>()
    for (const a of this.registry.accounts)
      for (const t of [a.name, ...a.aliases]) canon.set(t.toLowerCase(), a.name)
    let best: string | null = null
    for (const n of names) {
      if (!n.trim()) continue
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`,
        'iu'
      )
      if (re.test(title) && (best === null || n.length > best.length)) best = n
    }
    return best ? (canon.get(best.toLowerCase()) ?? best) : null
  }

  listEntities(): EntitySummary[] {
    return listEntities(this.db)
  }

  entityDossier(id: string): Dossier | null {
    return entityDossier(this.db, id, this.registry)
  }

  insights(days: number | null): Insights {
    return analyze(this.db, days)
  }

  /** Builds the identity-normalising edit for a file (note id + unique task ids). */
  private identityFix(rel: string, content: string): (cur: string) => string {
    const noteIdNow = /^id:\s*["']?([0-9A-Z]{26})/m.exec(content)?.[1] ?? ''
    const holder = noteIdNow ? noteIdPath(this.db, noteIdNow) : null
    const copied = !!holder && holder !== rel && existsSync(this.abs(holder))
    // For a copied file every inherited task id counts as taken, so it gets fresh ones.
    const owner = copied ? '' : noteIdNow || ''
    return (cur) =>
      ensureIdentity(cur, (id) => taskOwnerElsewhere(this.db, id, owner), {
        forceNewNoteId: copied
      }).content
  }

  /** Full scan: index new/changed files, drop rows for files that vanished. */
  async reconcile(): Promise<{ indexed: number; removed: number }> {
    const present = new Set<string>()
    for (const d of SCAN_DIRS) await this.walk(join(this.root, d), present)
    let indexed = 0
    // Conflict copies go LAST: they share the original's ids, and whichever file is
    // indexed first keeps them. (Alphabetically "x (1).md" sorts before "x.md".)
    const ordered = [...present].sort(
      (a, b) => Number(CONFLICT_RE.test(a)) - Number(CONFLICT_RE.test(b)) || a.localeCompare(b)
    )
    for (const rel of ordered) {
      if ((await this.processFile(rel)) === 'indexed') indexed++
    }
    let removed = 0
    const rows = this.db.prepare('SELECT path FROM file_state').all() as { path: string }[]
    for (const { path } of rows) {
      if (!present.has(path)) {
        removeFromIndex(this.db, path)
        removed++
      }
    }
    return { indexed, removed }
  }

  private async walk(dir: string, out: Set<string>): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.endsWith(TMP_SUFFIX)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) await this.walk(p, out)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.add(toRel(this.root, p))
    }
  }

  async startWatching(): Promise<void> {
    const chokidar = await import('chokidar')
    const w = chokidar.watch(
      WATCH_DIRS.map((d) => join(this.root, d)),
      {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        ignored: (p: string) => p.endsWith(TMP_SUFFIX) || /[\\/]\./.test(relative(this.root, p))
      }
    )
    const schedule = (abs: string): void => {
      const rel = toRel(this.root, abs)
      clearTimeout(this.timers.get(rel))
      this.timers.set(
        rel,
        setTimeout(() => {
          this.timers.delete(rel)
          if (rel === REGISTRY_REL) {
            this.onRegistryFileChanged().catch((e) =>
              console.error('[vault] registry reload failed', e)
            )
            return
          }
          this.processFile(rel).catch((e) => console.error('[vault] process failed', rel, e))
        }, 300)
      )
    }
    w.on('add', schedule).on('change', schedule).on('unlink', schedule)
    w.on('error', (e) => console.error('[vault] watcher error', e))
    this.watcher = w
  }

  /** Checkbox write-back from the Master Task View / Co-Pilot. One-line patch by ^id. */
  async setTaskDone(taskId: string, done: boolean): Promise<boolean> {
    const row = this.db
      .prepare(
        'SELECT n.file_path AS p FROM tasks t JOIN notes n ON n.id = t.note_id WHERE t.id = ?'
      )
      .get(taskId) as { p: string } | undefined
    if (!row) return false
    const rel = row.p
    await this.serial(rel, async () => {
      await patchFile(this.abs(rel), (c) => setTaskChecked(c, taskId, done))
    })
    await this.processFile(rel) // reindex now; the watcher echo will be a no-op
    return true
  }

  /** Create a file only if absent (never overwrites). Returns false when it already exists. */
  async createFile(rel: string, content: string): Promise<boolean> {
    const abs = this.abs(rel)
    if (existsSync(abs)) return false
    await atomicWrite(abs, content)
    await this.processFile(rel)
    return true
  }

  listNotes(): NoteSummary[] {
    const rows = this.db
      .prepare(
        `SELECT n.id, n.file_path AS path, n.title, n.type, n.date, n.account,
                (SELECT count(*) FROM tasks t WHERE t.note_id = n.id AND t.status = 'open') AS openTasks
           FROM notes n ORDER BY n.date DESC, n.updated_at DESC, n.title`
      )
      .all() as unknown as Omit<NoteSummary, 'isConflict'>[]
    return rows.map((r) => ({ ...r, isConflict: CONFLICT_RE.test(r.path) }))
  }

  async readNote(rel: string): Promise<{ content: string; hash: string }> {
    this.assertInVault(rel)
    const content = await readText(this.abs(rel))
    return { content, hash: sha256(content) }
  }

  /**
   * Save from the editor with optimistic concurrency: if the file changed on
   * disk since `baseHash` (e.g. Drive delivered a newer copy), nothing is
   * written and the current disk content is returned for the UI to resolve.
   */
  saveNote(
    rel: string,
    content: string,
    baseHash: string
  ): Promise<{ ok: boolean; content: string; hash: string }> {
    this.assertInVault(rel)
    return this.serial(rel, async () => {
      const cur = await readText(this.abs(rel))
      if (sha256(cur) !== baseHash) return { ok: false, content: cur, hash: sha256(cur) }
      const next = this.identityFix(rel, content)(content)
      if (next !== cur) await atomicWrite(this.abs(rel), next)
      await this.processFileInner(rel)
      return { ok: true, content: next, hash: sha256(next) }
    })
  }

  /** Overwrite after the user explicitly chose "keep mine" on a conflict. */
  async forceSaveNote(
    rel: string,
    content: string
  ): Promise<{ ok: boolean; content: string; hash: string }> {
    this.assertInVault(rel)
    const cur = await readText(this.abs(rel))
    return this.saveNote(rel, content, sha256(cur))
  }

  /** Which people / accounts / systems / topics each note mentions (for the "by subject" views). */
  entityMap(): { path: string; entities: { id: string; name: string; category: string }[] }[] {
    const rows = this.db
      .prepare(
        `SELECT n.file_path AS path, e.id, e.name, e.category
           FROM note_entities ne JOIN notes n ON n.id = ne.note_id JOIN entities e ON e.id = ne.entity_id
          WHERE n.type <> 'inbox' ORDER BY n.file_path, ne.mention_count DESC, e.name`
      )
      .all() as unknown as { path: string; id: string; name: string; category: string }[]
    const out = new Map<string, { id: string; name: string; category: string }[]>()
    for (const r of rows) {
      if (CONFLICT_RE.test(r.path)) continue
      const list = out.get(r.path) ?? []
      list.push({ id: r.id, name: r.name, category: r.category })
      out.set(r.path, list)
    }
    return [...out].map(([path, entities]) => ({ path, entities }))
  }

  /** Known people (for mapping names the AI returns to the spellings used in notes). */
  personIndex(): PersonIndex {
    return this.tagging().people
  }

  /** Accounts/customers used by existing notes. */
  knownAccounts(): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT account FROM notes WHERE account IS NOT NULL AND account <> '' ORDER BY account"
        )
        .all() as { account: string }[]
    ).map((r) => r.account)
  }

  async createNote(n: NewNote): Promise<string> {
    let i = 1
    let rel = notePath(n.date, n.title, i)
    while (existsSync(this.abs(rel))) rel = notePath(n.date, n.title, ++i)
    await this.createFile(rel, renderTemplate(n))
    return rel
  }

  /**
   * Rename a note: updates the frontmatter title and, only while the file still has the
   * placeholder "untitled" slug, renames the file to match. The note id never changes, so
   * tasks and links survive. Returns the (possibly new) vault-relative path.
   */
  /** Say who a short name ("Jacob") means in these notes; null forgets it (undo). */
  async setMention(rels: string[], short: string, full: string | null): Promise<number> {
    let n = 0
    for (const rel of rels) {
      this.assertInVault(rel)
      await this.serial(rel, () =>
        patchFile(this.abs(rel), (c) => setFrontmatterMention(c, short, full))
      )
      await this.processFile(rel)
      n++
    }
    this.onChanged(rels)
    return n
  }

  async setTitle(rel: string, rawTitle: string): Promise<string> {
    this.assertInVault(rel)
    const title = rawTitle.trim().slice(0, 120)
    if (!title) return rel
    await this.serial(rel, () => patchFile(this.abs(rel), (c) => setFrontmatterTitle(c, title)))
    await this.processFile(rel)

    const base = rel.split('/').pop() ?? ''
    if (!/^\d{4}-\d{2}-\d{2}-untitled(-\d+)?\.md$/.test(base)) return rel
    const date = base.slice(0, 10)
    let n = 1
    let next = notePath(date, title, n)
    while (existsSync(this.abs(next))) next = notePath(date, title, ++n)
    await fs.rename(this.abs(rel), this.abs(next))
    await this.processFile(next) // moves the index row (same note id)
    await this.processFile(rel) // old path is gone: drops its file_state
    return next
  }

  /**
   * Every open task plus tasks completed in the last 30 days, with their source note.
   * Tasks that live only in Drive conflict copies are left out (they'd appear twice).
   */
  listTasks(): TaskItem[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.description, t.owner, t.is_mine AS isMine, t.due_date AS due, t.priority,
                t.est_minutes AS estMinutes, t.status, t.completed_at AS completedAt,
                t.auto_owner AS autoOwner, t.auto_due AS autoDue,
                t.source_id AS sourceId, t.source_label AS sourceLabel,
                CASE WHEN n.type = 'inbox' THEN date(t.assigned_at, 'localtime')
                     ELSE MIN(n.date, date(t.assigned_at, 'localtime')) END AS since,
                n.file_path AS notePath, n.title AS noteTitle, n.account
           FROM tasks t JOIN notes n ON n.id = t.note_id
          WHERE t.status = 'open' OR t.completed_at >= date('now', '-30 days')
          ORDER BY t.due_date IS NULL, t.due_date, t.rowid`
      )
      .all() as unknown as (Omit<TaskItem, 'isMine' | 'autoOwner' | 'autoDue'> & {
      isMine: number
      autoOwner: number
      autoDue: number
    })[]
    return rows
      .filter((r) => !CONFLICT_RE.test(r.notePath))
      .map((r) => ({ ...r, isMine: !!r.isMine, autoOwner: !!r.autoOwner, autoDue: !!r.autoDue }))
  }

  /** Change (or clear) one task's due date, straight in its source file. */
  async setTaskDue(taskId: string, due: string | null): Promise<boolean> {
    const row = this.db
      .prepare(
        'SELECT n.file_path AS p FROM tasks t JOIN notes n ON n.id = t.note_id WHERE t.id = ?'
      )
      .get(taskId) as { p: string } | undefined
    if (!row) return false
    await this.serial(row.p, async () => {
      await patchFile(this.abs(row.p), (c) => setTaskDue(c, taskId, due))
    })
    await this.processFile(row.p)
    return true
  }

  /**
   * Quick-add: append a task to this month's rolling inbox file (created on first use).
   * Parsed deterministically; the user sees the same parse as a preview while typing.
   */
  async addInboxTask(
    text: string,
    now: Date = new Date()
  ): Promise<{ path: string; task: QuickTask }> {
    return this.appendInboxTask(parseQuickAdd(text, now), now)
  }

  /** Append an already-structured task (no natural-language parsing) to this month's inbox. */
  async appendInboxTask(
    task: QuickTask,
    now: Date = new Date()
  ): Promise<{ path: string; task: QuickTask }> {
    if (!task.description) throw new Error('Type a task first.')
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const rel = `inbox/${ym}.md`
    if (!existsSync(this.abs(rel))) {
      const head = [
        '---',
        `id: "${ulid()}"`,
        `title: "Inbox ${ym}"`,
        'type: "inbox"',
        `date: "${ym}-01"`,
        '---',
        '',
        ''
      ].join('\n')
      // A concurrent first-use loses the race harmlessly: createFile never overwrites.
      await this.createFile(rel, head)
    }
    await this.serial(rel, async () => {
      await patchFile(this.abs(rel), (c) => appendLine(c, formatTaskLine(task)))
    })
    await this.processFile(rel)
    return { path: rel, task }
  }

  tasksForNote(rel: string): TaskRow[] {
    this.assertInVault(rel)
    const rows = this.db
      .prepare(
        `SELECT t.id, t.description, t.owner, t.is_mine AS isMine, t.due_date AS due, t.priority,
                t.est_minutes AS estMinutes, t.status, t.auto_owner AS autoOwner, t.auto_due AS autoDue,
                t.source_id AS sourceId, t.source_label AS sourceLabel
           FROM tasks t JOIN notes n ON n.id = t.note_id WHERE n.file_path = ?
          ORDER BY t.rowid`
      )
      .all(rel) as unknown as (Omit<TaskRow, 'isMine' | 'autoOwner' | 'autoDue'> & {
      isMine: number
      autoOwner: number
      autoDue: number
    })[]
    return rows.map((r) => ({
      ...r,
      isMine: !!r.isMine,
      autoOwner: !!r.autoOwner,
      autoDue: !!r.autoDue
    }))
  }

  /** Reject path traversal; only vault-relative .md files under notes/ or inbox/. */
  private assertInVault(rel: string): void {
    if (!/^(notes|inbox)\//.test(rel) || rel.includes('..') || !rel.toLowerCase().endsWith('.md')) {
      throw new Error('Invalid note path')
    }
  }

  status(): VaultStatus {
    const n = (this.db.prepare('SELECT count(*) AS c FROM notes').get() as { c: number }).c
    const t = this.db.prepare('SELECT status, count(*) AS c FROM tasks GROUP BY status').all() as {
      status: string
      c: number
    }[]
    return {
      root: this.root,
      notes: n,
      tasksOpen: t.find((r) => r.status === 'open')?.c ?? 0,
      tasksDone: t.find((r) => r.status === 'completed')?.c ?? 0
    }
  }
}
