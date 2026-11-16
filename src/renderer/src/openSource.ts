/** Open the original of an insight or task (the meeting note, the email, the chat). */
export async function openInsightSource(
  id: string,
  onOpenNote?: (path: string) => void
): Promise<void> {
  const r = await window.api.invoke('inbox:open-source', { id })
  if (r.ok && r.data.path) onOpenNote?.(r.data.path)
}
