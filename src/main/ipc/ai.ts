import { assistantHints } from '../assistant/hints'
import { type Output } from '../../shared/contract'
import { getSettings, updateSettings } from '../services/settings'
import { z } from 'zod'
import { orderedProviders } from '../llm/config'
import { PROVIDERS, type ProviderId } from '../llm/providers'
import type { Ctx, Handlers } from './types'

/** Provider status for the AI settings and diagnostics. */
export function llmStatusFor(ctx: Ctx): Output<'llm:status'> {
  const st = ctx.llm.status()
  const custom = getSettings().llm.models
  return {
    enabled: getSettings().llm.enabled,
    budget: ctx.llm.budget(),
    usage: ctx.llm.usageByFeature(),
    cacheHits: ctx.llm.cacheHitsToday(),
    history: ctx.llm.history(7),
    events: ctx.llm.recentEvents(8),
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

export function aiHandlers(
  ctx: Ctx
): Pick<
  Handlers,
  | 'assistant:send'
  | 'assistant:history'
  | 'assistant:hints'
  | 'assistant:unread'
  | 'assistant:mark-read'
  | 'assistant:action'
  | 'assistant:apply'
  | 'assistant:dismiss'
  | 'assistant:clear'
  | 'llm:status'
  | 'llm:set-key'
  | 'llm:configure'
  | 'llm:test'
> {
  const llmStatus = (): Output<'llm:status'> => llmStatusFor(ctx)

  return {
    'assistant:send': ({ text, mode, quiet }) => ctx.assistant.send(text, mode ?? 'auto', quiet),
    'assistant:history': () => ctx.assistant.history(),
    'assistant:hints': () => assistantHints(ctx.db),
    'assistant:unread': () => ctx.assistant.unread(),
    'assistant:mark-read': () => {
      ctx.assistant.markRead()
      ctx.getWindow()?.webContents.send('assistant:changed', { unread: 0 })
      return null
    },
    'assistant:action': (a) => ctx.assistant.runAction(a),
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
        ctx.llm.resetHealth(provider as ProviderId)
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
    }
  }
}
