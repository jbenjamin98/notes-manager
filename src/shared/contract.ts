import { z } from 'zod'
import type { InvokeChannel, EventChannel } from './channels'

export const SettingsSchema = z.object({
  /** Folder synced by Google Drive Desktop. Empty until first-run selection. */
  vaultPath: z.string().default(''),
  /** Names that mean "me" in `@Owner` fields (case-insensitive). */
  meAliases: z.array(z.string()).default(['Me']),
  timezone: z.string().default('America/New_York'),
  workHours: z
    .object({ start: z.string(), end: z.string() })
    .default({ start: '08:00', end: '18:00' }),
  /** Default task effort (minutes) for capacity warnings when `est:` is absent. */
  defaultTaskMinutes: z.number().int().positive().default(30),
  /** Proactive nudges (morning brief, meeting prep, follow-ups...). All rules are deterministic and local. */
  nudges: z
    .object({
      enabled: z.boolean().default(true),
      /** Pop up Windows notifications (the feed in the app always gets them). */
      toasts: z.boolean().default(true),
      /** Also notify outside work hours and on weekends (time-critical nudges always notify). */
      afterHours: z.boolean().default(false),
      /** Per-rule switches; a missing rule is on. */
      rules: z.record(z.string(), z.boolean()).default({}),
      eodTime: z.string().default('16:45')
    })
    .default({ enabled: true, toasts: true, afterHours: false, rules: {}, eodTime: '16:45' }),
  /** Closing the window keeps the app in the system tray so nudges still arrive. */
  runInBackground: z.boolean().default(true),
  /** Start (hidden, in the tray) when I sign in to Windows. Per-user: no admin needed. */
  startAtLogin: z.boolean().default(false),
  /** Read Gmail metadata (subjects, senders, labels) into the local index for follow-ups. */
  gmailEnabled: z.boolean().default(true),
  /** How far back the first full mail crawl reads (days). */
  gmailDays: z.number().int().min(7).max(180).default(30),
  /** How picky to be about which mail needs you: balanced shows likely-useful mail too. */
  gmailImportance: z.enum(['balanced', 'strict']).default('balanced'),
  /** Per Gmail label: ignore it, show counts only, or turn its mail into task suggestions. */
  gmailLabels: z.record(z.string(), z.enum(['ignore', 'info', 'tasks'])).default({}),
  /** The first-run setup guide has been finished or skipped. */
  setupDone: z.boolean().default(false),
  /** Which Google source the user chose: their own Apps Script web app ("script") or Google sign-in ("oauth"). */
  google: z
    .object({
      // Older settings files say 'session' / 'api'; they mean 'script' / 'oauth'.
      method: z
        .preprocess(
          (v) => (v === 'session' ? 'script' : v === 'api' ? 'oauth' : v),
          z.enum(['script', 'oauth'])
        )
        .default('script'),
      clientId: z.string().default(''),
      /** Your Apps Script web-app address (the secondary source, for accounts that cannot use OAuth). */
      bridgeUrl: z.string().default(''),
      meetNotes: z.boolean().default(true),
      /** Copy the whole Gemini document into the meeting note (default: key points and a Drive link). */
      meetFullText: z.boolean().default(false),
      /** Read the text of recent email threads (in memory only) to find actions and decisions. */
      readMailBodies: z.boolean().default(true),
      chat: z.boolean().default(false)
    })
    .default({
      method: 'script',
      clientId: '',
      bridgeUrl: '',
      meetNotes: true,
      meetFullText: false,
      readMailBodies: true,
      chat: false
    }),
  assistant: z
    .object({
      persona: z.enum(['nova', 'pip', 'sage', 'rook']).default('nova'),
      /** The assistant messages you on its own (brief, meeting heads-up, overdue, reply owed, wrap-up). */
      proactive: z.boolean().default(true)
    })
    .default({ persona: 'nova', proactive: true }),
  /** Writing the missing @ and # into what you type. */
  autoTag: z
    .object({
      enabled: z.boolean().default(true),
      /** Let a small AI model also find new topics and names. */
      ai: z.boolean().default(true),
      /** Lowercase words never to tag. */
      ignore: z.array(z.string().max(60)).max(500).default([]),
      /** What you said a name is (lowercase name -> kind), remembered from corrections. */
      kinds: z.record(z.string().max(60), z.string().max(20)).default({}),
      /** Topics you accepted from Suggested Tags: tagged even before a note uses them. */
      topics: z.array(z.string().max(60)).max(500).default([]),
      /** Names you deleted (lowercase): never listed, linked or tagged again. */
      hidden: z.array(z.string().max(60)).max(1000).default([])
    })
    .default({ enabled: true, ai: true, ignore: [], kinds: {}, topics: [], hidden: [] }),
  /** Global quick-capture window (works from any app). */
  quickCapture: z
    .object({
      enabled: z.boolean().default(true),
      hotkey: z.string().default('CommandOrControl+Shift+Space')
    })
    .default({ enabled: true, hotkey: 'CommandOrControl+Shift+Space' }),
  llm: z
    .object({
      enabled: z.boolean().default(true),
      /** Optional model-name overrides (free-tier model names change). */
      models: z.record(z.string(), z.record(z.string(), z.string())).default({}),
      /** How much AI to use: light (fewest tokens), normal, or heavy (most thorough). */
      mode: z.enum(['light', 'normal', 'heavy']).default('normal'),
      /** Most tokens the app may spend per day (0 = no limit). */
      dailyTokenBudget: z.number().int().min(0).max(5_000_000).default(60_000),
      /** Providers switched off by the user (their keys stay saved). */
      disabled: z.array(z.string()).default([]),
      /** Provider preference order; providers not listed follow in the default order. */
      order: z.array(z.string()).default([])
    })
    .default({
      enabled: true,
      models: {},
      mode: 'normal',
      dailyTokenBudget: 60_000,
      disabled: [],
      order: []
    })
})
export type Settings = z.infer<typeof SettingsSchema>

