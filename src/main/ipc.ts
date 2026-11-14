import { app, dialog, ipcMain, nativeTheme, shell, BrowserWindow } from 'electron'
import { contract, type Output, type Result } from '../shared/contract'
import type { InvokeChannel } from '../shared/channels'
import type { Db } from './db'
import { health } from './db'
import { openLogin, openCompose, openThread, scrapeEventDetail } from './services/google'
import { cleanMeetUrl, loadDetail, normalizeGuests, saveDetail } from './calendar/detail'
import { buildDossier, buildRange } from './prep/dossier'
import {
  addMute,
  getThread,
  guessEmail,
  listLabels,
  listMutes,
  overview,
  recordAction,
  removeMute,
  type GmailSync
} from './gmail/sync'
import type { NudgeEngine } from './nudges/engine'
import { sanitizeTaskText, suggestTaskText } from './gmail/parse'
import { listUpcoming, localDate, type CalendarSync } from './calendar/sync'
import { openEventNote } from './calendar/openEvent'
import type { Vault, TaskItem } from './vault/vault'
import { tasksTiedTo } from './entities/store'
import type { Dossier } from './entities/store'
import { getSettings, updateSettings } from './services/settings'
import { z } from 'zod'
import type { Assistant } from './assistant/assistant'
import type { LlmRouter } from './llm/router'
import type { SecretStore } from './services/secrets'
import { orderedProviders } from './llm/config'
import type { CaptureWindow } from './capture'
import { buildRollup, rollupMarkdown, weekStartOf } from './rollup/rollup'
import { PROVIDERS, type ProviderId } from './llm/providers'

export interface Ctx {
  db: Db
  dbPath: string
  getWindow: () => BrowserWindow | null
  getVault: () => Vault | null
  calendar: CalendarSync
  gmail: GmailSync
  engine: NudgeEngine
  assistant: Assistant
  llm: LlmRouter
  secrets: SecretStore
  capture: CaptureWindow
  /** Tray + start-at-login follow the settings. */
  applyAppSettings: () => void
  switchVault: (root: string) => Promise<void>
}

