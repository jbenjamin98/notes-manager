import { shell } from 'electron'
import { type Output } from '../../shared/contract'
import { openThread } from '../services/google'
import { type Vault } from '../vault/vault'
import { acceptInsight, sourceTarget } from '../insights/accept'
import { adjustSender } from '../gmail/importance'
import {
  getInsight,
  insightsFor,
  listInsights,
  setStatus as setInsightStatus,
  type InsightRow
} from '../insights/store'
import { triage, recordFeedback, topicMatcher } from '../chat/triage'
import { ownerIsMe } from '../waiting/waiting'
import { getSettings } from '../services/settings'
import type { Ctx, Handlers } from './types'

const toItem = (i: InsightRow, me: string[]): Output<'inbox:list'>[number] => ({
  mine: ownerIsMe(i.owner, me),
  id: i.id,
  kind: i.kind,
  text: i.text,
  owner: i.owner,
  due: i.due,
  confidence: i.confidence,
  status: i.status,
  sourceType: i.sourceType,
  sourceLabel: i.sourceLabel,
  sourceSnippet: i.sourceSnippet,
  sourceAt: i.sourceAt,
  entities: i.entities
})

export function inboxHandlers(
  ctx: Ctx
): Pick<
  Handlers,
  | 'insights:analyze'
  | 'inbox:list'
  | 'inbox:accept'
  | 'inbox:dismiss'
  | 'inbox:open-source'
  | 'inbox:refresh'
  | 'insights:for-entity'
  | 'chat:overview'
  | 'chat:feedback'
  | 'chat:set-mode'
> {
  const vault = (): Vault => {
    const v = ctx.getVault()
    if (!v) throw new Error('Vault not ready')
    return v
  }

  return {
    'insights:analyze': ({ days }) => vault().insights(days),
    'inbox:list': () => listInsights(ctx.db, 'new').map((i) => toItem(i, getSettings().meAliases)),
    'inbox:accept': ({ id, ...edits }) =>
      acceptInsight(ctx.db, vault(), id, new Date(), edits, getSettings().meAliases),
    'inbox:dismiss': ({ id, undo }) => {
      // Dismissing something that came from an email is a small vote against that sender.
      const row = getInsight(ctx.db, id)
      const thread =
        row?.sourceType === 'email' ? (row.sourceRef as { threadId?: string }).threadId : null
      if (thread) {
        const t = ctx.db
          .prepare('SELECT sender_email AS e FROM email_threads WHERE id = ?')
          .get(thread) as { e: string | null } | undefined
        if (t?.e) adjustSender(ctx.db, t.e, undo ? 1 : -1)
      }
      setInsightStatus(ctx.db, id, undo ? 'new' : 'dismissed')
      return null
    },
    'inbox:open-source': async ({ id }) => {
      const t = await sourceTarget(ctx.db, ctx.getVault(), id)
      if (t.url) void shell.openExternal(t.url)
      if (t.thread) {
        const row = ctx.db
          .prepare(
            'SELECT link_id AS linkId, subject FROM email_threads WHERE id = ? OR link_id = ? LIMIT 1'
          )
          .get(t.thread.id, t.thread.id) as { linkId: string | null; subject: string } | undefined
        openThread(row?.linkId ?? t.thread.id, row?.subject ?? t.thread.subject)
      }
      return { path: t.path }
    },
    'inbox:refresh': async () => ({ added: await ctx.runInsights() }),
    'insights:for-entity': ({ name }) =>
      insightsFor(ctx.db, name).map((i) => toItem(i, getSettings().meAliases)),
    'chat:overview': () => {
      const db = ctx.db
      const t = triage(db, { topicHit: topicMatcher(db) })
      const spaces = (
        db
          .prepare('SELECT space, name, type, mode FROM chat_spaces ORDER BY last_at DESC')
          .all() as {
          space: string
          name: string
          type: string
          mode: 'auto' | 'track' | 'mentions' | 'ignore'
        }[]
      ).slice(0, 200)
      const api = ctx.google.active()
      return {
        conversations: t.conversations
          .filter((c) => c.bucket !== 'noise' || c.score >= 2)
          .slice(0, 80),
        commitments: t.commitments.slice(-20).map((c) => ({
          convKey: c.convKey,
          spaceName: c.spaceName,
          text: c.text,
          at: c.at
        })),
        spaces,
        source: api
          ? ('api' as const)
          : ctx.bridge.configured()
            ? ('bridge' as const)
            : ('none' as const),
        complete: api,
        lastAt:
          (
            db.prepare("SELECT value FROM kv WHERE key = 'chat.lastAt'").get() as
              { value: string } | undefined
          )?.value ?? null
      }
    },
    'chat:feedback': ({ key, reasons, relevant }) => {
      recordFeedback(ctx.db, key, reasons, relevant)
      return null
    },
    'chat:set-mode': ({ space, mode }) => {
      ctx.db.prepare('UPDATE chat_spaces SET mode = ? WHERE space = ?').run(mode, space)
      return null
    }
  }
}
