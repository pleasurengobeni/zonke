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

// The scores table predates having more than one scoreable mode, so `mode` is added in
// place rather than by recreating the table - an existing deployment's rows have to
// survive this. Everything already in there was a Time Attack run, since that was the only
// mode that could submit a score, which is exactly what the DEFAULT backfills them to.
const scoreColumns = db.prepare('PRAGMA table_info(scores)').all() as { name: string }[];
if (!scoreColumns.some((c) => c.name === 'mode')) {
  db.exec(`ALTER TABLE scores ADD COLUMN mode TEXT NOT NULL DEFAULT 'timeattack'`);
}

// The leaderboard is always read one mode at a time - a Zonke run scores in kills (single
// digits) and a Time Attack run in points (tens), so ranking them against each other would
// be meaningless.
db.exec(`CREATE INDEX IF NOT EXISTS idx_scores_mode_score ON scores(mode, score DESC)`);

// Whether that run was actually won. It cannot be inferred from kills and time - a player
// can finish a long match with four kills and still lose - so the fastest-win board needs
// it recorded at submission. Rows that predate the column stay 0: unknown, not a win.
const scoreColumns2 = db.prepare('PRAGMA table_info(scores)').all() as { name: string }[];
if (!scoreColumns2.some((c) => c.name === 'won')) {
  db.exec('ALTER TABLE scores ADD COLUMN won INTEGER NOT NULL DEFAULT 0');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_scores_fastest ON scores(mode, won, duration_ms ASC)');

// Which difficulty a score was set on. An Easy win and a Hard win are not comparable, so
// they cannot share a board - every leaderboard is read one difficulty at a time. Rows
// from before this column stay NULL: unknown, and deliberately absent from every
// difficulty board rather than silently filed under one of them.
const scoreColumns3 = db.prepare('PRAGMA table_info(scores)').all() as { name: string }[];
if (!scoreColumns3.some((c) => c.name === 'difficulty')) {
  db.exec('ALTER TABLE scores ADD COLUMN difficulty TEXT');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_scores_difficulty ON scores(mode, difficulty, won, duration_ms ASC)');

// Shot and landing events carry the player's name in their payload, and the ZONKE rate is
// read per player - an expression index keeps that from scanning the whole log every time
// somebody opens an info panel.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_events_player
    ON events(json_extract(payload, '$.name'), event_type);
`);

// Finished online matches, so a player has a record other players can look at before
// deciding whether to challenge them. Names are not accounts - two people who pick the
// same name share a record - but the waiting room is small and public, and a made-up
// reputation is not worth a login screen.
db.exec(`
  CREATE TABLE IF NOT EXISTS online_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL UNIQUE,
    winner_name TEXT NOT NULL,
    loser_name TEXT NOT NULL,
    winner_kills INTEGER NOT NULL,
    loser_kills INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_online_winner ON online_results(winner_name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_online_loser ON online_results(loser_name COLLATE NOCASE);
`);