/** Settings groups that are merged field by field on update (records like gmailLabels are replaced). */
export const MERGED_SETTINGS = [
  'workHours',
  'nudges',
  'google',
  'llm',
  'assistant',
  'quickCapture',
  'autoTag'
] as const
type Merged = (typeof MERGED_SETTINGS)[number]
/**
 * A settings change. Groups are patched field by field so one screen can never overwrite another
 * screen's fields (for example the script address) with a stale copy.
 */
export type SettingsPatch = { [K in Exclude<keyof Settings, Merged>]?: Settings[K] } & {
  [K in Merged]?: Partial<Settings[K]>
}
export const SettingsPatchSchema = z.custom<SettingsPatch>(
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  'Expected a settings object'
)

const AppInfo = z.object({
  version: z.string(),
  electron: z.string(),
  node: z.string(),
  platform: z.string(),
  userDataPath: z.string()
})

const DbHealth = z.object({
  sqliteVersion: z.string(),
  schemaVersion: z.number(),
  ftsOk: z.boolean(),
  path: z.string()
})

const CalendarStatus = z.object({
  state: z.enum(['idle', 'syncing', 'needs-auth', 'error']),
  lastSyncAt: z.string().nullable(),
  error: z.string().nullable()
})
export type CalendarStatus = z.infer<typeof CalendarStatus>

const UpcomingEvent = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  status: z.string().nullable(),
  notePath: z.string().nullable()
})
export type UpcomingEvent = z.infer<typeof UpcomingEvent>

const GmailStatus = z.object({
  state: z.enum(['idle', 'syncing', 'needs-auth', 'error']),
  lastSyncAt: z.string().nullable(),
  error: z.string().nullable(),
  threads: z.number(),
  health: z.enum(['ok', 'degraded']),
  healthDetail: z.string().nullable(),
  lastRead: z.number(),
  lastPages: z.number(),
  partial: z.boolean(),
  lastFull: z.boolean()
})
export type GmailStatus = z.infer<typeof GmailStatus>

const LabelHandler = z.enum(['ignore', 'info', 'tasks'])
export type LabelHandler = z.infer<typeof LabelHandler>

const ThreadItem = z.object({
  id: z.string(),
  linkId: z.string().nullable(),
  subject: z.string(),
  snippet: z.string(),
  senderName: z.string().nullable(),
  senderEmail: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  unread: z.boolean(),
  starred: z.boolean(),
  labels: z.array(z.string()),
  taskAdded: z.boolean(),
  taskText: z.string(),
  /** How much it matters (see importance.ts) and why. */
  score: z.number().optional(),
  level: z.enum(['important', 'maybe', 'noise']).optional(),
  reasons: z.array(z.string()).optional()
})
export type ThreadItem = z.infer<typeof ThreadItem>

const GmailOverview = z.object({
  awaitingMe: z.array(ThreadItem),
  awaitingMeTotal: z.number(),
  /** Mail that looks unimportant (bulk, copied, old): kept out of the way. */
  hidden: z.array(ThreadItem),
  hiddenTotal: z.number(),
  needsReply: z.array(ThreadItem),
  starred: z.array(ThreadItem),
  groups: z.array(
    z.object({
      label: z.string(),
      unread: z.number(),
      total: z.number(),
      threads: z.array(ThreadItem)
    })
  ),
  info: z.array(z.object({ label: z.string(), unread: z.number(), total: z.number() })),
  attention: z.number(),
  stats: z.object({
    stored: z.number(),
    kept: z.number(),
    dropped: z.record(z.string(), z.number()),
    keptBy: z.record(z.string(), z.number())
  })
})
export type GmailOverview = z.infer<typeof GmailOverview>

const NudgeAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open-event'), id: z.string(), label: z.string() }),
  z.object({ type: z.literal('open-prep'), id: z.string(), label: z.string() }),
  z.object({ type: z.literal('open-note'), path: z.string(), label: z.string() }),
  z.object({ type: z.literal('open-tasks'), filter: z.string(), label: z.string() }),
  z.object({ type: z.literal('open-email'), label: z.string() }),
  z.object({ type: z.literal('open-chat'), label: z.string() }),
  z.object({ type: z.literal('open-rollup'), label: z.string() })
])
export type NudgeAction = z.infer<typeof NudgeAction>

const NudgeItem = z.object({
  id: z.string(),
  rule: z.enum([
    'brief',
    'prep',
    'empty-note',
    'overload',
    'followup',
    'blocker',
    'eod',
    'reminder',
    'rollup',
    'chat'
  ]),
  title: z.string(),
  body: z.string(),
  actions: z.array(NudgeAction),
  status: z.enum(['new', 'read', 'dismissed', 'snoozed']),
  createdAt: z.string()
})
export type NudgeItem = z.infer<typeof NudgeItem>

export const ThemeMode = z.enum(['system', 'light', 'dark'])
export type ThemeMode = z.infer<typeof ThemeMode>

const VaultStatus = z.object({
  root: z.string(),
  notes: z.number(),
  tasksOpen: z.number(),
  tasksDone: z.number()
})

const NoteSummary = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  type: z.enum(['meeting', 'adhoc', 'inbox']),
  date: z.string(),
  account: z.string().nullable(),
  openTasks: z.number(),
  isConflict: z.boolean()
})
export type NoteSummary = z.infer<typeof NoteSummary>

const TaskRow = z.object({
  id: z.string(),
  description: z.string(),
  owner: z.string(),
  isMine: z.boolean(),
  due: z.string().nullable(),
  priority: z.enum(['High', 'Medium', 'Low']).nullable(),
  estMinutes: z.number().nullable(),
  status: z.enum(['open', 'completed']),
  /** Owner / due date were detected from the wording, not typed. */
  autoOwner: z.boolean(),
  autoDue: z.boolean(),
  /** The insight this task came from, and a readable name for it ("Chat · Priya · Nov 14"). */
  sourceId: z.string().nullable().default(null),
  sourceLabel: z.string().nullable().default(null)
})
export type TaskRow = z.infer<typeof TaskRow>

