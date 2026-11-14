import { useCallback, useEffect, useState } from 'react'
import type { ThemeMode } from '@shared/contract'

const KEY = 'nm-theme'

export function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* storage unavailable: fall back to system */
  }
  return 'system'
}

const prefersDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

/** Sets the `.dark` class on <html>. Safe to call before React mounts (avoids a light flash). */
export function applyTheme(mode: ThemeMode): void {
  const dark = mode === 'dark' || (mode === 'system' && prefersDark())
  document.documentElement.classList.toggle('dark', dark)
}

export function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setModeState] = useState<ThemeMode>(readTheme)

  // Follow the OS while in "system" mode.
  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => applyTheme('system')
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [mode])

  // Keep native chrome (scrollbars, dialogs, window background) in step.
  useEffect(() => {
    applyTheme(mode)
    void window.api.invoke('app:set-theme', { mode })
  }, [mode])

  const setMode = useCallback((m: ThemeMode) => {
    try {
      localStorage.setItem(KEY, m)
    } catch {
      /* ignore */
    }
    setModeState(m)
  }, [])

  return [mode, setMode]
}
