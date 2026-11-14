import { useCallback, useEffect, useState } from 'react'

const PRESETS: { value: string; label: string }[] = [
  { value: 'CommandOrControl+Shift+Space', label: 'Ctrl + Shift + Space' },
  { value: 'CommandOrControl+Alt+Space', label: 'Ctrl + Alt + Space' },
  { value: 'CommandOrControl+Shift+N', label: 'Ctrl + Shift + N' },
  { value: 'CommandOrControl+Alt+N', label: 'Ctrl + Alt + N' }
]

export default function CaptureSettings(): React.JSX.Element {
  const [cfg, setCfg] = useState<{ enabled: boolean; hotkey: string } | null>(null)
  const [reg, setReg] = useState<boolean | null>(null)

  const status = useCallback(() => {
    void window.api.invoke('capture:status').then((r) => r.ok && setReg(r.data.registered))
  }, [])
  useEffect(() => {
    void window.api.invoke('settings:get').then((r) => r.ok && setCfg(r.data.quickCapture))
    status()
  }, [status])

  const save = async (next: { enabled: boolean; hotkey: string }): Promise<void> => {
    setCfg(next)
    await window.api.invoke('settings:update', { quickCapture: next })
    status()
  }

  if (!cfg) return <></>
  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => void save({ ...cfg, enabled: e.target.checked })}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Quick capture from anywhere in Windows
      </label>
      <p className="mt-1 text-xs text-muted">
        Press the shortcut, type a task in plain words, press Enter. The app only needs to be
        running (it can sit in the system tray).
      </p>
      {cfg.enabled && (
        <div className="mt-2 flex items-center gap-2 text-sm">
          <select
            value={cfg.hotkey}
            onChange={(e) => void save({ ...cfg, hotkey: e.target.value })}
            aria-label="Quick capture shortcut"
            className="rounded-lg border border-line bg-field px-2 py-1 text-sm"
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {reg === true && <span className="text-xs text-ok">Active</span>}
          {reg === false && (
            <span className="text-xs text-danger">
              Another program already uses this shortcut. Pick a different one.
            </span>
          )}
        </div>
      )}
    </>
  )
}
