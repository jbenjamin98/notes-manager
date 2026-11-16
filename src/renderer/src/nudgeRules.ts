/** What each nudge does, in plain words, for the Settings switches. Keep in step with main/nudges/rules.ts. */
export const NUDGE_RULES: { id: string; label: string; description: string }[] = [
  { id: 'brief', label: 'Morning brief', description: 'Your day at a glance when work starts.' },
  {
    id: 'prep',
    label: 'Before a meeting',
    description: 'Open tasks and questions from the last meeting in the series, 15 minutes ahead.'
  },
  {
    id: 'empty-note',
    label: 'After a meeting',
    description: 'A nudge when a meeting you usually take notes for ends with no notes.'
  },
  {
    id: 'overload',
    label: 'Too much on one day',
    description: 'Warns when meetings plus your due tasks do not fit the day.'
  },
  {
    id: 'followup',
    label: 'Follow-up radar',
    description: 'People and emails you have been waiting on for days.'
  },
  {
    id: 'blocker',
    label: 'Chronic blockers',
    description: 'An open question that keeps coming back in the same recurring meeting.'
  },
  {
    id: 'eod',
    label: 'End of day',
    description: 'What is still open today, and what collides tomorrow.'
  },
  {
    id: 'chat',
    label: 'Chat needs you',
    description: 'Someone asked you something in Chat and it has been waiting for hours.'
  },
  {
    id: 'rollup',
    label: 'Weekly review',
    description: 'On Friday afternoon: meetings, finished work and what is still open.'
  }
]
