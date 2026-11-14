import type { Settings } from '../../shared/contract'
import type { LlmConfig } from './router'
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from './providers'

/** The user's saved order first (unknown names dropped), then any provider they have not placed yet. */
export function orderedProviders(saved: string[]): ProviderId[] {
  const out: ProviderId[] = []
  for (const s of saved) {
    const id = s as ProviderId
    if (PROVIDER_IDS.includes(id) && !out.includes(id)) out.push(id)
  }
  for (const id of PROVIDER_IDS) if (!out.includes(id)) out.push(id)
  return out
}

export function routerConfig(llm: Settings['llm']): LlmConfig {
  // Tests point these at a local fake server (NM_LLM_GEMINI_URL, ...); real use never sets them.
  const baseUrls: Partial<Record<ProviderId, string>> = {}
  for (const id of PROVIDER_IDS) {
    const v = process.env[`NM_LLM_${id.toUpperCase()}_URL`]
    if (v) baseUrls[id] = v
  }
  return {
    enabled: llm.enabled,
    order: orderedProviders(llm.order),
    disabled: llm.disabled.filter((d): d is ProviderId => d in PROVIDERS),
    models: llm.models as LlmConfig['models'],
    baseUrls
  }
}