const TaskItem = TaskRow.extend({
  since: z.string(),
  completedAt: z.string().nullable(),
  notePath: z.string(),
  noteTitle: z.string(),
  account: z.string().nullable(),
  /** The people, companies, places, projects and systems the task is about (it is still yours). */
  entities: z.array(z.object({ id: z.string(), name: z.string(), category: z.string() })).optional()
})
export type TaskItem = z.infer<typeof TaskItem>

export const EntityCategory = z.enum([
  'person',
  'customer',
  'system',
  'project',
  'place',
  'event',
  'topic'
])
export type EntityCategory = z.infer<typeof EntityCategory>
export const RegCategory = z.enum(['person', 'customer', 'system', 'project', 'place'])

export const EntitySuggestion = z.object({
  kind: z.enum(['merge', 'category']),
  category: EntityCategory,
  /** merge: suggested canonical name first. category: the one name. */
  names: z.array(z.string()),
  /** category: where it probably belongs. */
  to: RegCategory.nullable(),
  reason: z.string(),
  score: z.number(),
  ambiguous: z.boolean()
})
export type EntitySuggestion = z.infer<typeof EntitySuggestion>

const EntitySummary = z.object({
  id: z.string(),
  name: z.string(),
  category: EntityCategory,
  inRegistry: z.boolean(),
  notes: z.number(),
  mentions: z.number(),
  lastDate: z.string().nullable()
})
export type EntitySummary = z.infer<typeof EntitySummary>

const Dossier = z.object({
  id: z.string(),
  name: z.string(),
  category: EntityCategory,
  inRegistry: z.boolean(),
  aliases: z.array(z.string()),
  notes: z.array(
    z.object({
      path: z.string(),
      title: z.string(),
      date: z.string(),
      account: z.string().nullable(),
      mentions: z.number(),
      snippet: z.string()
    })
  ),
  weeks: z.array(z.object({ weekStart: z.string(), notes: z.number() })),
  totalNotes: z.number(),
  totalMentions: z.number(),
  tasks: z.array(TaskItem)
})
export type Dossier = z.infer<typeof Dossier>

const Insights = z.object({
  days: z.number().nullable(),
  notes: z.number(),
  words: z.array(z.object({ word: z.string(), count: z.number(), notes: z.number() })),
  nodes: z.array(
    z.object({ id: z.string(), name: z.string(), category: EntityCategory, notes: z.number() })
  ),
  edges: z.array(z.object({ a: z.string(), b: z.string(), weight: z.number() }))
})
export type Insights = z.infer<typeof Insights>

const NoteEntity = z.object({
  id: z.string(),
  name: z.string(),
  category: EntityCategory,
  mentions: z.number()
})
export type NoteEntity = z.infer<typeof NoteEntity>

const VocabEntry = z.object({
  id: z.string(),
  name: z.string(),
  category: EntityCategory,
  terms: z.array(z.string()),
  /** true = match the exact capitalisation (discovered names); false = case-insensitive (registry). */
  exact: z.boolean(),
  /** Tagged, but needs to be reviewed (a name shared by two people). */
  review: z.boolean().optional()
})
export type VocabEntry = z.infer<typeof VocabEntry>

const PrepDossier = z.object({
  /** Documents attached to the invite. */
  attachments: z
    .array(z.object({ fileId: z.string(), title: z.string(), url: z.string() }))
    .default([]),
  event: z.object({
    id: z.string(),
    title: z.string(),
    date: z.string(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    meetUrl: z.string().nullable(),
    notePath: z.string().nullable(),
    detailFetched: z.boolean()
  }),
  attendees: z.array(
    z.object({
      email: z.string(),
      name: z.string(),
      personId: z.string().nullable(),
      theyOwe: z.number(),
      lastNoteDate: z.string().nullable(),
      recentEmails: z.number()
    })
  ),
  series: z.object({
    previous: z.array(
      z.object({ path: z.string(), title: z.string(), date: z.string(), openTasks: z.number() })
    ),
    questions: z.array(z.string()),
    openTasks: z.array(TaskItem)
  }),
  attendeeTasks: z.array(TaskItem),
  account: z.string().nullable(),
  accountTasks: z.array(TaskItem),
  emails: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      from: z.string(),
      when: z.string().nullable(),
      starred: z.boolean()
    })
  )
})
export type PrepDossier = z.infer<typeof PrepDossier>

const DayData = z.object({
  date: z.string(),
  events: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      startTime: z.string().nullable(),
      endTime: z.string().nullable(),
      status: z.string().nullable(),
      notePath: z.string().nullable()
    })
  ),
  notes: z.array(z.object({ path: z.string(), title: z.string() })),
  due: z.object({ count: z.number(), high: z.number() })
})
export type DayData = z.infer<typeof DayData>

const ProposalStatus = z.enum(['pending', 'applied', 'dismissed'])
export const Proposal = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task'),
    description: z.string(),
    owner: z.string(),
    ownerExplicit: z.boolean(),
    due: z.string().nullable(),
    dueNote: z.string().nullable(),
    priority: z.enum(['High', 'Medium', 'Low']).nullable(),
    estMinutes: z.number().nullable(),
    status: ProposalStatus,
    appliedPath: z.string().nullable()
  }),
  z.object({
    kind: z.literal('note'),
    title: z.string(),
    noteKind: z.enum(['meeting', 'adhoc']),
    date: z.string(),
    account: z.string().nullable(),
    body: z.string(),
    status: ProposalStatus,
    appliedPath: z.string().nullable()
  }),
  z.object({
    kind: z.literal('reminder'),
    text: z.string(),
    /** Local time, YYYY-MM-DDTHH:mm. Null until the user picks one. */
    at: z.string().nullable(),
    atNote: z.string().nullable(),
    status: ProposalStatus
  }),
  z.object({
    kind: z.literal('email'),
    to: z.string().nullable(),
    subject: z.string(),
    body: z.string(),
    status: ProposalStatus
  })
])
export type Proposal = z.infer<typeof Proposal>

const Citation = z.object({
  n: z.number(),
  path: z.string(),
  title: z.string(),
  date: z.string(),
  heading: z.string().nullable()
})
export type Citation = z.infer<typeof Citation>

