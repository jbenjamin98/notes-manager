/** Ordered, append-only. Never edit a shipped migration; add a new one. */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'core',
    sql: `
-- Derived index of vault files. Disposable: can be rebuilt from the vault at any time.
CREATE TABLE file_state (
  path TEXT PRIMARY KEY,            -- vault-relative, forward slashes
  hash TEXT NOT NULL,               -- sha256 of content last indexed
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,              -- frontmatter ULID, NOT the filename
  file_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('meeting','adhoc','inbox')),
  date TEXT NOT NULL,
  account TEXT,
  calendar_event_id TEXT,
  llm_blocked INTEGER NOT NULL DEFAULT 0,   -- 1 if tagged CUI / llm:off
  body_text TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_notes_date ON notes(date);
CREATE INDEX idx_notes_event ON notes(calendar_event_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,              -- inline ^id marker, stable across edits
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  line_hash TEXT NOT NULL,
  description TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT 'Me',
  is_mine INTEGER NOT NULL DEFAULT 1,
  due_date TEXT,
  priority TEXT CHECK (priority IN ('High','Medium','Low')),
  est_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX idx_tasks_note ON tasks(note_id);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('person','customer','system','event','topic')),
  in_registry INTEGER NOT NULL DEFAULT 0    -- 1 if curated in system/entities.json
);

CREATE TABLE note_entities (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mention_count INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'deterministic' CHECK (source IN ('deterministic','llm')),
  PRIMARY KEY (note_id, entity_id)
);

-- Heading-level chunks for FTS / RAG.
CREATE TABLE note_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  heading TEXT,
  text TEXT NOT NULL
);
CREATE INDEX idx_chunks_note ON note_chunks(note_id);
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, heading, content='note_chunks', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON note_chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON note_chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON note_chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
  INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;

-- Scraped from the persist:work-google session.
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,              -- Google event id (data-eventid)
  series_id TEXT,                   -- recurring series id when available
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,           -- ISO 8601 with offset
  end_at TEXT NOT NULL,
  meet_url TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_events_start ON calendar_events(start_at);

CREATE TABLE email_threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('flagged','unanswered_sent')),
  subject TEXT NOT NULL,
  counterpart TEXT,
  last_message_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Deterministic nudge engine. dedupe_key makes every rule idempotent.
CREATE TABLE nudges (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,  -- e.g. prep:<eventId>:<date>
  rule TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','dismissed','snoozed')),
  snooze_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('assistant','user')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('brief','pre_meeting','overdue','chat','nudge')),
  content TEXT NOT NULL,
  action_payload_json TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- LLM router bookkeeping (survives restarts so free-tier limits are respected).
CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  ts INTEGER NOT NULL,              -- epoch ms
  ok INTEGER NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER
);
CREATE INDEX idx_llm_usage_ts ON llm_usage(provider, ts);

CREATE TABLE llm_cache (
  key TEXT PRIMARY KEY,             -- hash(tier + prompt)
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`
  },
  {
    version: 2,
    name: 'calendar-columns-and-kv',
    sql: `
ALTER TABLE calendar_events ADD COLUMN date TEXT;
ALTER TABLE calendar_events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calendar_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'meeting';
ALTER TABLE calendar_events ADD COLUMN status TEXT;
CREATE INDEX idx_events_date ON calendar_events(date);

-- Small machine-local key/value store (sync timestamps etc.).
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
  },
  {
    version: 3,
    name: 'entity-name-ci',
    sql: `
-- "Sarah" and "sarah" must be one entity. Rebuilt from files, so clearing is safe.
DELETE FROM note_entities;
DELETE FROM entities;
CREATE UNIQUE INDEX idx_entities_lname ON entities(lower(name));
CREATE INDEX idx_note_entities_entity ON note_entities(entity_id);
DELETE FROM file_state; -- force a one-time re-index so entities get extracted
`
  },
  {
    version: 4,
    name: 'gmail',
    sql: `
-- Scraped Gmail metadata (subject/sender/labels only, never bodies). Local to this machine.
DROP TABLE email_threads;
CREATE TABLE email_threads (
  id TEXT PRIMARY KEY,                 -- Gmail thread id (legacy hex when available)
  link_id TEXT,                        -- id usable in #all/<id> URLs, if known
  subject TEXT NOT NULL,
  snippet TEXT,
  sender_name TEXT,
  sender_email TEXT,
  last_sender_is_me INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,                -- naive local 'YYYY-MM-DDTHH:mm'
  unread INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  in_sent INTEGER NOT NULL DEFAULT 0,  -- seen in the "sent" search
  labels_json TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_email_last ON email_threads(last_message_at);

-- What the user did with a thread: 'dismissed' | 'task_added'.
CREATE TABLE email_actions (
  thread_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('dismissed','task_added')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_id, action)
);

-- Labels seen on recent mail (discovered from row chips, no need to open each label).
CREATE TABLE gmail_labels (
  name TEXT PRIMARY KEY,
  seen_count INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`
  },
  {
    version: 5,
    name: 'gmail-allmail-and-auto-tags',
    sql: `
-- All Mail crawl: relevance is decided at READ time (so settings apply instantly), from these facts.
ALTER TABLE email_threads ADD COLUMN in_inbox INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_threads ADD COLUMN i_participated INTEGER NOT NULL DEFAULT 0;
DELETE FROM email_threads;           -- old rows lack the new facts; the next (full) sync refills them
DELETE FROM kv WHERE key LIKE 'gmail.%';

-- Senders/domains the user never wants brought in. pattern = 'name@x.com' or '@x.com'.
CREATE TABLE email_mutes (
  pattern TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Task fields detected from plain text (no "| @owner" / "| due:" typed) are marked so the UI can say so.
ALTER TABLE tasks ADD COLUMN auto_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN auto_due INTEGER NOT NULL DEFAULT 0;
DELETE FROM file_state;              -- re-index once so inference runs on existing notes
`
  },
  {
    version: 6,
    name: 'calendar-event-detail',
    sql: `
-- Guests and Meet link are fetched on demand (the agenda doesn't show them) and cached here.
ALTER TABLE calendar_events ADD COLUMN detail_at TEXT;
`
  },
  {
    version: 7,
    name: 'meet-artifacts-and-chat',
    sql: `
-- Gemini "Notes by Gemini" / transcripts that Meet saved to Drive (read through the Google APIs).
CREATE TABLE meet_artifacts (
  file_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('notes','transcript')),
  created_at TEXT NOT NULL,
  event_id TEXT,                       -- calendar event it was matched to, if any
  note_path TEXT,                      -- vault note it was written into, if any
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Recent Google Chat messages (metadata + a short excerpt), for follow-ups and prep.
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  space_name TEXT NOT NULL,
  space_type TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_created ON chat_messages(created_at);
`
  },
  {
    version: 8,
    name: 'entity-categories-project-place',
    sql: `
-- Entities are derived from the notes and registry, so the table can simply be rebuilt with the wider
-- category list (SQLite cannot change a CHECK in place). Everything is re-extracted on the next scan.
DROP TABLE note_entities;
DROP TABLE entities;
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('person','customer','system','project','place','event','topic')),
  in_registry INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE note_entities (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mention_count INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'deterministic' CHECK (source IN ('deterministic','llm')),
  PRIMARY KEY (note_id, entity_id)
);
CREATE UNIQUE INDEX idx_entities_lname ON entities(lower(name));
CREATE INDEX idx_note_entities_entity ON note_entities(entity_id);
DELETE FROM file_state;
`
  },
  {
    version: 9,
    name: 'chat-triage-and-feature-usage',
    sql: `
-- Chat messages carry what triage needs (who, which thread, was I mentioned, did I write it).
ALTER TABLE chat_messages ADD COLUMN thread TEXT;
ALTER TABLE chat_messages ADD COLUMN sender_id TEXT;
ALTER TABLE chat_messages ADD COLUMN from_me INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN mentions_me INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN has_question INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN source TEXT;
CREATE INDEX idx_chat_thread ON chat_messages(space, thread);

-- Which spaces to follow closely. mode: auto (DMs and group chats track, spaces mentions-only), track, mentions, ignore.
CREATE TABLE chat_spaces (
  space TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','track','mentions','ignore')),
  last_at TEXT
);

-- "Relevant / not relevant" answers teach the triage weights (kept local and inspectable).
CREATE TABLE chat_feedback (
  conv_key TEXT PRIMARY KEY,
  relevant INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE chat_weights (
  feature TEXT PRIMARY KEY,
  weight REAL NOT NULL
);

-- Where AI tokens go: per feature.
ALTER TABLE llm_usage ADD COLUMN feature TEXT;
`
  },
  {
    version: 10,
    name: 'event-attachments',
    sql: `
-- Documents attached to calendar events (Gemini meeting notes): an exact link from file to meeting.
CREATE TABLE event_attachments (
  event_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (event_id, file_id)
);
`
  },
  {
    version: 11,
    name: 'insights',
    sql: `
-- What matters from meetings, email and chat (actions, decisions, risks...), each with a reference
-- back to its source. The raw messages are only a short working set; these stay.
CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('action','ask','promise','decision','question','risk','change','fact')),
  text TEXT NOT NULL,
  owner TEXT,
  due TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','dismissed')),
  source_type TEXT NOT NULL CHECK (source_type IN ('meeting','email','chat','note')),
  source_ref TEXT NOT NULL DEFAULT '{}',
  source_label TEXT NOT NULL DEFAULT '',
  source_snippet TEXT NOT NULL DEFAULT '',
  source_at TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_insights_status ON insights(status, created_at);
CREATE TABLE insight_entities (
  insight_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  PRIMARY KEY (insight_id, entity_name)
);
CREATE INDEX idx_insight_entities_name ON insight_entities(entity_name);
-- Which source texts have been read already (a hash), so unchanged ones are never read twice.
CREATE TABLE insight_runs (
  source_key TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  at TEXT NOT NULL
);
-- A task made from an insight remembers where it came from.
ALTER TABLE tasks ADD COLUMN source_id TEXT;
ALTER TABLE tasks ADD COLUMN source_label TEXT;
`
  },
  {
    version: 12,
    name: 'series-and-tag-events',
    sql: `
-- A meeting note linked to a series by hand (frontmatter "series:"); '-' means not in any series.
ALTER TABLE notes ADD COLUMN series TEXT;
-- What happened to each automatic tag: kept, accepted from a maybe, or taken off again.
CREATE TABLE tag_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  sigil TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('tagged','accepted','rejected')),
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_tag_events_word ON tag_events(word);
`
  },
  {
    version: 13,
    name: 'email-importance',
    sql: `
-- Facts read from message headers, to tell mail for you from bulk and copies.
ALTER TABLE email_threads ADD COLUMN to_me INTEGER;
ALTER TABLE email_threads ADD COLUMN cc_me INTEGER;
ALTER TABLE email_threads ADD COLUMN bulk INTEGER;
ALTER TABLE email_threads ADD COLUMN important_label INTEGER;
ALTER TABLE email_threads ADD COLUMN msg_count INTEGER;
-- When a thread was dismissed: it comes back if someone writes again afterwards.
ALTER TABLE email_actions ADD COLUMN at TEXT;
-- What you taught it: Important / Not important per sender address and "@domain".
CREATE TABLE sender_weights (
  key TEXT PRIMARY KEY,
  weight REAL NOT NULL DEFAULT 0,
  important_n INTEGER NOT NULL DEFAULT 0,
  not_n INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`
  },
  {
    version: 14,
    name: 'llm-usage-history',
    sql: `
-- Raw per-call rows are kept 3 days; older ones are folded into one row per day, provider and purpose.
CREATE TABLE llm_usage_daily (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  feature TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, feature)
);
-- Why a provider was held back (rate limit, overload), newest last; trimmed to a few hundred rows.
CREATE TABLE llm_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  status INTEGER NOT NULL,
  retry_after_sec INTEGER,
  feature TEXT
);
CREATE INDEX idx_llm_usage_feature_ts ON llm_usage(feature, ts);
`
  }
]
