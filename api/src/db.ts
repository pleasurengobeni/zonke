import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// /data is a named Docker volume (see docker-compose.yml) - without it, every deploy's
// `docker compose up -d --build` would recreate the container and silently wipe the
// database, since a container's own filesystem is disposable by design.
const DATA_DIR = process.env.DATA_DIR ?? '/data';
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'zonke.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score DESC);

  -- One flexible event log rather than a fixed set of pre-aggregated tables, so a
  -- question nobody thought to build a report for yet can still be answered by querying
  -- this table directly instead of needing a schema change first.
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    path TEXT,
    referrer TEXT,
    user_agent TEXT,
    viewport TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
`);