const ChatMessage = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string(),
  proposals: z.array(Proposal),
  citations: z.array(Citation),
  /** Plain-language note about how this answer was made ("Answered on your computer", "Offline answer"). */
  notice: z.string().nullable(),
  via: z.enum(['llm', 'local']).nullable(),
  /** Questions or actions the user might want next. `Label::action:arg` runs an action. */
  followups: z.array(z.string()),
  /** chat, or why the assistant spoke up on its own. */
  kind: z.enum(['chat', 'brief', 'pre_meeting', 'overdue', 'nudge']),
  unread: z.boolean()
})
export type ChatMessage = z.infer<typeof ChatMessage>

export const ProviderIdSchema = z.enum(['gemini', 'groq', 'openai', 'anthropic', 'openrouter'])
export type ProviderIdName = z.infer<typeof ProviderIdSchema>

const LlmProviderStatus = z.object({
  id: ProviderIdSchema,
  label: z.string(),
  blurb: z.string(),
  keyUrl: z.string(),
  /** Billed to the user's own account. */
  paid: z.boolean(),
  hasKey: z.boolean(),
  enabled: z.boolean(),
  state: z.enum(['ready', 'cooldown', 'auth-failed', 'no-key', 'disabled']),
  until: z.number().nullable(),
  lastError: z.string().nullable(),
  models: z.object({ extract: z.string(), chat: z.string() }),
  modelsCustom: z.boolean(),
  usage: z.object({
    lastMinute: z.number(),
    today: z.number(),
    failedToday: z.number(),
    tokensToday: z.number()
  }),
  limits: z
    .object({
      remainingRequests: z.number().nullable(),
      limitRequests: z.number().nullable(),
      remainingTokens: z.number().nullable(),
      limitTokens: z.number().nullable(),
      seenAt: z.number()
    })
    .nullable()
})
export const LlmStatus = z.object({
  enabled: z.boolean(),
  budget: z.object({ used: z.number(), limit: z.number() }),
  /** Tokens spent today by purpose. */
  usage: z.array(z.object({ feature: z.string(), tokens: z.number() })).default([]),
  canStoreKeys: z.boolean(),
  providers: z.array(LlmProviderStatus)
})
export type LlmStatus = z.infer<typeof LlmStatus>

const RollupTask = z.object({
  id: z.string(),
  description: z.string(),
  owner: z.string(),
  due: z.string().nullable(),
  priority: z.enum(['High', 'Medium', 'Low']).nullable(),
  notePath: z.string(),
  noteTitle: z.string(),
  completedAt: z.string().nullable()
})
export const Rollup = z.object({
  weekStart: z.string(),
  weekEnd: z.string(),
  notes: z.array(
    z.object({
      path: z.string(),
      title: z.string(),
      date: z.string(),
      account: z.string().nullable(),
      type: z.enum(['meeting', 'adhoc'])
    })
  ),
  completed: z.array(RollupTask),
  createdCount: z.number(),
  overdue: z.array(RollupTask),
  comingUp: z.array(RollupTask),
  waitingOn: z.array(z.object({ owner: z.string(), count: z.number() })),
  accounts: z.array(z.object({ account: z.string(), notes: z.number() })),
  people: z.array(z.object({ name: z.string(), notes: z.number() })),
  markdown: z.string()
})
export type Rollup = z.infer<typeof Rollup>

export const GoogleStatus = z.object({
  method: z.enum(['script', 'oauth']),
  hasClient: z.boolean(),
  /** The app ships with the organisation's sign-in: nothing to paste. */
  defaultClient: z.boolean().default(false),
  connected: z.boolean(),
  email: z.string().nullable(),
  scopes: z.object({
    calendar: z.boolean(),
    gmail: z.boolean(),
    meet: z.boolean(),
    chat: z.boolean()
  }),
  lastError: z.string().nullable(),
  meet: z.object({ files: z.number(), lastAt: z.string().nullable() }),
  chat: z.object({ messages: z.number(), lastAt: z.string().nullable() })
})
export type GoogleStatus = z.infer<typeof GoogleStatus>