type Handlers = {
  [C in InvokeChannel]: (
    input: import('zod').output<(typeof contract)[C]['input']>
  ) =>
    | Promise<import('zod').output<(typeof contract)[C]['output']>>
    | import('zod').output<(typeof contract)[C]['output']>
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
  const llmStatus = (): Output<'llm:status'> => {
    const st = ctx.llm.status()
    const custom = getSettings().llm.models
    return {
      enabled: getSettings().llm.enabled,
      canStoreKeys: ctx.secrets.canStore(),
      providers: st.providers.map((p) => {
        const m = PROVIDERS[p.id]
        const over = custom[p.id] ?? {}
        return {
          ...p,
          label: m.label,
          blurb: m.blurb,
          keyUrl: m.keyUrl,
          paid: m.paid,
          models: { extract: over.extract || m.models.extract, chat: over.chat || m.models.chat },
          modelsCustom: !!(over.extract || over.chat)
        }
      })
    }
  }
  const handlers: Handlers = {
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
      const { path, task } = await vault().addInboxTask(text)
      // Report what the wording told us too ("Remind Sarah to ... by Tuesday"), not just typed fields.
      const guess = vault().previewInference(task.description)
      return {
        path,
        description: task.description,
        owner: task.ownerExplicit || task.owner !== 'Me' ? task.owner : (guess.owner ?? 'Me'),
        due: task.due ?? guess.due
      }
    },
    'tasks:set-due': ({ id, due }) => vault().setTaskDue(id, due),
    'entities:list': () => vault().listEntities(),
    'entities:vocabulary': () => vault().vocabulary() as never,
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
    'entities:remove': async ({ category, name }) => {
      await vault().removeRegistryEntry(category, name)
      return null
    },
    'insights:analyze': ({ days }) => vault().insights(days),
    'notes:list': () => vault().listNotes(),
    'notes:entity-map': () => vault().entityMap() as never,
    'notes:read': ({ path }) => vault().readNote(path),
    'notes:save': ({ path, content, baseHash }) => vault().saveNote(path, content, baseHash),
    'notes:force-save': ({ path, content }) => vault().forceSaveNote(path, content),
    'notes:create': async ({ kind, title, date, account }) => ({
      path: await vault().createNote({ kind, title, date, account })
    }),
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
          const r = await scrapeEventDetail(eventId)
          if (!r.signedIn) detail = 'needs-auth'
          else {
            saveDetail(ctx.db, eventId, {
              guests: normalizeGuests(r.guests, selfEmail),
              meetUrl: r.meetUrl
            })
            detail = 'ok'
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
      return { dossier, detail } as never
    },
    'calendar:range': ({ from, to }) => buildRange(ctx.db, from, to, vault().listTasks()),
    'app:open-external': ({ url }) => {
      // Only the providers' key pages (for API-key setup) and genuine Meet rooms may leave the app.
      if (Object.values(PROVIDERS).some((p) => p.keyUrl === url)) {
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
    'nudges:test': () => {
      ctx.engine.test()
      return null
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
    'assistant:send': ({ text, mode }) => ctx.assistant.send(text, mode ?? 'auto'),
    'assistant:history': () => ctx.assistant.history(),
    'assistant:apply': ({ messageId, index, edits }) =>
      ctx.assistant.apply(messageId, index, edits),
    'assistant:dismiss': ({ messageId, index }) => ctx.assistant.dismiss(messageId, index),
    'assistant:clear': () => {
      ctx.assistant.clear()
      return null
    },
    'llm:status': () => llmStatus(),
    'llm:set-key': ({ provider, key }) => {
      const k = key.trim()
      if (!k) ctx.secrets.delete('llm.' + provider)
      else {
        if (k.length < 12 || /\s/.test(k))
          throw new Error('That does not look like an API key. Paste it exactly as shown.')
        ctx.secrets.set('llm.' + provider, k)
      }
      ctx.llm.resetHealth(provider)
      return llmStatus()
    },
    'capture:hide': () => {
      ctx.capture.hide()
      return null
    },
    'capture:status': () => ctx.capture.status(),
    'rollup:get': (arg) => {
      const r = buildRollup(
        ctx.db,
        vault().listTasks(),
        arg?.weekStart ?? weekStartOf(new Date()),
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
    'llm:configure': ({ provider, enabled, move, models }) => {
      const cur = getSettings().llm
      const order = orderedProviders(cur.order)
      if (move) {
        const i = order.indexOf(provider)
        const j = move === 'up' ? i - 1 : i + 1
        if (j >= 0 && j < order.length) [order[i], order[j]] = [order[j], order[i]]
      }
      const disabled = new Set(cur.disabled)
      if (enabled !== undefined) {
        if (enabled) disabled.delete(provider)
        else disabled.add(provider)
      }
      const nextModels = { ...cur.models }
      if (models) {
        const entry = { ...(nextModels[provider] ?? {}) }
        for (const t of ['extract', 'chat'] as const) {
          const v = models[t].trim()
          if (v) entry[t] = v
          else delete entry[t]
        }
        if (Object.keys(entry).length) nextModels[provider] = entry
        else delete nextModels[provider]
      }
      updateSettings({
        llm: { ...cur, order: order as string[], disabled: [...disabled], models: nextModels }
      })
      ctx.llm.resetHealth(provider as ProviderId)
      return llmStatus()
    },
    'llm:test': async ({ provider }) => {
      try {
        const r = await ctx.llm.generateJson({
          tier: 'extract',
          system: 'Reply with ONLY this JSON: {"ok": true}',
          user: 'ping',
          schema: z.object({ ok: z.boolean() }),
          only: provider
        })
        return { ok: true, message: `Working (${r.provider}, ${r.model}).` }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    },
    'google:open-login': () => {
      // When the sign-in window closes, pull the calendar and mail straight away.
      openLogin(() => {
        void ctx.calendar.sync()
        void ctx.gmail.sync()
      })
      return null
    },
    'app:set-theme': ({ mode }) => {
      nativeTheme.themeSource = mode
      return null
    }
  }

  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    ipcMain.handle(channel, async (_event, raw): Promise<Result<unknown>> => {
      try {
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
