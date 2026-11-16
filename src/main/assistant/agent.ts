import { z } from 'zod'
import type { JsonRequest, JsonResult } from '../llm/router'
import { runTool, TOOLS, type Args, type ToolDeps, type ToolSource } from './tools'

/**
 * The assistant's thinking loop. Each turn the model either answers or asks to look things up
 * (up to three read-only lookups at once, see tools.ts); what it finds is numbered and fed back,
 * and it answers when it has enough. A simple question is one call; a bigger one is two to four.
 * Nothing here writes anything: it only reads, and reports what it looked at.
 */
export interface AgentLlm {
  generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>>
}

export interface AgentSource extends ToolSource {
  n: number
}

export interface AgentInput {
  question: string
  /** Earlier turns, already formatted ("User: …\nAssistant: …"), or ''. */
  history: string
  /** The persona's character sheet. */
  voice: string
  today: string
  /** The names the user goes by. */
  me: string[]
  /** A few lines about right now (task counts, next meeting...). */
  digest: string
  /** Sources found before the first call (note passages, tasks, meetings). */
  seed: ToolSource[]
  /** Lookups allowed (0 = answer from the seed alone, as in Quick mode). */
  maxSteps: number
  tier: 'extract' | 'chat'
  maxOut: number
  repair: boolean
  /** How long an answer should be. */
  length: string
  followups: boolean
}

export interface AgentOk {
  ok: true
  answer: string
  cited: number[]
  followups: string[]
  offer: { kind: 'tasks' | 'note'; label: string } | null
  sources: AgentSource[]
  /** What was looked at, in plain words ("calendar", "Priya", "3 notes"). */
  trail: string[]
  calls: number
}

export interface AgentFail {
  ok: false
  error: unknown
  sources: AgentSource[]
  trail: string[]
  /** True when nothing was answered because the very first call failed (no AI to talk to). */
  first: boolean
}

const Lookup = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).nullish()
})
const Step = z.object({
  action: z.enum(['answer', 'lookup']).nullish(),
  lookups: z.array(Lookup).nullish(),
  answer: z.string().nullish(),
  cited: z.array(z.number()).nullish(),
  followups: z.array(z.string()).nullish(),
  offer: z.object({ kind: z.enum(['tasks', 'note']), label: z.string() }).nullish()
})
type StepT = z.infer<typeof Step>

const MAX_PER_STEP = 3

export function agentSystemPrompt(i: AgentInput, canLookUp: boolean): string {
  const tools = TOOLS.map((t) => `- ${t.name}: ${t.help}`).join('\n')
  return [
    i.voice,
    '',
    'You are the user’s personal work assistant inside their notes app. You can see their meeting notes, their own tasks, their calendar, what other people owe them, and what came out of their meetings, email and chat. Talk to them like a person who knows their work, in your own voice, not like a report generator.',
    '',
    'HOW TO RESPOND',
    '- Lead with the answer or your honest take in the first sentence. No preamble, do not repeat the question, no "Certainly".',
    '- Then give the substance that makes it useful: who, what, when, where it stands, what is stuck, and what you would do next. Connect related things across sources (a decision in one meeting and the task it created).',
    '- If they are just chatting, thinking out loud, venting or thanking you, answer like a person would, warmly and in character. You do not need any lookup for that, and you do not need to bring up their tasks unless it helps.',
    '- If they dump several to-dos or things to remember, do NOT create anything yourself: say briefly what you noticed, and set "offer" so they can choose to turn it into tasks or a note.',
    '- Use ONLY the sources for facts about their work. Never invent people, dates, numbers or decisions. Cite sources inline like [2] right after the fact, and list the numbers you used in "cited".',
    '- If the sources only partly answer, say what you found and name the gap plainly. If you found nothing, say so in one sentence in your voice and suggest where to look or what to ask.',
    '- Write dates the way people say them ("Thursday", "Nov 20"), never ISO. Light formatting only: **bold**, "- " bullets, "1." lists. No headings, tables or HTML.',
    `- Length: ${i.length}.`,
    '',
    canLookUp
      ? [
          'LOOKING THINGS UP',
          'If the sources below do not clearly cover what they asked, set "action":"lookup" and list up to 3 lookups, instead of guessing or saying you do not know. Do not look up what you already have. Tools:',
          tools,
          'After lookups you will get the results as new numbered sources and can answer or look up once more.'
        ].join('\n')
      : 'You have no lookup tools this time; answer from the sources given.',
    '',
    `OUTPUT: ONLY one JSON object: {"action":"answer"${canLookUp ? '|"lookup"' : ''},${canLookUp ? '"lookups":[{"tool":string,"args":object}],' : ''}"answer":string,"cited":[numbers],"followups":[${i.followups ? 'up to 3 short follow-up questions they might ask next' : 'leave empty'}],"offer":null|{"kind":"tasks"|"note","label":"a short button label"}}`
  ].join('\n')
}

