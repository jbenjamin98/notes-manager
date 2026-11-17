import { app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { reviewQueue } from './entities/review'
import { discoverTags } from './entities/discover'
import {
  createMasterNote,
  linkToSeries,
  listSeries,
  seriesCandidates,
  seriesDetail,
  startNextSession
} from './meetings/series'
import { compileTagVocab } from '../shared/autotag'
import { addWaiting, listWaiting, markReceived } from './waiting/waiting'
import { parseQuickAdd } from '../shared/quickadd'
import { contract, type Output, type Result } from '../shared/contract'
import { type InvokeChannel } from '../shared/channels'
import { health } from './db'
import { openCompose, openThread } from './services/google'
import { cleanMeetUrl, loadDetail } from './calendar/detail'
import { buildDossier, buildRange } from './prep/dossier'
import {
  addMute,
  getThread,
  guessEmail,
  listLabels,
  listMutes,
  overview,
  recordAction,
  removeMute
} from './gmail/sync'
import { sanitizeTaskText, suggestTaskText } from './gmail/parse'
import { listUpcoming } from './calendar/sync'
import { openEventNote } from './calendar/openEvent'
import { type Vault, type TaskItem } from './vault/vault'
import { tasksTiedTo, type Dossier } from './entities/store'
import { getSettings, updateSettings } from './services/settings'
import {
  markNotSame,
  mergeEntries,
  moveEntry,
  setAmbiguous,
  upsertEntry,
  type RegCategory
} from './entities/registry'
import { suggestDuplicates } from './entities/dedupe'
import { searchNotePaths } from './assistant/retrieve'
import { logDir, recentLog } from './services/logger'
import { todayIn, wallClock } from '../shared/tz'
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { release } from 'node:os'
import { isDriveDocUrl } from './google/urls'
import { buildRollup, rollupMarkdown, weekStartOf } from './rollup/rollup'
import { PROVIDERS } from './llm/providers'
import { googleHandlers } from './ipc/google'
import { inboxHandlers } from './ipc/inbox'
import { aiHandlers, llmStatusFor } from './ipc/ai'
import type { Ctx, Handlers } from './ipc/types'

export type { Ctx } from './ipc/types'

function localSuggestions(v: Vault): Output<'entities:suggestions'> {
  const list = v.manageList()
  return suggestDuplicates(
    list.map((e) => ({ category: e.category, name: e.name, aliases: e.aliases, notes: e.notes })),
    v.currentRegistry()
  ).map((d) => ({
    kind: 'merge' as const,
    category: d.category as never,
    names: d.names,
    to: null,
    reason: d.reason,
    score: d.score,
    ambiguous: d.ambiguous
  }))
}

function tasksFor(v: Vault, d: Omit<Dossier, 'tasks'>): TaskItem[] {
  return tasksTiedTo(v.listTasks(), d, new Set(d.notes.map((n) => n.path)))
}

/** Registers every channel in the contract. Inputs AND outputs are zod-validated. */

export function registerIpc(ctx: Ctx): void {
  const vault = (): Vault => {
    const v = ctx.getVault()
    if (!v) throw new Error('Vault not ready')
    return v
  }
  const localDate = (): string => todayIn(getSettings().timezone)
  const llmStatus = (): Output<'llm:status'> => llmStatusFor(ctx)

  /** First line = title, the rest = body. Saved as an ad hoc note dated today. */
  const quickNote = async (text: string): Promise<{ path: string }> => {
    const lines = text.trim().split(/\r?\n/)
    const title =
      lines[0]
        .replace(/^#+\s*/, '')
        .trim()
        .slice(0, 120) || 'Quick note'
    const body = await ctx.tagger.tagOnSubmit(lines.slice(1).join('\n').trim(), { fast: true })
    const v = vault()
    const path = await v.createNote({ kind: 'adhoc', title, date: localDate() })
    if (body) {
      const { content, hash } = await v.readNote(path)
      await v.saveNote(path, content.trimEnd() + '\n\n' + body + '\n', hash)
    }
    return { path }
  }

  const handlers: Handlers = {
    'names:review': () =>
      reviewQueue(
        ctx.db,
        vault().currentRegistry(),
        async (p) => (await vault().readNote(p)).content
      ),
    'names:assign': async ({ paths, short, person, category }) => {
      const v = vault()
      const known =
        (ctx.db
          .prepare(
            "SELECT 1 FROM entities WHERE category IN ('person','customer','project','system','place') AND lower(name) = lower(?)"
          )
          .get(person) as unknown) !== undefined
      // Someone or something new: add it to your lists so the name is recognised everywhere.
      if (!known) await v.upsertRegistryEntry(category ?? 'person', person.trim(), [])
      return v.setMention(paths, short, person.trim())
    },
    'names:unassign': ({ paths, short }) => vault().setMention(paths, short, null),
    'waiting:list': () => listWaiting(ctx.db),
    'waiting:done': async ({ path, line }) => markReceived(vault(), path, line, localDate()),
    'app:info': () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      userDataPath: app.getPath('userData')
    }),
    'settings:get': () => getSettings(),
    'settings:update': async (patch) => {
      const before = getSettings().vaultPath
      const beforeMe = getSettings().meAliases.join('|')
      const next = updateSettings(patch)
      ctx.applyAppSettings() // tray / start-at-login / global hotkey
      if (next.vaultPath !== before) await ctx.switchVault(next.vaultPath)
      // "Me" names decide which tasks are mine and who counts as a person: re-derive everything.
      else if (next.meAliases.join('|') !== beforeMe) await vault().reindexAll()
      return next
    },
    'vault:choose-folder': async () => {
      const win = ctx.getWindow()
      const opts = {
        title: 'Choose notes folder (synced by Google Drive)',
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
    },
    'db:health': () => health(ctx.db, ctx.dbPath),
    'vault:status': () => {
      const v = ctx.getVault()
      if (!v) throw new Error('Vault not ready')
      return v.status()
    },
    'tasks:toggle': async ({ id, done }) => {
      const v = ctx.getVault()
      if (!v) throw new Error('Vault not ready')
      return v.setTaskDone(id, done)
    },
    'tasks:for-note': ({ path }) => vault().tasksForNote(path),
    'tasks:list': () => vault().listTasks(),
    'tasks:quick-add': async ({ text }) => {
      // A task is always mine; an @Name in it says who or what it is about. Only the explicit
      // "waiting on Sarah: send the deck" form files a Waiting On note line instead.
      const w = /^\s*waiting\s+(?:on|for)\s+@?([^:]{1,60}):\s*(.+)$/i.exec(text)
      if (w) {
        const q = parseQuickAdd(w[2], new Date())
        if (!q.description) throw new Error('Type what you are waiting for first.')
        const who = w[1].trim()
        const r = await addWaiting(
          ctx.db,
          vault(),
          { who, text: q.description, due: q.due },
          new Date()
        )
        return {
          kind: 'waiting' as const,
          path: r.path,
          description: q.description,
          owner: who,
          due: q.due
        }
      }
      const q = parseQuickAdd(text, new Date())
      q.description = await ctx.tagger.tagOnSubmit(q.description)
      const { path, task } = await vault().appendInboxTask(q)
      // Report a due date the wording gave too ("... by Tuesday"), not just typed fields.
      const guess = vault().previewInference(task.description)
      return {
        kind: 'task' as const,
        path,
        description: task.description,
        owner: 'Me',
        due: task.due ?? guess.due
      }
    },
    'tasks:set-due': ({ id, due }) => vault().setTaskDue(id, due),
    'entities:list': () => vault().listEntities(),
    'entities:vocabulary': () => vault().vocabulary() as never,
    'tags:vocabulary': () => vault().tagVocabulary(getSettings().autoTag.topics ?? []) as never,
    'tags:discover': () => {
      const s = getSettings()
      return discoverTags(ctx.db, compileTagVocab(vault().tagVocabulary(s.autoTag.topics ?? [])), {
        me: new Set(['me', ...s.meAliases.map((a) => a.toLowerCase())]),
        ignore: new Set(s.autoTag.ignore),
        kinds: s.autoTag.kinds
      })
    },
    'meetings:series': () => listSeries(ctx.db, vault(), localDate()),
    'meetings:series-detail': ({ key }) => seriesDetail(ctx.db, vault(), key, localDate()),
    'meetings:series-next': async ({ key }) => ({
      path: await startNextSession(ctx.db, vault(), key, localDate())
    }),
    'meetings:series-candidates': ({ key }) => seriesCandidates(ctx.db, key),
    'meetings:series-link': async ({ key, path, join }) => ({
      ok: await linkToSeries(ctx.db, vault(), path, key, join)
    }),
    'meetings:series-master': async ({ key }) => ({
      path: await createMasterNote(ctx.db, vault(), key, localDate())
    }),
    'tags:event': ({ events }) => {
      const ins = ctx.db.prepare('INSERT INTO tag_events (word, sigil, action) VALUES (?,?,?)')
      for (const e of events) ins.run(e.word.toLowerCase(), e.sigil, e.action)
      return null
    },
    'tags:health': () => {
      const ignored = new Set(getSettings().autoTag.ignore.map((w) => w.toLowerCase()))
      const rows = ctx.db
        .prepare(
          `SELECT word, sigil,
                  SUM(action = 'tagged') AS tagged, SUM(action = 'accepted') AS accepted,
                  SUM(action = 'rejected') AS rejected
             FROM tag_events GROUP BY word, sigil
            ORDER BY rejected DESC, tagged + accepted DESC LIMIT 200`
        )
        .all() as unknown as {
        word: string
        sigil: string
        tagged: number
        accepted: number
        rejected: number
      }[]
      const sum = (k: 'tagged' | 'accepted' | 'rejected'): number =>
        rows.reduce((n, r) => n + r[k], 0)
      return {
        words: rows.map((r) => ({ ...r, ignored: ignored.has(r.word) })),
        tagged: sum('tagged'),
        accepted: sum('accepted'),
        rejected: sum('rejected')
      }
    },
    'tags:usage': () => ctx.tagger.usage(),
    'tags:suggest': ({ line }) => ctx.tagger.suggest(line),
    'tags:tag-note': async ({ path }) => {
      const v = vault()
      const n = await v.readNote(path)
      const r = ctx.tagger.tagDocument(n.content)
      if (r.count === 0) return { count: 0, before: null }
      await v.saveNote(path, r.text, n.hash)
      return { count: r.count, before: n.content }
    },
    'tags:learn': async ({ names }) => {
      for (const n of names) await vault().upsertRegistryEntry(n.category, n.name, [])
      return null
    },
    'notes:entities': ({ path }) => vault().noteEntities(path) as never,
    'entities:detail': ({ id }) => {
      const d = vault().entityDossier(id)
      if (!d) throw new Error('That item is no longer in your notes.')
      return { ...d, tasks: tasksFor(vault(), d) }
    },
    'entities:upsert': async ({ category, name, aliases, originalName }) => {
      await vault().upsertRegistryEntry(category, name, aliases, originalName)
      return null
    },
    'entities:manage-list': () => vault().manageList() as never,
    'entities:merge': async ({ category, canonical, others }) => {
      await vault().updateRegistry((r) => mergeEntries(r, category, canonical, others))
      return null
    },
    'entities:recategorize': async ({ from, to, name }) => {
      // Remember the correction, so the same word is given this kind next time (before any rule).
      const s = getSettings().autoTag
      updateSettings({ autoTag: { ...s, kinds: { ...(s.kinds ?? {}), [name.toLowerCase()]: to } } })
      await vault().updateRegistry((r) =>
        from === 'topic' || from === 'event'
          ? upsertEntry(r, to, name, [])
          : moveEntry(r, from as RegCategory, to, name)
      )
      return null
    },
    'entities:not-same': async ({ a, b }) => {
      await vault().updateRegistry((r) => markNotSame(r, a, b))
      return null
    },
    'entities:ambiguous': async ({ name, on }) => {
      await vault().updateRegistry((r) => setAmbiguous(r, name, on))
      return null
    },
    'entities:suggestions': () => localSuggestions(vault()),
    'entities:ai-suggest': () => ctx.assistant.suggestEntities(),
    'entities:remove': async ({ category, name }) => {
      await vault().removeRegistryEntry(category, name)
      return null
    },
    'notes:list': () => vault().listNotes(),
    'notes:search': ({ query }) => searchNotePaths(ctx.db, query),
    'app:diagnostics': () => {
      const st = getSettings()
      const v = ctx.getVault()
      const cal = ctx.calendar.getStatus()
      const mail = ctx.gmail.getStatus()
      const llm = llmStatus()
      return [
        `Note Manager ${app.getVersion()} (Electron ${process.versions.electron}, Node ${process.versions.node})`,
        `Windows ${release()} ${process.arch}`,
        `Data folder: ${app.getPath('userData')}`,
        `Notes folder: ${v?.root ?? '(not ready)'}`,
        v ? `Notes: ${v.status().notes}, open tasks: ${v.status().tasksOpen}` : '',
        `Time zone: ${st.timezone}; work hours ${st.workHours.start}-${st.workHours.end}`,
        `Calendar: ${cal.state}, last sync ${cal.lastSyncAt ?? 'never'}${cal.error ? ', error: ' + cal.error : ''}`,
        `Mail: ${mail.state}, ${mail.threads} threads, health ${mail.health}${mail.healthDetail ? ' (' + mail.healthDetail + ')' : ''}`,
        `AI: ${llm.enabled ? 'on' : 'off'}; ${llm.providers.map((p) => `${p.id}=${p.state}(${p.usage.today} today)`).join(', ')}`,
        `Nudges: ${st.nudges.enabled ? 'on' : 'off'}, toasts ${st.nudges.toasts ? 'on' : 'off'}; tray ${st.runInBackground}; login ${st.startAtLogin}`,
        '',
        'Recent log (no note or email content is ever logged):',
        recentLog(40)
      ]
        .filter((l) => l !== '')
        .join('\n')
    },
    'app:open-logs': () => {
      const d = logDir()
      if (d) void shell.openPath(d)
      return null
    },
    'app:backup': async () => {
      const win = ctx.getWindow()
      const opts = {
        title: 'Where should the backup go?',
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (res.canceled || !res.filePaths[0]) return null
      const root = vault().root
      const zip = join(res.filePaths[0], `notes-backup-${localDate()}.zip`)
      // Windows 10+ ships tar.exe, which can write .zip files: no extra software needed.
      await new Promise<void>((ok, fail) =>
        execFile('tar', ['-a', '-c', '-f', zip, '-C', dirname(root), basename(root)], (e) =>
          e ? fail(new Error('Could not create the backup: ' + e.message)) : ok()
        )
      )
      return { path: zip }
    },
    'mail:clear': () => {
      ctx.db.exec(
        "DELETE FROM email_threads; DELETE FROM email_actions; DELETE FROM gmail_labels; DELETE FROM chat_messages; DELETE FROM kv WHERE key LIKE 'gmail.%' OR key LIKE 'chat.%'"
      )
      ctx.gmail.touch()
      return null
    },
    'notes:entity-map': () => vault().entityMap() as never,
    'notes:read': ({ path }) => vault().readNote(path),
    'notes:save': ({ path, content, baseHash }) => vault().saveNote(path, content, baseHash),
    'notes:force-save': ({ path, content }) => vault().forceSaveNote(path, content),
    'notes:create': async ({ kind, title, date, account }) => ({
      path: await vault().createNote({ kind, title, date, account })
    }),
    'notes:quick-note': ({ text }) => quickNote(text),
    'capture:handoff': async ({ text }) => {
      // Too long for the small box: save it, then carry on in the app with the note open.
      const r = await quickNote(text)
      ctx.capture.hide()
      const w = ctx.getWindow()
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
        w.webContents.send('app:open-note', r)
      }
      return r
    },
    'capture:resize': ({ height }) => {
      ctx.capture.resize(height)
      return null
    },
    'notes:set-title': async ({ path, title }) => ({ path: await vault().setTitle(path, title) }),
    'calendar:status': () => ctx.calendar.getStatus(),
    'calendar:sync': () => ctx.calendar.sync(),
    'calendar:upcoming': () => listUpcoming(ctx.db, localDate()),
    'calendar:open-event': async ({ id }) => ({ path: await openEventNote(ctx.db, vault(), id) }),
    'prep:get': async ({ eventId, refresh, cacheOnly }) => {
      const cached = loadDetail(ctx.db, eventId)
      const selfEmail =
        (
          ctx.db.prepare("SELECT value FROM kv WHERE key = 'gmail.selfEmail'").get() as
            { value: string } | undefined
        )?.value ?? null
      let detail: 'ok' | 'needs-auth' | 'failed' = cached?.fetched ? 'ok' : 'failed'
      if (cached && !cacheOnly && (refresh || !cached.fetched)) {
        try {
          if (ctx.google.active()) {
            const st = await ctx.calendar.sync()
            detail =
              st.state === 'needs-auth'
                ? 'needs-auth'
                : st.state === 'error' && !cached.fetched
                  ? 'failed'
                  : 'ok'
          } else {
            // Guests arrive with every calendar sync (both sources); nothing to fetch per event.
            const st = await ctx.calendar.sync()
            detail =
              st.state === 'needs-auth'
                ? 'needs-auth'
                : cached.fetched || st.state !== 'error'
                  ? 'ok'
                  : 'failed'
          }
        } catch {
          detail = cached.fetched ? 'ok' : 'failed'
        }
      }
      const v = vault()
      const dossier = buildDossier(ctx.db, eventId, {
        tasks: v.listTasks(),
        selfEmail,
        guessAccount: (t) => v.guessAccount(t)
      })
      if (!dossier)
        throw new Error('That meeting is no longer on your calendar. Refresh and try again.')
      // Documents attached to the invite (agenda, deck, Gemini notes): one click to the original.
      const attachments = (
        ctx.db
          .prepare('SELECT file_id AS fileId, title FROM event_attachments WHERE event_id = ?')
          .all(eventId) as { fileId: string; title: string }[]
      ).map((a) => ({
        ...a,
        url: `https://docs.google.com/document/d/${a.fileId}`
      }))
      return { dossier: { ...dossier, attachments }, detail } as never
    },
    'calendar:range': ({ from, to }) => buildRange(ctx.db, from, to, vault().listTasks()),
    'app:open-external': ({ url }) => {
      // Only the providers' key pages (for API-key setup), Google Cloud Console, and genuine Meet rooms may leave the app.
      if (
        url === 'https://console.cloud.google.com/apis/credentials' ||
        Object.values(PROVIDERS).some((p) => p.keyUrl === url)
      ) {
        void shell.openExternal(url)
        return null
      }
      // Documents from Google Drive (attachments, Meet notes) may be opened.
      if (isDriveDocUrl(url)) {
        void shell.openExternal(url)
        return null
      }
      const safe = cleanMeetUrl(url)
      if (!safe) throw new Error('That link cannot be opened from here.')
      void shell.openExternal(safe)
      return null
    },
    'nudges:list': () => ctx.engine.list(),
    'nudges:unread': () => ctx.engine.unread(),
    'nudges:read': (arg) => {
      ctx.engine.markRead(arg?.id)
      return null
    },
    'nudges:dismiss': ({ id }) => {
      ctx.engine.dismiss(id)
      return null
    },
    'nudges:snooze': ({ id, minutes }) => {
      ctx.engine.snooze(id, minutes ?? 60)
      return null
    },
    'nudges:test': async () => {
      ctx.notifyReset()
      ctx.engine.test()
      await new Promise((r) => setTimeout(r, 600)) // Windows reports 'shown' / 'failed' a moment later
      return ctx.notifyStatus()
    },
    'gmail:status': () => ctx.gmail.getStatus(),
    'gmail:sync': (arg) => ctx.gmail.sync(arg?.full ?? false),
    'gmail:mutes': () => listMutes(ctx.db),
    'gmail:mute': ({ target }) => {
      const p = addMute(ctx.db, target)
      if (!p) throw new Error('Enter an email address or a domain like example.com.')
      ctx.gmail.touch()
      return p
    },
    'gmail:unmute': ({ pattern }) => {
      removeMute(ctx.db, pattern)
      ctx.gmail.touch()
      return null
    },
    'gmail:overview': () => overview(ctx.db, getSettings().gmailLabels),
    'gmail:labels': () => listLabels(ctx.db, getSettings().gmailLabels),
    'gmail:set-label': ({ name, handler }) => {
      updateSettings({ gmailLabels: { ...getSettings().gmailLabels, [name]: handler } })
      ctx.gmail.touch()
      return null
    },
    'gmail:dismiss': ({ id }) => {
      recordAction(ctx.db, id, 'dismissed')
      ctx.gmail.touch()
      return null
    },
    'gmail:add-task': async ({ id, text }) => {
      const t = getThread(ctx.db, id)
      if (!t) throw new Error('That email is no longer in your synced mail. Refresh and try again.')
      const description = sanitizeTaskText(text?.trim() || suggestTaskText({ subject: t.subject }))
      await vault().appendInboxTask({
        description,
        owner: 'Me',
        ownerExplicit: true, // an email task is mine; don't let the subject's wording reassign it
        due: null,
        priority: null,
        estMinutes: null
      })
      recordAction(ctx.db, id, 'task_added')
      ctx.gmail.touch()
      return { description }
    },
    'gmail:open-thread': ({ id }) => {
      const t = getThread(ctx.db, id)
      if (!t) throw new Error('That email is no longer in your synced mail.')
      openThread(t.linkId, t.subject)
      return null
    },
    'gmail:compose': ({ to, subject, body }) => {
      openCompose({ to, subject, body })
      return null
    },
    'gmail:guess-email': ({ name }) => guessEmail(ctx.db, name),
    'capture:hide': () => {
      ctx.capture.hide()
      return null
    },
    'capture:status': () => ctx.capture.status(),
    'rollup:get': (arg) => {
      const r = buildRollup(
        ctx.db,
        vault().listTasks(),
        arg?.weekStart ?? weekStartOf(wallClock(new Date(), getSettings().timezone)),
        localDate()
      )
      return { ...r, markdown: rollupMarkdown(r) }
    },
    'rollup:save-note': async ({ weekStart }) => {
      const r = buildRollup(ctx.db, vault().listTasks(), weekStart, localDate())
      const path = await vault().createNote({
        kind: 'adhoc',
        title: `Weekly review ${weekStart}`,
        date: localDate(),
        body: rollupMarkdown(r)
      })
      return { path }
    },
    'app:set-theme': ({ mode }) => {
      nativeTheme.themeSource = mode
      return null
    },
    ...googleHandlers(ctx),
    ...inboxHandlers(ctx),
    ...aiHandlers(ctx)
  }

  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    ipcMain.handle(channel, async (event, raw): Promise<Result<unknown>> => {
      try {
        // Only the app's own pages may call the main process (never a remote page that got loaded).
        const from = event.senderFrame?.url ?? ''
        const dev = process.env['ELECTRON_RENDERER_URL']
        if (!from.startsWith('file://') && !(dev && from.startsWith(dev)))
          throw new Error('Request refused: unexpected sender.')
        const schema = contract[channel]
        const input = schema.input.parse(raw)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = await (handlers[channel] as (i: any) => unknown)(input)
        return { ok: true, data: schema.output.parse(out) }
      } catch (err) {
        return { ok: false, error: { code: 'IPC_ERROR', message: (err as Error).message } }
      }
    })
  }
}
