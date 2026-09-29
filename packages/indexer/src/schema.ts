import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY,
  cwd TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES project(id),
  file_path TEXT NOT NULL,
  title TEXT NOT NULL,
  first_ts INTEGER,
  last_ts INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  models TEXT NOT NULL DEFAULT '[]',
  git_branch TEXT,
  cli_version TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  archived INTEGER NOT NULL DEFAULT 0,
  has_prompt INTEGER NOT NULL DEFAULT 1,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER,
  edited_files TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS session_by_project ON session(project_id, last_ts DESC);

CREATE TABLE IF NOT EXISTS agent (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  tool_use_id TEXT,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  is_fork INTEGER NOT NULL DEFAULT 0,
  worktree_path TEXT,
  worktree_branch TEXT,
  status TEXT NOT NULL,
  started_ts INTEGER,
  ended_ts INTEGER,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  file_path TEXT NOT NULL,
  file_mtime INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);

CREATE TABLE IF NOT EXISTS message (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  role TEXT NOT NULL,
  ts INTEGER,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS message_by_agent ON message(session_id, agent_id, byte_offset);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text, content='message', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS message_ai AFTER INSERT ON message WHEN new.text <> '' BEGIN
  INSERT INTO message_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS message_ad AFTER DELETE ON message WHEN old.text <> '' BEGIN
  INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TABLE IF NOT EXISTS indexed_file (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS indexed_file_by_session ON indexed_file(session_id);

-- The user's own organisation. Never derived from disk, never deleted by re-indexing.
CREATE TABLE IF NOT EXISTS folder (id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER);
CREATE TABLE IF NOT EXISTS tag (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT);
CREATE TABLE IF NOT EXISTS session_meta (
  session_id TEXT PRIMARY KEY,
  folder_id INTEGER,
  favorite INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  title TEXT
);
CREATE TABLE IF NOT EXISTS session_tag (session_id TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (session_id, tag_id));
`;

export function configure(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
}

export function migrate(db: DatabaseSync): void {
  configure(db);
  db.exec(DDL);
  const columns = db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'has_prompt')) {
    db.exec('ALTER TABLE session ADD COLUMN has_prompt INTEGER NOT NULL DEFAULT 1; DELETE FROM indexed_file;');
  }
  // How full the context was on the last reply, and the files it edited: every file is read again to fill them in.
  if (!columns.some((c) => c.name === 'context_tokens')) {
    db.exec("ALTER TABLE session ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0; ALTER TABLE session ADD COLUMN context_window INTEGER; ALTER TABLE session ADD COLUMN edited_files TEXT NOT NULL DEFAULT '[]'; DELETE FROM indexed_file;");
  }
  // Folders the user opened or created in the app: listed as projects before their first conversation.
  const projectColumns = db.prepare('PRAGMA table_info(project)').all() as Array<{ name: string }>;
  if (!projectColumns.some((c) => c.name === 'added_at')) db.exec('ALTER TABLE project ADD COLUMN added_at INTEGER');
  // A title the user gave a conversation (the CLI's own title stays in session.title).
  const metaColumns = db.prepare('PRAGMA table_info(session_meta)').all() as Array<{ name: string }>;
  if (!metaColumns.some((c) => c.name === 'title')) db.exec('ALTER TABLE session_meta ADD COLUMN title TEXT');
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
}