export const BridgeStatus = z.object({
  configured: z.boolean(),
  url: z.string(),
  hasToken: z.boolean(),
  /** Version of the script bundled with this app; the deployed one must be at least MIN. */
  bundledVersion: z.number()
})
export type BridgeStatus = z.infer<typeof BridgeStatus>
export const BridgeVerify = z.object({
  ok: z.boolean(),
  email: z.string().nullable(),
  version: z.number().nullable(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  sections: z.array(z.object({ name: z.string(), ok: z.boolean(), error: z.string().nullable() }))
})
export type BridgeVerify = z.infer<typeof BridgeVerify>

const ChatReason = z.enum([
  'dm',
  'mention',
  'reply-to-me',
  'question',
  'deadline',
  'topic',
  'frequent',
  'recent',
  'unanswered'
])
export const ChatConversation = z.object({
  key: z.string(),
  space: z.string(),
  spaceName: z.string(),
  spaceType: z.string(),
  title: z.string(),
  lastAt: z.string(),
  lastText: z.string(),
  lastSender: z.string(),
  lastFromMe: z.boolean(),
  messages: z.number(),
  score: z.number(),
  reasons: z.array(ChatReason),
  bucket: z.enum(['needs-you', 'waiting', 'fyi', 'noise']),
  ageHours: z.number(),
  awaitingMeHours: z.number(),
  awaitingThemHours: z.number()
})
export type ChatConversation = z.infer<typeof ChatConversation>
export const ChatOverview = z.object({
  conversations: z.array(ChatConversation),
  commitments: z.array(
    z.object({ convKey: z.string(), spaceName: z.string(), text: z.string(), at: z.string() })
  ),
  spaces: z.array(
    z.object({
      space: z.string(),
      name: z.string(),
      type: z.string(),
      mode: z.enum(['auto', 'track', 'mentions', 'ignore'])
    })
  ),
  /** Where the messages come from and how complete that is. */
  source: z.enum(['api', 'bridge', 'none']),
  complete: z.boolean(),
  lastAt: z.string().nullable()
})
export type ChatOverview = z.infer<typeof ChatOverview>

export const GoogleConnection = z.object({
  source: z.enum(['api', 'bridge', 'none']),
  state: z.enum([
    'ok',
    'syncing',
    'not-set-up',
    'missing-key',
    'needs-login',
    'needs-update',
    'busy',
    'error'
  ]),
  label: z.string(),
  detail: z.string(),
  action: z.enum(['setup', 'sign-in', 'copy-script', 'refresh']).nullable(),
  actionLabel: z.string().nullable(),
  email: z.string().nullable(),
  lastSyncAt: z.string().nullable()
})
export type GoogleConnection = z.infer<typeof GoogleConnection>

export const GoogleHealth = z.object({
  rows: z.array(
    z.object({
      section: z.enum(['calendar', 'mail', 'meet', 'chat']),
      label: z.string(),
      source: z.enum(['api', 'bridge', 'none']),
      state: z.enum(['healthy', 'syncing', 'needs-login', 'degraded', 'partial', 'off']),
      lastAt: z.string().nullable(),
      detail: z.string()
    })
  )
})
export type GoogleHealth = z.infer<typeof GoogleHealth>

export const InsightKind = z.enum([
  'action',
  'ask',
  'promise',
  'decision',
  'question',
  'risk',
  'change',
  'fact'
])
export const InsightItem = z.object({
  id: z.string(),
  kind: InsightKind,
  text: z.string(),
  owner: z.string().nullable(),
  due: z.string().nullable(),
  confidence: z.number(),
  status: z.enum(['new', 'accepted', 'dismissed']),
  sourceType: z.enum(['meeting', 'email', 'chat', 'note']),
  /** "Chat · Priya · Nov 14": a readable pointer back to where it came from. */
  sourceLabel: z.string(),
  sourceSnippet: z.string(),
  sourceAt: z.string().nullable(),
  entities: z.array(z.string()),
  /** Yours to do (no owner, or one of your names). Others' actions are saved as Waiting On. */
  mine: z.boolean().default(true)
})
export type InsightItem = z.infer<typeof InsightItem>

const NotePath = z.object({ path: z.string() })
const NoteContent = z.object({ content: z.string(), hash: z.string() })
const SaveResult = z.object({ ok: z.boolean(), content: z.string(), hash: z.string() })

/** channel -> { input schema, output schema }. Add new IPC here first. */
export const contract = {
  'app:info': { input: z.void(), output: AppInfo },
  'settings:get': { input: z.void(), output: SettingsSchema },
  'settings:update': { input: SettingsPatchSchema, output: SettingsSchema },
  'vault:choose-folder': { input: z.void(), output: z.string().nullable() },
  'db:health': { input: z.void(), output: DbHealth },
  'vault:status': { input: z.void(), output: VaultStatus },
  'tasks:toggle': { input: z.object({ id: z.string(), done: z.boolean() }), output: z.boolean() },
  'tasks:for-note': { input: NotePath, output: z.array(TaskRow) },
  'tasks:list': { input: z.void(), output: z.array(TaskItem) },
  'tasks:quick-add': {
    input: z.object({ text: z.string().max(500) }),
    output: z.object({
      /** 'waiting' = it was for someone else, so it became a Waiting On note line. */
      kind: z.enum(['task', 'waiting']).default('task'),
      path: z.string(),
      description: z.string(),
      owner: z.string(),
      due: z.string().nullable()
    })
  },
  'names:review': {
    input: z.void(),
    output: z.array(
      z.object({
        short: z.string(),
        candidates: z.array(
          z.object({ name: z.string(), notes: z.number(), category: z.string().default('person') })
        ),
        mentions: z.array(
          z.object({
            path: z.string(),
            title: z.string(),
            date: z.string(),
            snippet: z.string(),
            count: z.number()
          })
        )
      })
    )
  },
  /** Assign a short name in these notes to a person (a new one is added to People). */
  'names:assign': {
    input: z.object({
      paths: z.array(z.string()).min(1).max(500),
      short: z.string().min(1).max(80),
      person: z.string().min(1).max(120),
      /** What a new name is (default person). */
      category: z.enum(['person', 'customer', 'project', 'system', 'place']).optional()
    }),
    output: z.number()
  },
  'names:unassign': {
    input: z.object({ paths: z.array(z.string()).min(1).max(500), short: z.string().min(1) }),
    output: z.number()
  },
  'waiting:list': {
    input: z.void(),
    output: z.array(
      z.object({
        who: z.string(),
        text: z.string(),
        due: z.string().nullable(),
        line: z.string(),
        notePath: z.string(),
        noteTitle: z.string(),
        since: z.string(),
        done: z.boolean()
      })
    )
  },
  'waiting:done': {
    input: z.object({ path: z.string(), line: z.string() }),
    output: z.boolean()
  },
  'tasks:set-due': {
    input: z.object({
      id: z.string(),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
    }),
    output: z.boolean()
  },
  'entities:list': { input: z.void(), output: z.array(EntitySummary) },
  'entities:vocabulary': { input: z.void(), output: z.array(VocabEntry) },
  /** Everything that can be auto-tagged: your lists plus topics, without your own or shared names. */
  'tags:vocabulary': { input: z.void(), output: z.array(VocabEntry) },
  /** Ask the small model for new topics and names in one line you just wrote. */
  'tags:suggest': {
    input: z.object({ line: z.string().min(1).max(600) }),
    output: z.object({
      tags: z.array(
        z.object({
          /** The exact words in the line. */
          text: z.string(),
          kind: z.enum(['topic', 'person', 'customer', 'project', 'system', 'place']),
          maybe: z.boolean().optional()
        })
      ),
      via: z.enum(['llm', 'rules', 'none'])
    })
  },
  /** Add new names to your lists (so the tag you write is understood). */
  /** Tag a note you wrote before auto-tagging: returns what changed and the original text (for undo). */
  'tags:tag-note': {
    input: z.object({ path: z.string() }),
    output: z.object({ count: z.number(), before: z.string().nullable() })
  },
  /** Names and topics that keep coming up but are not tagged yet (counted, no model). */
  'tags:discover': {
    input: z.void(),
    output: z.array(
      z.object({
        text: z.string(),
        kind: z.enum(['topic', 'person', 'customer', 'project', 'system', 'place']),
        notes: z.number(),
        example: z.string()
      })
    )
  },
  'tags:usage': {
    input: z.void(),
    output: z.object({ today: z.number(), cap: z.number() })
  },
  /** What happened to automatic tags (kept, accepted from a maybe, taken off). */
  'tags:event': {
    input: z.object({
      events: z
        .array(
          z.object({
            word: z.string().min(1).max(80),
            sigil: z.enum(['@', '#']),
            action: z.enum(['tagged', 'accepted', 'rejected'])
          })
        )
        .max(50)
    }),
    output: z.null()
  },
  'tags:health': {
    input: z.void(),
    output: z.object({
      words: z.array(
        z.object({
          word: z.string(),
          sigil: z.string(),
          tagged: z.number(),
          accepted: z.number(),
          rejected: z.number(),
          ignored: z.boolean()
        })
      ),
      tagged: z.number(),
      accepted: z.number(),
      rejected: z.number()
    })
  },
  'tags:learn': {
    input: z.object({
      names: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(120),
            category: z.enum(['person', 'customer', 'project', 'system', 'place'])
          })
        )
        .max(10)
    }),
    output: z.null()
  },
  'notes:entities': { input: NotePath, output: z.array(NoteEntity) },
  'entities:detail': { input: z.object({ id: z.string() }), output: Dossier },
  'entities:upsert': {
    input: z.object({
      category: RegCategory,
      name: z.string().trim().min(1).max(120),
      aliases: z.array(z.string().trim().min(1).max(120)).max(30),
      originalName: z.string().optional()
    }),
    output: z.null()
  },
  'entities:manage-list': {
    input: z.void(),
    output: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        category: EntityCategory,
        inRegistry: z.boolean(),
        notes: z.number(),
        mentions: z.number(),
        lastDate: z.string().nullable(),
        aliases: z.array(z.string()),
        ambiguous: z.boolean()
      })
    )
  },
  'entities:merge': {
    input: z.object({
      category: RegCategory,
      canonical: z.string().trim().min(1).max(120),
      others: z.array(z.string().trim().min(1).max(120)).min(1).max(30)
    }),
    output: z.null()
  },
  'entities:recategorize': {
    input: z.object({
      from: EntityCategory,
      to: RegCategory,
      name: z.string().trim().min(1).max(120)
    }),
    output: z.null()
  },
  'entities:not-same': {
    input: z.object({ a: z.string().trim().min(1).max(120), b: z.string().trim().min(1).max(120) }),
    output: z.null()
  },
  'entities:ambiguous': {
    input: z.object({ name: z.string().trim().min(1).max(120), on: z.boolean() }),
    output: z.null()
  },
  'entities:suggestions': { input: z.void(), output: z.array(EntitySuggestion) },
  'entities:ai-suggest': {
    input: z.void(),
    output: z.object({
      suggestions: z.array(EntitySuggestion),
      via: z.enum(['llm', 'local']),
      notice: z.string().nullable()
    })
  },
  'entities:remove': {
    input: z.object({ category: RegCategory, name: z.string() }),
    output: z.null()
  },
  'insights:analyze': {
    input: z.object({ days: z.number().int().positive().max(3650).nullable() }),
    output: Insights
  },
  'notes:search': {
    input: z.object({ query: z.string().max(200) }),
    output: z.array(z.string())
  },
  'app:diagnostics': { input: z.void(), output: z.string() },
  'app:backup': { input: z.void(), output: z.object({ path: z.string() }).nullable() },
  'app:open-logs': { input: z.void(), output: z.null() },
  'mail:clear': { input: z.void(), output: z.null() },
  'notes:entity-map': {
    input: z.void(),
    output: z.array(
      z.object({
        path: z.string(),
        entities: z.array(z.object({ id: z.string(), name: z.string(), category: EntityCategory }))
      })
    )
  },
  'notes:list': { input: z.void(), output: z.array(NoteSummary) },
  'notes:read': { input: NotePath, output: NoteContent },
  /** Move a note to the Recycle Bin. */
  'notes:delete': { input: NotePath, output: z.null() },
  /** Delete a name (person, company, topic...): it is no longer listed or tagged. Notes are not changed. */
  'entities:hide': {
    input: z.object({
      name: z.string().min(1).max(60),
      category: z.string().max(20).optional(),
      on: z.boolean()
    }),
    output: z.null()
  },
  'notes:save': {
    input: z.object({ path: z.string(), content: z.string(), baseHash: z.string() }),
    output: SaveResult
  },
  'notes:force-save': {
    input: z.object({ path: z.string(), content: z.string() }),
    output: SaveResult
  },
  'notes:create': {
    input: z.object({
      kind: z.enum(['meeting', 'adhoc']),
      title: z.string().min(1).max(120),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      account: z.string().optional()
    }),
    output: NotePath
  },
  'notes:quick-note': {
    input: z.object({ text: z.string().min(1).max(20000) }),
    output: NotePath
  },
  'notes:set-title': {
    input: z.object({ path: z.string(), title: z.string().min(1).max(120) }),
    output: NotePath
  },
  'calendar:status': { input: z.void(), output: CalendarStatus },
  'calendar:sync': { input: z.void(), output: CalendarStatus },
  'calendar:upcoming': { input: z.void(), output: z.array(UpcomingEvent) },
  'calendar:open-event': { input: z.object({ id: z.string() }), output: NotePath },
  /** Meetings held again and again, each session still its own note. */
  'meetings:series': {
    input: z.void(),
    output: z.array(
      z.object({
        key: z.string(),
        title: z.string(),
        sessions: z.number(),
        lastDate: z.string(),
        nextDate: z.string().nullable(),
        openActions: z.number()
      })
    )
  },
  'meetings:series-detail': {
    input: z.object({ key: z.string().min(1).max(200) }),
    output: z
      .object({
        key: z.string(),
        title: z.string(),
        account: z.string().nullable(),
        attendees: z.array(z.string()),
        sessions: z.array(
          z.object({
            date: z.string(),
            title: z.string(),
            path: z.string().nullable(),
            eventId: z.string().nullable(),
            status: z.enum(['notes', 'scheduled', 'no-notes'])
          })
        ),
        carried: z.array(
          z.object({
            id: z.string(),
            description: z.string(),
            due: z.string().nullable(),
            date: z.string(),
            path: z.string()
          })
        ),
        decisions: z.array(z.object({ text: z.string(), date: z.string(), path: z.string() })),
        questions: z.array(z.object({ text: z.string(), date: z.string(), path: z.string() })),
        threads: z.array(
          z.object({
            name: z.string(),
            category: z.string(),
            sessions: z.number(),
            lines: z.array(z.object({ text: z.string(), date: z.string(), path: z.string() }))
          })
        )
      })
      .nullable()
  },
  /** Meeting notes that could be added to a series. */
  'meetings:series-candidates': {
    input: z.object({ key: z.string().min(1).max(200) }),
    output: z.array(z.object({ path: z.string(), title: z.string(), date: z.string() }))
  },
  /** Put a meeting note into a series by hand (join), or take it out of every series. */
  'meetings:series-link': {
    input: z.object({
      key: z.string().min(1).max(200),
      path: z.string().min(1),
      join: z.boolean()
    }),
    output: z.object({ ok: z.boolean() })
  },
  /** A normal note that gathers the series: sessions, decisions, open questions. */
  'meetings:series-master': {
    input: z.object({ key: z.string().min(1).max(200) }),
    output: z.object({ path: z.string() })
  },
  /** Open the next session's note, with last time's open questions and actions listed. */
  'meetings:series-next': {
    input: z.object({ key: z.string().min(1).max(200) }),
    output: z.object({ path: z.string() })
  },
  'prep:get': {
    input: z.object({
      eventId: z.string(),
      refresh: z.boolean().optional(),
      /** Return what is already known instantly; never touch Google. */
      cacheOnly: z.boolean().optional()
    }),
    output: z.object({
      dossier: PrepDossier,
      /** ok = guests are known; needs-auth = sign in to Google to load them; failed = could not load them. */
      detail: z.enum(['ok', 'needs-auth', 'failed'])
    })
  },
  'calendar:range': {
    input: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    }),
    output: z.array(DayData)
  },
  'app:open-external': { input: z.object({ url: z.string().max(500) }), output: z.null() },
  'nudges:list': { input: z.void(), output: z.array(NudgeItem) },
  'nudges:unread': { input: z.void(), output: z.number() },
  'nudges:read': { input: z.object({ id: z.string().optional() }).optional(), output: z.null() },
  'nudges:dismiss': { input: z.object({ id: z.string() }), output: z.null() },
  'nudges:snooze': {
    input: z.object({ id: z.string(), minutes: z.number().int().min(5).max(2880).optional() }),
    output: z.null()
  },
  'nudges:test': {
    input: z.void(),
    output: z.object({
      supported: z.boolean(),
      shown: z.boolean(),
      error: z.string().nullable()
    })
  },
  'gmail:status': { input: z.void(), output: GmailStatus },
  'gmail:sync': {
    input: z.object({ full: z.boolean().optional() }).optional(),
    output: GmailStatus
  },
  'gmail:mutes': { input: z.void(), output: z.array(z.string()) },
  'gmail:mute': { input: z.object({ target: z.string().max(320) }), output: z.string() },
  'gmail:unmute': { input: z.object({ pattern: z.string() }), output: z.null() },
  /** Teach it: this sender's mail is important, or not. */
  'gmail:importance': {
    input: z.object({ id: z.string(), verdict: z.enum(['important', 'not-important']) }),
    output: z.object({ sender: z.string().nullable(), quieted: z.boolean() })
  },
  'gmail:importance-undo': {
    input: z.object({ id: z.string(), verdict: z.enum(['important', 'not-important']) }),
    output: z.null()
  },
  'gmail:overview': { input: z.void(), output: GmailOverview },
  'gmail:labels': {
    input: z.void(),
    output: z.array(z.object({ name: z.string(), seen: z.number(), handler: LabelHandler }))
  },
  'gmail:set-label': {
    input: z.object({ name: z.string().min(1), handler: LabelHandler }),
    output: z.null()
  },
  'gmail:dismiss': { input: z.object({ id: z.string() }), output: z.null() },
  'gmail:add-task': {
    input: z.object({ id: z.string(), text: z.string().max(300).optional() }),
    output: z.object({ description: z.string() })
  },
  'gmail:open-thread': { input: z.object({ id: z.string() }), output: z.null() },
  'gmail:compose': {
    input: z.object({
      to: z.string().max(320).optional(),
      subject: z.string().max(300),
      body: z.string().max(4000)
    }),
    output: z.null()
  },
  'gmail:guess-email': { input: z.object({ name: z.string() }), output: z.string().nullable() },
  'google:open-login': { input: z.void(), output: z.null() },
  'google:api-status': { input: z.void(), output: GoogleStatus },
  'google:api-configure': {
    input: z.object({
      clientId: z.string().max(300),
      clientSecret: z.string().max(300).optional()
    }),
    output: GoogleStatus
  },
  'google:bridge-status': { input: z.void(), output: BridgeStatus },
  'google:bridge-configure': {
    input: z.object({ url: z.string().max(600) }),
    output: BridgeStatus
  },
  'google:bridge-script': {
    input: z.void(),
    output: z.object({ script: z.string(), manifest: z.string() })
  },
  'google:bridge-verify': { input: z.void(), output: BridgeVerify },
  'google:repair': { input: z.void(), output: BridgeVerify },
  'google:health': { input: z.void(), output: GoogleHealth },
  'google:connection': { input: z.void(), output: GoogleConnection },
  'google:refresh': {
    input: z.void(),
    output: z.object({ ok: z.boolean(), message: z.string(), connection: GoogleConnection })
  },
  'inbox:list': { input: z.void(), output: z.array(InsightItem) },
  'inbox:accept': {
    input: z.object({
      id: z.string(),
      text: z.string().max(400).optional(),
      owner: z.string().max(80).nullable().optional(),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional()
    }),
    output: z.object({ kind: z.enum(['task', 'note', 'waiting']), path: z.string() })
  },
  'inbox:dismiss': { input: z.object({ id: z.string() }), output: z.null() },
  'inbox:open-source': {
    input: z.object({ id: z.string() }),
    output: z.object({ path: z.string().nullable() })
  },
  'inbox:refresh': { input: z.void(), output: z.object({ added: z.number() }) },
  'insights:for-entity': { input: z.object({ name: z.string() }), output: z.array(InsightItem) },
  'chat:overview': { input: z.void(), output: ChatOverview },
  'chat:feedback': {
    input: z.object({ key: z.string(), reasons: z.array(ChatReason), relevant: z.boolean() }),
    output: z.null()
  },
  'chat:set-mode': {
    input: z.object({ space: z.string(), mode: z.enum(['auto', 'track', 'mentions', 'ignore']) }),
    output: z.null()
  },
  'google:api-connect': { input: z.void(), output: GoogleStatus },
  'google:api-disconnect': { input: z.void(), output: GoogleStatus },
  'app:set-theme': { input: z.object({ mode: ThemeMode }), output: z.null() },
  'assistant:send': {
    input: z.object({
      text: z.string().min(1).max(8000),
      mode: z.enum(['auto', 'ask', 'capture']).optional(),
      /** Do not add the text to the chat as something you said (a button press, not a message). */
      quiet: z.boolean().optional()
    }),
    output: z.array(ChatMessage)
  },
  'assistant:action': {
    input: z.object({
      kind: z.enum([
        'summarize-note',
        'extract-actions',
        'draft-followup',
        'prep-brief',
        'week-update',
        'day-brief',
        'catch-up',
        'chat-digest'
      ]),
      path: z.string().optional(),
      eventId: z.string().optional(),
      weekStart: z.string().optional(),
      entityId: z.string().optional(),
      /** Do not keep this exchange in the chat history (used for the automatic Home brief). */
      ephemeral: z.boolean().optional(),
      /** Answer from rules on this computer first (no AI). Falls back to the AI when rules cannot. */
      quick: z.boolean().optional()
    }),
    output: z.array(ChatMessage)
  },
  'assistant:unread': { input: z.void(), output: z.number() },
  'assistant:mark-read': { input: z.void(), output: z.null() },
  'assistant:history': { input: z.void(), output: z.array(ChatMessage) },
  /** Example prompts for an empty Co-Pilot, made from the user's own notes. */
  'assistant:hints': { input: z.void(), output: z.array(z.string()) },
  'assistant:apply': {
    input: z.object({
      messageId: z.string(),
      index: z.number().int().min(0).max(30),
      edits: z.record(z.string(), z.unknown()).optional()
    }),
    output: ChatMessage
  },
  'assistant:dismiss': {
    input: z.object({ messageId: z.string(), index: z.number().int().min(0).max(30) }),
    output: ChatMessage
  },
  'assistant:clear': { input: z.void(), output: z.null() },
  'llm:status': { input: z.void(), output: LlmStatus },
  'llm:set-key': {
    input: z.object({ provider: ProviderIdSchema, key: z.string().max(300) }),
    output: LlmStatus
  },
  'capture:hide': { input: z.void(), output: z.null() },
  /** The capture window grows with the text (height in CSS pixels, clamped in main). */
  'capture:resize': {
    input: z.object({ height: z.number().int().min(100).max(600) }),
    output: z.null()
  },
  /** Too long for the small box: save it as a note and continue in the app. */
  'capture:handoff': { input: z.object({ text: z.string().min(1).max(20000) }), output: NotePath },
  'capture:status': {
    input: z.void(),
    output: z.object({ registered: z.boolean(), hotkey: z.string() })
  },
  'rollup:get': {
    input: z
      .object({
        weekStart: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
      })
      .optional(),
    output: Rollup
  },
  'rollup:save-note': {
    input: z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    output: NotePath
  },
  'llm:configure': {
    input: z.object({
      provider: ProviderIdSchema,
      enabled: z.boolean().optional(),
      move: z.enum(['up', 'down']).optional(),
      /** Empty string clears an override. */
      models: z.object({ extract: z.string().max(120), chat: z.string().max(120) }).optional()
    }),
    output: LlmStatus
  },
  'llm:test': {
    input: z.object({ provider: ProviderIdSchema.optional() }),
    output: z.object({ ok: z.boolean(), message: z.string() })
  }
} as const satisfies Record<InvokeChannel, { input: z.ZodType; output: z.ZodType }>