function formatSources(list: AgentSource[]): string {
  if (!list.length) return '(none yet)'
  return list.map((s) => `[${s.n}] ${s.label}\n${s.text}`).join('\n\n')
}

const noun: Record<string, (a: Args) => string> = {
  search_notes: () => 'your notes',
  read_note: () => 'a note',
  list_tasks: () => 'your tasks',
  waiting_on: () => 'what people owe you',
  calendar: () => 'your calendar',
  person_or_topic: (a) =>
    typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'a person',
  inbox_insights: () => 'your inbox insights',
  mail: () => 'your email',
  read_email: () => 'an email',
  chat: () => 'your chats'
}

export async function runAgent(
  llm: AgentLlm,
  tools: ToolDeps,
  input: AgentInput,
  onProgress: (label: string) => void = () => undefined
): Promise<AgentOk | AgentFail> {
  const all: AgentSource[] = input.seed.map((s, i) => ({ ...s, n: i + 1 }))
  const trail: string[] = []
  const done = new Set<string>()
  let calls = 0
  const who = input.me.find((m) => m.toLowerCase() !== 'me') ?? input.me[0] ?? 'the user'

  for (let step = 0; step <= input.maxSteps; step++) {
    const canLookUp = step < input.maxSteps
    const system = agentSystemPrompt(input, canLookUp)
    const user = [
      `Today is ${input.today}. The user is ${who}${input.me.length > 1 ? ` (also called ${input.me.filter((m) => m !== who && m.toLowerCase() !== 'me').join(', ') || 'me'})` : ''}.`,
      input.digest ? `Right now: ${input.digest}` : '',
      input.history ? `Earlier in this chat:\n${input.history}` : '',
      `Sources so far:\n${formatSources(all)}`,
      step > 0 && !canLookUp
        ? 'You have done all the lookups you may do. Answer now with what you have; name any gap.'
        : '',
      `They say: ${input.question}`
    ]
      .filter(Boolean)
      .join('\n\n')

    if (step > 0) onProgress('Thinking it through…')
    let res: JsonResult<StepT>
    try {
      calls++
      res = await llm.generateJson({
        tier: input.tier,
        feature: 'ask',
        system,
        user,
        schema: Step,
        maxOut: input.maxOut,
        repair: input.repair
      })
    } catch (error) {
      return { ok: false, error, sources: all, trail, first: calls === 1 }
    }
    const d = res.data
    const lookups = (d.lookups ?? []).slice(0, MAX_PER_STEP)
    const wantsLookup = canLookUp && d.action === 'lookup' && lookups.length > 0

    if (!wantsLookup) {
      const answer = (d.answer ?? '').trim()
      if (!answer && canLookUp) {
        // Said nothing and asked for nothing: nudge once more with what we have.
        input = { ...input, maxSteps: step }
        step--
        continue
      }
      const valid = (d.cited ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= all.length)
      return {
        ok: true,
        answer:
          answer || 'I could not put an answer together from that. Could you ask it another way?',
        cited: [...new Set(valid)],
        followups: input.followups ? (d.followups ?? []).slice(0, 3) : [],
        offer: d.offer ?? null,
        sources: all,
        trail,
        calls
      }
    }

    for (const l of lookups) {
      const args = (l.args ?? {}) as Args
      const sig = `${l.tool}:${JSON.stringify(args)}`
      if (done.has(sig)) continue
      done.add(sig)
      const r = await runTool(tools, l.tool, args)
      if (r.working) onProgress(r.working)
      const label = (noun[l.tool] ?? (() => l.tool))(args)
      trail.push(
        r.sources.length > 1 && l.tool === 'search_notes' ? `${r.sources.length} notes` : label
      )
      if (r.sources.length === 0) {
        all.push({
          n: all.length + 1,
          kind: 'insight',
          label: `Lookup · ${l.tool}`,
          text: r.note ?? 'Nothing found.',
          path: null,
          title: '',
          date: '',
          heading: null
        })
      }
      for (const s of r.sources) all.push({ ...s, n: all.length + 1 })
    }
  }
  // Unreachable: the last step cannot look things up, so it always returns above.
  return {
    ok: false,
    error: new Error('The assistant did not finish.'),
    sources: all,
    trail,
    first: false
  }
}

/** "Looked at your calendar, Priya and 3 notes." */
export function trailText(trail: string[]): string | null {
  const u = [...new Set(trail)]
  if (!u.length) return null
  const list = u.length > 1 ? `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}` : u[0]
  return `Looked at ${list}.`
}
