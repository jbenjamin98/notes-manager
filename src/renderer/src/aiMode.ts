import { useCallback, useEffect, useState } from 'react'
import type { AiMode } from '@shared/aiProfile'
import type { PersonaId } from '@shared/personas'

const EVENT = 'nm-ai-mode'

/** The current AI mode (Light / Normal / Heavy), kept in step across every place that shows it. */
export function useAiMode(): [AiMode, (m: AiMode) => Promise<void>] {
  const [mode, setModeState] = useState<AiMode>('normal')

  useEffect(() => {
    let alive = true
    void window.api
      .invoke('settings:get')
      .then((r) => alive && r.ok && setModeState(r.data.llm.mode))
    const on = (e: Event): void => setModeState((e as CustomEvent<AiMode>).detail)
    window.addEventListener(EVENT, on)
    return () => {
      alive = false
      window.removeEventListener(EVENT, on)
    }
  }, [])

  const setMode = useCallback(async (m: AiMode): Promise<void> => {
    setModeState(m)
    const cur = await window.api.invoke('settings:get')
    if (!cur.ok) return
    await window.api.invoke('settings:update', { llm: { ...cur.data.llm, mode: m } })
    window.dispatchEvent(new CustomEvent(EVENT, { detail: m }))
  }, [])

  return [mode, setMode]
}

const PERSONA_EVENT = 'nm-persona'

/** The chosen assistant personality, shared by the drawer, Settings and the sidebar. */
export function usePersona(): [PersonaId, (p: PersonaId) => Promise<void>] {
  const [persona, setState] = useState<PersonaId>('nova')
  useEffect(() => {
    let alive = true
    void window.api
      .invoke('settings:get')
      .then((r) => alive && r.ok && setState(r.data.assistant.persona))
    const on = (e: Event): void => setState((e as CustomEvent<PersonaId>).detail)
    window.addEventListener(PERSONA_EVENT, on)
    return () => {
      alive = false
      window.removeEventListener(PERSONA_EVENT, on)
    }
  }, [])
  const set = useCallback(async (p: PersonaId): Promise<void> => {
    setState(p)
    const cur = await window.api.invoke('settings:get')
    if (!cur.ok) return
    await window.api.invoke('settings:update', { assistant: { ...cur.data.assistant, persona: p } })
    window.dispatchEvent(new CustomEvent(PERSONA_EVENT, { detail: p }))
  }, [])
  return [persona, set]
}