export const events = {
  'settings:changed': SettingsSchema,
  'vault:changed': z.object({ paths: z.array(z.string()) }),
  'calendar:changed': CalendarStatus,
  'gmail:changed': GmailStatus,
  'nudges:changed': z.object({ unread: z.number() }),
  'nudges:focus': z.object({ id: z.string().nullable() }),
  'assistant:changed': z.object({ unread: z.number() }),
  'assistant:focus': z.null(),
  'capture:shown': z.null(),
  'google:changed': GoogleConnection,
  /** What the assistant is doing right now ("Checking your calendar…"). */
  'assistant:progress': z.object({ label: z.string() }),
  'app:open-note': z.object({ path: z.string() })
} as const satisfies Record<EventChannel, z.ZodType>

export type Input<C extends InvokeChannel> = z.input<(typeof contract)[C]['input']>
export type Output<C extends InvokeChannel> = z.output<(typeof contract)[C]['output']>
export type EventPayload<E extends EventChannel> = z.output<(typeof events)[E]>

export type Result<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

/** Shape of `window.api`, implemented by the preload. */
export interface Api {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: undefined extends Input<C>
      ? [input?: Input<C>]
      : Input<C> extends void
        ? []
        : [input: Input<C>]
  ): Promise<Result<Output<C>>>
  on<E extends EventChannel>(event: E, listener: (payload: EventPayload<E>) => void): () => void
}
