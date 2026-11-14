import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../shared/channels'
import type { Api } from '../shared/contract'

const invokeAllow: readonly string[] = INVOKE_CHANNELS
const eventAllow: readonly string[] = EVENT_CHANNELS

// Only this allow-listed surface reaches the renderer: no raw ipcRenderer, no fs.
const api: Api = {
  invoke: ((channel: string, input?: unknown) => {
    if (!invokeAllow.includes(channel)) {
      return Promise.resolve({ ok: false, error: { code: 'BAD_CHANNEL', message: channel } })
    }
    return ipcRenderer.invoke(channel, input)
  }) as Api['invoke'],
  on: (event, listener) => {
    if (!eventAllow.includes(event)) throw new Error(`Unknown event channel: ${event}`)
    const handler = (_e: IpcRendererEvent, payload: unknown): void => listener(payload as never)
    ipcRenderer.on(event, handler)
    return () => ipcRenderer.removeListener(event, handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
