import { z } from 'zod'
import * as chrono from 'chrono-node'
import type { JsonGenerator } from '../assistant/assistant'
import { KINDS, type Candidate, type ExtractCtx } from './types'

/**
 * The semantic step. Rules catch the obvious wording; a small model catches paraphrase ("I think B
 * works", "let's keep it simple and go with the first one"). It is shown only the gated sentences,
 * answers in strict JSON, and its result is cached by content hash (the router does that when given
 * a cacheKey), so the same text never costs twice.
 */
export const ModelOut = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(KINDS as [string, ...string[]]),
        text: z.string().max(400),
        owner: z.string().nullish(),
        due_phrase: z.string().nullish(),
        confidence: z.number().min(0).max(1).default(0.6),
        evidence: z.string().nullish()
      })
    )
    .max(30)
    .default([])
})

export const SYSTEM = `You read part of a work conversation or meeting note for a delivery manager and list ONLY the things worth remembering. Reply with ONLY JSON: {"items":[{"kind","text","owner","due_phrase","confidence","evidence"}]}.
Kinds: "action" (someone must do something), "ask" (someone asked the reader, who is "Me", to do something), "promise" (Me said they would do something), "decision" (a choice was made or approved, including when a proposal got agreement), "question" (an open question nobody answered), "risk" (a risk, blocker, issue or dependency), "change" (a date, scope or plan moved), "fact" (a role or relationship, like who owns or sponsors something).
Rules: use only what is written; never invent. "text" is one clear sentence in plain words. "owner" is a person's name or "Me" or null. "due_phrase" is the exact words about timing or null. "evidence" is a short quote. "confidence" 0 to 1. Skip small talk, greetings and anything already finished. Skip marketing, newsletters, notifications, receipts and automated mail completely: when the text is mostly that, return {"items":[]}. Prefer fewer, clearly important items over many. At most 30 items.`

export async function extractWithModel(
  llm: JsonGenerator,
  gated: string,
  ctx: ExtractCtx,
  cacheKey: string
): Promise<Candidate[]> {
  const res = await llm.generateJson({
    tier: 'extract',
    feature: 'insights',
    system: SYSTEM,
    user: `Source: ${ctx.source}. My names: ${ctx.me.join(', ')}.\n\n${gated}`,
    schema: ModelOut,
    maxOut: 1200,
    cacheKey: `insights:${cacheKey}`,
    cacheTtlMs: 7 * 86_400_000
  })
  return res.data.items.map((i) => {
    const d = i.due_phrase ? chrono.parse(i.due_phrase, ctx.now, { forwardDate: true })[0] : null
    const date = d?.start.date()
    return {
      kind: i.kind as Candidate['kind'],
      text: i.text.trim(),
      owner: i.owner?.trim() || null,
      due: date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : null,
      confidence: i.confidence,
      evidence: (i.evidence ?? i.text).slice(0, 300)
    }
  })
}
