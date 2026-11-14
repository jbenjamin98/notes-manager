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
      /** Per-rule switches; a missing rule is on. */
      rules: z.record(z.string(), z.boolean()).default({}),
      eodTime: z.string().default('16:45')
    })
    .default({ enabled: true, toasts: true, rules: {}, eodTime: '16:45' }),
  /** Closing the window keeps the app in the system tray so nudges still arrive. */
  runInBackground: z.boolean().default(true),
  /** Start (hidden, in the tray) when I sign in to Windows. Per-user: no admin needed. */
  startAtLogin: z.boolean().default(false),
  /** Read Gmail metadata (subjects, senders, labels) into the local index for follow-ups. */
  gmailEnabled: z.boolean().default(true),
  /** How far back the first full mail crawl reads (days). */
  gmailDays: z.number().int().min(7).max(180).default(30),
  /** Per Gmail label: ignore it, show counts only, or turn its mail into task suggestions. */
  gmailLabels: z.record(z.string(), z.enum(['ignore', 'info', 'tasks'])).default({}),
  /** The first-run setup guide has been finished or skipped. */
  setupDone: z.boolean().default(false),
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
      /** Notes tagged CUI are never sent to any LLM (see SPEC §7). */
      blockCui: z.boolean().default(true),
      /** Optional model-name overrides (free-tier model names change). */
      models: z.record(z.string(), z.record(z.string(), z.string())).default({}),
      /** Providers switched off by the user (their keys stay saved). */
      disabled: z.array(z.string()).default([]),
      /** Provider preference order; providers not listed follow in the default order. */
      order: z.array(z.string()).default([])
    })
    .default({ enabled: true, blockCui: true, models: {}, disabled: [], order: [] })
})
export type Settings = z.infer<typeof SettingsSchema>

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
  taskText: z.string()
})
export type ThreadItem = z.infer<typeof ThreadItem>

const GmailOverview = z.object({
  awaitingMe: z.array(ThreadItem),
  awaitingMeTotal: z.number(),
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
    'rollup'
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
  autoDue: z.boolean()
})
export type TaskRow = z.infer<typeof TaskRow>

const TaskItem = TaskRow.extend({
  since: z.string(),
  completedAt: z.string().nullable(),
  notePath: z.string(),
  noteTitle: z.string(),
  account: z.string().nullable()
})
export type TaskItem = z.infer<typeof TaskItem>

export const EntityCategory = z.enum(['person', 'customer', 'system', 'event', 'topic'])
export type EntityCategory = z.infer<typeof EntityCategory>
const RegCategory = z.enum(['person', 'customer', 'system'])

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
  exact: z.boolean()
})
export type VocabEntry = z.infer<typeof VocabEntry>

const PrepDossier = z.object({
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
  /** Plain-language note about how this answer was made ("Kept on this computer: CUI", "Offline answer"). */
  notice: z.string().nullable(),
  via: z.enum(['llm', 'local']).nullable()
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

const NotePath = z.object({ path: z.string() })
const NoteContent = z.object({ content: z.string(), hash: z.string() })
const SaveResult = z.object({ ok: z.boolean(), content: z.string(), hash: z.string() })

/** channel -> { input schema, output schema }. Add new IPC here first. */
export const contract = {
  'app:info': { input: z.void(), output: AppInfo },
  'settings:get': { input: z.void(), output: SettingsSchema },
  'settings:update': { input: SettingsSchema.partial(), output: SettingsSchema },
  'vault:choose-folder': { input: z.void(), output: z.string().nullable() },
  'db:health': { input: z.void(), output: DbHealth },
  'vault:status': { input: z.void(), output: VaultStatus },
  'tasks:toggle': { input: z.object({ id: z.string(), done: z.boolean() }), output: z.boolean() },
  'tasks:for-note': { input: NotePath, output: z.array(TaskRow) },
  'tasks:list': { input: z.void(), output: z.array(TaskItem) },
  'tasks:quick-add': {
    input: z.object({ text: z.string().max(500) }),
    output: z.object({
      path: z.string(),
      description: z.string(),
      owner: z.string(),
      due: z.string().nullable()
    })
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
  'entities:remove': {
    input: z.object({ category: RegCategory, name: z.string() }),
    output: z.null()
  },
  'insights:analyze': {
    input: z.object({ days: z.number().int().positive().max(3650).nullable() }),
    output: Insights
  },
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
  'notes:set-title': {
    input: z.object({ path: z.string(), title: z.string().min(1).max(120) }),
    output: NotePath
  },
  'calendar:status': { input: z.void(), output: CalendarStatus },
  'calendar:sync': { input: z.void(), output: CalendarStatus },
  'calendar:upcoming': { input: z.void(), output: z.array(UpcomingEvent) },
  'calendar:open-event': { input: z.object({ id: z.string() }), output: NotePath },
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
  'nudges:test': { input: z.void(), output: z.null() },
  'gmail:status': { input: z.void(), output: GmailStatus },
  'gmail:sync': {
    input: z.object({ full: z.boolean().optional() }).optional(),
    output: GmailStatus
  },
  'gmail:mutes': { input: z.void(), output: z.array(z.string()) },
  'gmail:mute': { input: z.object({ target: z.string().max(320) }), output: z.string() },
  'gmail:unmute': { input: z.object({ pattern: z.string() }), output: z.null() },
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
  'app:set-theme': { input: z.object({ mode: ThemeMode }), output: z.null() },
  'assistant:send': {
    input: z.object({
      text: z.string().min(1).max(8000),
      mode: z.enum(['auto', 'ask', 'capture']).optional()
    }),
    output: z.array(ChatMessage)
  },
  'assistant:history': { input: z.void(), output: z.array(ChatMessage) },
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
  'capture:shown': z.null()
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
