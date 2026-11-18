import { ApiError } from './api'
import { BridgeError } from './bridge'

/**
 * Did Google ask us to slow down? Checks the error's type first (OAuth or script), and falls back
 * to the wording so errors that were turned into plain messages along the way still count.
 */
export function isRateLimited(err: unknown): boolean {
  if (err instanceof ApiError) return err.reason === 'rate'
  if (err instanceof BridgeError) return err.code === 'rate-limited'
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /try again in a minute|limiting how fast/i.test(msg)
}
