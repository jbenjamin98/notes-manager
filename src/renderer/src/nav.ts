import { useCallback, useSyncExternalStore } from 'react'

/**
 * Where you are INSIDE a page (the Browse bucket you opened, the Inbox tab, the calendar day, the
 * Knowledge tab). It lives outside the components so it survives a page being rebuilt, and the
 * app's Back history records it, so Back returns to exactly where you were, not the page's front
 * door. Keys start with the page they belong to ("library.", "chat.", "calendar.", "manage.");
 * opening a page from the sidebar starts it fresh (`navReset`).
 */
const store = new Map<string, unknown>()
let version = 0
const subs = new Set<() => void>()
const bump = (): void => {
  version++
  subs.forEach((f) => f())
}

export const subscribeNav = (f: () => void): (() => void) => {
  subs.add(f)
  return () => {
    subs.delete(f)
  }
}
export const navVersion = (): number => version

/** Everything remembered, as one string (compared and stored in the history). */
export const navSnapshot = (): string =>
  JSON.stringify([...store.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))

export function navRestore(snapshot: string): void {
  store.clear()
  for (const [k, v] of JSON.parse(snapshot) as [string, unknown][]) store.set(k, v)
  bump()
}

/** Forget what was remembered for one page (it starts from its front door again). */
export function navReset(prefix: string): void {
  let changed = false
  for (const k of [...store.keys()])
    if (k.startsWith(prefix)) {
      store.delete(k)
      changed = true
    }
  if (changed) bump()
}

/** Set a remembered value from outside a component (e.g. open a page on a particular tab). */
export function navSet(key: string, value: unknown): void {
  if (store.has(key) && store.get(key) === value) return
  store.set(key, value)
  bump()
}

/** Like useState, but remembered across the page being rebuilt and recorded for Back. */
export function useNavState<T>(key: string, initial: T): [T, (next: T) => void] {
  const value = useSyncExternalStore(subscribeNav, () =>
    store.has(key) ? (store.get(key) as T) : initial
  )
  const set = useCallback(
    (next: T) => {
      if (store.has(key) && store.get(key) === next) return
      store.set(key, next)
      bump()
    },
    [key]
  )
  return [value, set]
}
