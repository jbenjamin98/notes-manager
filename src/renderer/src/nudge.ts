import type { TaskItem } from '@shared/contract'
import { followUpText } from './tasks'

/**
 * Nudge someone about a delegated task: copy the message, and open a pre-filled Gmail draft
 * (recipient guessed from mail we've already seen). Nothing is sent: the user reviews it in Gmail.
 */
export async function nudgeTask(
  t: TaskItem,
  today: string,
  flash: (m: string) => void
): Promise<void> {
  const text = followUpText(t, today)
  let copied = true
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    copied = false
  }
  const guess = await window.api.invoke('gmail:guess-email', { name: t.owner })
  const to = guess.ok ? (guess.data ?? undefined) : undefined
  const r = await window.api.invoke('gmail:compose', {
    to,
    subject: `Follow-up: ${t.description}`.slice(0, 200),
    body: text
  })
  if (!r.ok) return flash(copied ? 'Follow-up copied. Could not open Gmail.' : r.error.message)
  flash(
    `Gmail draft opened for @${t.owner}${to ? ` (${to})` : ''}${copied ? '. Text also copied.' : '.'}`
  )
}
