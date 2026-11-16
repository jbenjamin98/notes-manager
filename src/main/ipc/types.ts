import { BrowserWindow } from 'electron'
import { contract } from '../../shared/contract'
import { type InvokeChannel } from '../../shared/channels'
import { type Db } from '../db'
import { type GmailSync } from '../gmail/sync'
import { type NudgeEngine } from '../nudges/engine'
import { type CalendarSync } from '../calendar/sync'
import { type Vault } from '../vault/vault'
import { type Assistant } from '../assistant/assistant'
import { type LlmRouter } from '../llm/router'
import { type SecretStore } from '../services/secrets'
import { type CaptureWindow } from '../capture'
import { type GoogleConnector } from '../google/connector'
import { BridgeClient } from '../google/bridge'

export interface Ctx {
  tagger: import('../assistant/autotag').AutoTagger
  db: Db
  dbPath: string
  getWindow: () => BrowserWindow | null
  getVault: () => Vault | null
  calendar: CalendarSync
  gmail: GmailSync
  engine: NudgeEngine
  assistant: Assistant
  llm: LlmRouter
  secrets: SecretStore
  capture: CaptureWindow
  google: GoogleConnector
  bridge: BridgeClient
  /** Read what changed in chat/meetings/mail for insights; returns how many were new. */
  runInsights: () => Promise<number>
  notifyStatus: () => { supported: boolean; shown: boolean; error: string | null }
  notifyReset: () => void
  /** Tray + start-at-login follow the settings. */
  applyAppSettings: () => void
  switchVault: (root: string) => Promise<void>
}

export type Handlers = {
  [C in InvokeChannel]: (
    input: import('zod').output<(typeof contract)[C]['input']>
  ) =>
    | Promise<import('zod').output<(typeof contract)[C]['output']>>
    | import('zod').output<(typeof contract)[C]['output']>
}
