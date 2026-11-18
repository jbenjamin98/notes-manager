import type { Db } from '../db'

/**
 * The three example prompts shown in an empty Co-Pilot, made from the user's own notes (their most
 * recent person and their most recent project, customer or system) so they are things they could
 * really ask. With nothing to draw on they are plain examples with no invented names.
 */
export function buildHints(person: string | null, topic: string | null): string[] {
  return [
    "What's on my plate this week?",
    topic ? `What's the latest on ${topic}?` : 'Summarize my most recent meeting',
    person ? `What did I last talk about with ${person}?` : 'What did I decide recently?'
  ]
}

export function assistantHints(db: Db): string[] {
  const latest = (categories: string): string | null => {
    const row = db
      .prepare(
        `SELECT e.name AS name
           FROM entities e
           JOIN note_entities ne ON ne.entity_id = e.id
           JOIN notes n ON n.id = ne.note_id
          WHERE e.category IN (${categories}) AND e.in_registry = 1 AND n.type <> 'inbox'
          GROUP BY e.id
          ORDER BY MAX(n.date) DESC, SUM(ne.mention_count) DESC
          LIMIT 1`
      )
      .get() as { name: string } | undefined
    return row?.name ?? null
  }
  return buildHints(latest("'person'"), latest("'project','customer','system'"))
}
