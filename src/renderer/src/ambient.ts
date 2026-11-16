import { useEffect } from 'react'
import { wall } from './format'

export type Phase = 'dawn' | 'day' | 'dusk' | 'night'

export function phaseFor(hour: number): Phase {
  if (hour >= 5 && hour < 8) return 'dawn'
  if (hour >= 8 && hour < 17) return 'day'
  if (hour >= 17 && hour < 20) return 'dusk'
  return 'night'
}

export function greetingFor(hour: number): string {
  if (hour < 5) return 'Burning the midnight oil'
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  if (hour < 21) return 'Good evening'
  return 'Working late'
}

/**
 * The background tint follows the time of day in your time zone (dawn, day, dusk, night),
 * and glass panels catch the light where the pointer is.
 */
export function useAmbient(): void {
  useEffect(() => {
    const set = (): void => {
      document.documentElement.dataset.phase = phaseFor(wall().getHours())
    }
    set()
    const t = setInterval(set, 5 * 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let raf = 0
    const move = (e: PointerEvent): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        for (const el of document.querySelectorAll<HTMLElement>('.glass')) {
          const r = el.getBoundingClientRect()
          el.style.setProperty('--gx', `${e.clientX - r.left}px`)
          el.style.setProperty('--gy', `${e.clientY - r.top}px`)
        }
      })
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => {
      window.removeEventListener('pointermove', move)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
}
