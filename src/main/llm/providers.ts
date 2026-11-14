/**
 * Thin REST clients for the supported AI providers. No SDKs: one `fetch` each, so there is nothing
 * native to compile and the request/response shapes are visible here. Everyone brings their own key.
 */

export type ProviderId = 'gemini' | 'groq' | 'openai' | 'anthropic' | 'openrouter'
export type Tier = 'extract' | 'chat'
type Kind = 'gemini' | 'openai' | 'anthropic'

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** What the provider itself says is left in its current rate-limit window (when it tells us). */
export interface RateLimits {
  remainingRequests: number | null
  limitRequests: number | null
  remainingTokens: number | null
  limitTokens: number | null
}

export interface ProviderResult {
  text: string
  tokensIn: number | null
  tokensOut: number | null
  limits?: RateLimits | null
}

export interface ProviderMeta {
  id: ProviderId
  label: string
  kind: Kind
  /** Usage is billed to the user's account (no free tier to rely on). */
  paid: boolean
  base: string
  /** Defaults only: model names change often, so Settings lets users override them. */
  models: Record<Tier, string>
  /** Conservative requests-per-minute budget the router keeps to. */
  rpm: number
  keyUrl: string
  blurb: string
}

/** Listed in the default order the router tries them. */
export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    paid: false,
    base: 'https://generativelanguage.googleapis.com/v1beta',
    models: { extract: 'gemini-2.5-flash-lite', chat: 'gemini-2.5-flash' },
    rpm: 10,
    keyUrl: 'https://aistudio.google.com/apikey',
    blurb: 'Free tier, no billing needed.'
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    paid: false,
    base: 'https://api.groq.com/openai/v1',
    models: { extract: 'llama-3.1-8b-instant', chat: 'llama-3.3-70b-versatile' },
    rpm: 25,
    keyUrl: 'https://console.groq.com/keys',
    blurb: 'Free tier, very fast.'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    paid: false,
    base: 'https://openrouter.ai/api/v1',
    models: { extract: 'openai/gpt-4o-mini', chat: 'openai/gpt-4o-mini' },
    rpm: 20,
    keyUrl: 'https://openrouter.ai/keys',
    blurb: 'One key for many models. Set a model in Settings; free and paid models both work.'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    paid: true,
    base: 'https://api.openai.com/v1',
    models: { extract: 'gpt-4o-mini', chat: 'gpt-4o' },
    rpm: 60,
    keyUrl: 'https://platform.openai.com/api-keys',
    blurb: 'Pay as you go. Charges go to your OpenAI account.'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    paid: true,
    base: 'https://api.anthropic.com/v1',
    models: { extract: 'claude-haiku-5-5', chat: 'claude-sonnet-5-5' },
    rpm: 40,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    blurb: 'Pay as you go. Charges go to your Anthropic account.'
  }
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

export const DEFAULT_BASE: Record<ProviderId, string> = Object.fromEntries(
  PROVIDER_IDS.map((p) => [p, PROVIDERS[p].base])
) as Record<ProviderId, string>

export const DEFAULT_MODELS: Record<ProviderId, Record<Tier, string>> = Object.fromEntries(
  PROVIDER_IDS.map((p) => [p, PROVIDERS[p].models])
) as Record<ProviderId, Record<Tier, string>>

/** An HTTP-level failure, with the server's own back-off hint when it gave one. */
export class LlmHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSec: number | null = null
  ) {
    super(message)
  }
}

const retryAfter = (res: Response): number | null => {
  const v = res.headers.get('retry-after')
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

async function failure(res: Response): Promise<never> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 300)
  } catch {
    /* body unreadable */
  }
  throw new LlmHttpError(
    res.status,
    `HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
    retryAfter(res)
  )
}

const num = (v: string | null): number | null => {
  const n = v === null ? NaN : Number(v)
  return Number.isFinite(n) ? n : null
}

/** OpenAI, Groq and Anthropic report their rate-limit window in response headers; Gemini does not. */
export function parseLimits(h: Headers, prefix: 'openai' | 'anthropic'): RateLimits | null {
  const g =
    prefix === 'openai'
      ? {
          rr: 'x-ratelimit-remaining-requests',
          lr: 'x-ratelimit-limit-requests',
          rt: 'x-ratelimit-remaining-tokens',
          lt: 'x-ratelimit-limit-tokens'
        }
      : {
          rr: 'anthropic-ratelimit-requests-remaining',
          lr: 'anthropic-ratelimit-requests-limit',
          rt: 'anthropic-ratelimit-tokens-remaining',
          lt: 'anthropic-ratelimit-tokens-limit'
        }
  const l: RateLimits = {
    remainingRequests: num(h.get(g.rr)),
    limitRequests: num(h.get(g.lr)),
    remainingTokens: num(h.get(g.rt)),
    limitTokens: num(h.get(g.lt))
  }
  return Object.values(l).every((v) => v === null) ? null : l
}

type Call = (
  f: typeof fetch,
  base: string,
  key: string,
  model: string,
  messages: ChatMsg[],
  signal: AbortSignal
) => Promise<ProviderResult>

export const callGemini: Call = async (f, base, key, model, messages, signal) => {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
  }
  const res = await f(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) return failure(res)
  const j = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) throw new LlmHttpError(502, 'Gemini returned no text (it may have been blocked)')
  return {
    text,
    tokensIn: j.usageMetadata?.promptTokenCount ?? null,
    tokensOut: j.usageMetadata?.candidatesTokenCount ?? null
  }
}

/** OpenAI, Groq and OpenRouter all speak the same chat-completions dialect. */
export const callOpenAiCompatible: Call = async (f, base, key, model, messages, signal) => {
  const res = await f(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' }
    }),
    signal
  })
  if (!res.ok) return failure(res)
  const j = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const text = j.choices?.[0]?.message?.content ?? ''
  if (!text) throw new LlmHttpError(502, 'The model returned no text')
  return {
    text,
    tokensIn: j.usage?.prompt_tokens ?? null,
    tokensOut: j.usage?.completion_tokens ?? null,
    limits: parseLimits(res.headers, 'openai')
  }
}

export const callAnthropic: Call = async (f, base, key, model, messages, signal) => {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const res = await f(`${base}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.2,
      ...(system ? { system } : {}),
      messages: messages.filter((m) => m.role !== 'system')
    }),
    signal
  })
  if (!res.ok) return failure(res)
  const j = (await res.json()) as {
    content?: { type?: string; text?: string }[]
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const text = (j.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
  if (!text) throw new LlmHttpError(502, 'Claude returned no text')
  return {
    text,
    tokensIn: j.usage?.input_tokens ?? null,
    tokensOut: j.usage?.output_tokens ?? null,
    limits: parseLimits(res.headers, 'anthropic')
  }
}

export const CALLERS: Record<Kind, Call> = {
  gemini: callGemini,
  openai: callOpenAiCompatible,
  anthropic: callAnthropic
}
