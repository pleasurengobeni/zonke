import express from 'express';
import { createServer } from 'node:http';
import { db } from './db.js';
import { rateLimit } from './rateLimit.js';
import { attachLobby, lobbyStats } from './lobby.js';

const app = express();
// Only the host nginx (on 127.0.0.1) ever connects to this container, so trust its
// X-Forwarded-For for the real client IP - needed for the rate limiter to key on the
// actual visitor rather than always seeing the proxy's own loopback address.
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '8kb' }));

// ---- validation helpers ----------------------------------------------------------

function cleanString(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const stripped = v.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (stripped.length === 0 || stripped.length > maxLen) return null;
  return stripped;
}

function boundedInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  // Round rather than reject non-integers - a client's elapsed-time clock (e.g. Phaser's
  // time.now) is legitimately fractional; that was never a meaningful validation boundary,
  // just accidental strictness that rejected every real submission.
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

// ---- scores -----------------------------------------------------------------------

const SCORE_MODES = ['timeattack', 'zonke'] as const;
type ScoreMode = (typeof SCORE_MODES)[number];

// The difficulty a run was played on. 'Challenge' - a match against another person - is
// the fifth category a player sees, but it lives in online_results rather than here.
const DIFFICULTIES = ['Easy', 'Moderate', 'Hard'] as const;
type Difficulty = (typeof DIFFICULTIES)[number];

/** null = not stated, undefined = stated but not a difficulty we know. */
function difficultyOf(v: unknown): Difficulty | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  return DIFFICULTIES.includes(v as Difficulty) ? (v as Difficulty) : undefined;
}

function scoreMode(v: unknown): ScoreMode | null {
  if (v === undefined || v === null) return 'timeattack'; // what the only pre-mode client sent
  return SCORE_MODES.includes(v as ScoreMode) ? (v as ScoreMode) : null;
}

// Time Attack is a fixed 60s round; a Zonke match runs until someone can't be caught, which
// is open-ended, so the two modes get different sanity ceilings rather than one that is
// either too tight for a long match or too loose to mean anything.
const MODE_LIMITS: Record<ScoreMode, { maxScore: number; maxDurationMs: number }> = {
  // 5000 is a generous ceiling above any realistic Time Attack round (20-point ZONKE
  // landings every couple of seconds for the whole round would not reach it) - it exists
  // to reject obviously forged submissions, not to model the real scoring curve exactly.
  timeattack: { maxScore: 5000, maxDurationMs: 300_000 },
  // A Zonke score IS the player's kill count, and there are only ten rows to take.
  zonke: { maxScore: 10, maxDurationMs: 3_600_000 },
};

app.post('/scores', rateLimit, (req, res) => {
  const name = cleanString(req.body?.name, 24);
  const mode = scoreMode(req.body?.mode);
  if (!name || mode === null) {
    res.status(400).json({ error: 'Invalid score submission' });
    return;
  }
  const limits = MODE_LIMITS[mode];
  const score = boundedInt(req.body?.score, 0, limits.maxScore);
  const durationMs = boundedInt(req.body?.durationMs, 1000, limits.maxDurationMs);
  if (score === null || durationMs === null) {
    res.status(400).json({ error: 'Invalid score submission' });
    return;
  }
  const won = req.body?.won === true || req.body?.won === 1 ? 1 : 0;
  const difficulty = difficultyOf(req.body?.difficulty);
  if (difficulty === undefined) {
    res.status(400).json({ error: 'Unknown difficulty' });
    return;
  }
  const info = db
    .prepare('INSERT INTO scores (name, score, duration_ms, mode, won, difficulty) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, score, durationMs, mode, won, difficulty);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/scores/top', (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  // No mode filter returns every mode together, as this route always did - callers that
  // care about a single board (both game modes do) ask for one by name.
  const mode = typeof req.query.mode === 'string' ? scoreMode(req.query.mode) : undefined;
  if (mode === null) {
    res.status(400).json({ error: 'Unknown mode' });
    return;
  }
  // Two boards off one table: the default ranks by score, and `sort=fastest` answers the
  // other question people actually ask - who beat the CPU quickest. A fastest board only
  // ever counts won runs, so a quick loss can never top it.
  const fastest = req.query.sort === 'fastest';
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (mode) {
    clauses.push('mode = ?');
    params.push(mode);
  }
  if (fastest) clauses.push('won = 1');
  // One difficulty at a time: an Easy run and a Hard run do not belong on the same board.
  const difficulty = difficultyOf(req.query.difficulty);
  if (difficulty === undefined) {
    res.status(400).json({ error: 'Unknown difficulty' });
    return;
  }
  if (difficulty) {
    clauses.push('difficulty = ?');
    params.push(difficulty);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = fastest
    ? 'duration_ms ASC, score DESC, created_at ASC'
    : 'score DESC, duration_ms ASC, created_at ASC';

  // `perPlayer` answers "who are the top ten PLAYERS", rather than "what are the ten best
  // runs" - without it one person having a good week fills every row and the board stops
  // telling anyone anything. Each player is represented by their own best run.
  const perPlayer = req.query.perPlayer === '1' || req.query.perPlayer === 'true';
  const sql = perPlayer
    ? `SELECT name, score, durationMs, mode, won, difficulty, createdAt FROM (
         SELECT name, score, duration_ms as durationMs, mode, won, difficulty, created_at as createdAt,
                ROW_NUMBER() OVER (PARTITION BY name COLLATE NOCASE ORDER BY ${order}) AS rn
         FROM scores ${where}
       ) WHERE rn = 1 ORDER BY ${order.replace(/duration_ms/g, 'durationMs').replace(/created_at/g, 'createdAt')} LIMIT ?`
    : `SELECT name, score, duration_ms as durationMs, mode, won, difficulty, created_at as createdAt FROM scores
       ${where} ORDER BY ${order} LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit);
  res.json(rows);
});

// ---- events (analytics) -------------------------------------------------------------

/**
 * Events arrive in batches, because the game has a lot to say: a match is roughly seventy
 * shots, and one request each would both hammer the API and trip the per-IP limiter mid
 * game. The client buffers and flushes, so a whole match costs a handful of requests.
 */
app.post('/events/batch', rateLimit, (req, res) => {
  const sessionId = cleanString(req.body?.sessionId, 64);
  const events = Array.isArray(req.body?.events) ? req.body.events : null;
  if (!sessionId || !events || events.length === 0 || events.length > 200) {
    res.status(400).json({ error: 'Invalid event batch' });
    return;
  }
  const userAgent = cleanString(req.header('user-agent') ?? '', 300) ?? null;
  const path_ = cleanString(req.body?.path, 200) ?? null;
  const referrer = cleanString(req.body?.referrer, 300) ?? null;
  const viewport = cleanString(req.body?.viewport, 20) ?? null;

  const insert = db.prepare(
    `INSERT INTO events (session_id, event_type, payload, path, referrer, user_agent, viewport)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // One transaction for the batch: a hundred inserts otherwise means a hundred fsyncs.
  const writeAll = db.transaction((rows: unknown[]) => {
    let written = 0;
    for (const row of rows) {
      const event = row as Record<string, unknown>;
      const type = cleanString(event.type, 64);
      if (!type) continue;
      const payload = event.payload === undefined ? null : JSON.stringify(event.payload).slice(0, 2000);
      insert.run(sessionId, type, payload, path_, referrer, userAgent, viewport);
      written += 1;
    }
    return written;
  });
  res.status(202).json({ written: writeAll(events) });
});

app.post('/events', rateLimit, (req, res) => {
  const sessionId = cleanString(req.body?.sessionId, 64);
  const eventType = cleanString(req.body?.type, 64);
  if (!sessionId || !eventType) {
    res.status(400).json({ error: 'Invalid event' });
    return;
  }
  const payloadRaw = req.body?.payload;
  const payload = payloadRaw === undefined ? null : JSON.stringify(payloadRaw).slice(0, 2000);
  const path_ = cleanString(req.body?.path, 200) ?? null;
  const referrer = cleanString(req.body?.referrer, 300) ?? null;
  const viewport = cleanString(req.body?.viewport, 20) ?? null;
  const userAgent = cleanString(req.header('user-agent') ?? '', 300) ?? null;

  db.prepare(
    `INSERT INTO events (session_id, event_type, payload, path, referrer, user_agent, viewport)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, eventType, payload, path_, referrer, userAgent, viewport);
  res.status(204).end();
});

// ---- stats (never exposed publicly - the host nginx puts Basic Auth in front of this
// path, the same way it already does for lulamisapay's /monitor dashboard) --------------

app.get('/stats', (_req, res) => {
  const totalEvents = db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number };
  const totalSessions = db
    .prepare('SELECT COUNT(DISTINCT session_id) as n FROM events')
    .get() as { n: number };
  const byType = db
    .prepare('SELECT event_type as type, COUNT(*) as n FROM events GROUP BY event_type ORDER BY n DESC')
    .all();
  const byPath = db
    .prepare(
      `SELECT path, COUNT(*) as n FROM events WHERE event_type = 'page_view' AND path IS NOT NULL
       GROUP BY path ORDER BY n DESC LIMIT 20`
    )
    .all();
  const byViewport = db
    .prepare(
      `SELECT viewport, COUNT(*) as n FROM events WHERE viewport IS NOT NULL
       GROUP BY viewport ORDER BY n DESC LIMIT 20`
    )
    .all();
  const modePicks = db
    .prepare(
      `SELECT json_extract(payload, '$.mode') as mode, COUNT(*) as n FROM events
       WHERE event_type = 'mode_selected' GROUP BY mode ORDER BY n DESC`
    )
    .all();
  const outcomes = db
    .prepare(
      `SELECT json_extract(payload, '$.result') as result, COUNT(*) as n FROM events
       WHERE event_type = 'game_over' GROUP BY result ORDER BY n DESC`
    )
    .all();
  const scoreStats = db
    .prepare("SELECT COUNT(*) as n, AVG(score) as avg, MAX(score) as max FROM scores WHERE mode = 'timeattack'")
    .get();
  const zonkeScoreStats = db
    .prepare(
      `SELECT COUNT(*) as n, AVG(score) as avgKills, MAX(score) as maxKills, AVG(duration_ms) as avgDurationMs,
              SUM(won) as wins, MIN(CASE WHEN won = 1 THEN duration_ms END) as fastestWinMs
       FROM scores WHERE mode = 'zonke'`
    )
    .get();
  const last7Days = db
    .prepare(
      `SELECT substr(created_at, 1, 10) as day, COUNT(*) as n FROM events
       WHERE created_at > datetime('now', '-7 days') GROUP BY day ORDER BY day`
    )
    .all();

  res.json({
    totalEvents: totalEvents.n,
    totalSessions: totalSessions.n,
    eventsByType: byType,
    topPaths: byPath,
    viewportBreakdown: byViewport,
    modeSelections: modePicks,
    gameOutcomes: outcomes,
    timeAttackScores: scoreStats,
    zonkeScores: zonkeScoreStats,
    eventsPerDayLast7: last7Days,
  });
});

// ---- funnel: visitors -> picked a mode -> finished, plus how long they stuck around ----
//
// A "finish" is game_over (the main PvCPU mode) or time_attack_finished (Time Attack) -
// whichever the session actually reached. Drop-off is inferred, not a separate event: a
// session that has mode_selected but neither finish event never sent one because it never
// happened - the tab was closed, the game was abandoned, whatever it was.

interface FunnelRow { n: number }
interface NamedCount { name: string | null; n: number }

function getFunnel() {
  const visitors = (db.prepare(
    `SELECT COUNT(DISTINCT session_id) as n FROM events WHERE event_type = 'page_view'`
  ).get() as FunnelRow).n;

  const started = (db.prepare(
    `SELECT COUNT(DISTINCT session_id) as n FROM events WHERE event_type = 'mode_selected'`
  ).get() as FunnelRow).n;

  const finished = (db.prepare(
    `SELECT COUNT(DISTINCT session_id) as n FROM events
     WHERE event_type IN ('game_over', 'time_attack_finished')`
  ).get() as FunnelRow).n;

  const byMode = db.prepare(
    `SELECT json_extract(payload, '$.mode') as name, COUNT(DISTINCT session_id) as n
     FROM events WHERE event_type = 'mode_selected' GROUP BY name ORDER BY n DESC`
  ).all() as NamedCount[];

  // Per mode, how many of the sessions that picked it went on to actually finish - the
  // per-mode version of the same drop-off question.
  const finishByMode = db.prepare(
    `SELECT json_extract(ms.payload, '$.mode') as name, COUNT(DISTINCT ms.session_id) as n
     FROM events ms
     WHERE ms.event_type = 'mode_selected'
       AND EXISTS (
         SELECT 1 FROM events f
         WHERE f.session_id = ms.session_id
           AND f.event_type IN ('game_over', 'time_attack_finished')
           AND f.created_at >= ms.created_at
       )
     GROUP BY name`
  ).all() as NamedCount[];

  // Session duration: last event minus first event, for sessions with more than one event
  // (a single page_view and nothing else has no "duration" worth counting).
  const duration = db.prepare(
    `SELECT AVG(d) as avgSec, MAX(d) as maxSec FROM (
       SELECT (julianday(MAX(created_at)) - julianday(MIN(created_at))) * 86400 as d
       FROM events GROUP BY session_id HAVING COUNT(*) >= 2
     )`
  ).get() as { avgSec: number | null; maxSec: number | null };

  const deviceBreakdown = db.prepare(
    `SELECT viewport as name, COUNT(DISTINCT session_id) as n FROM events
     WHERE viewport IS NOT NULL GROUP BY viewport ORDER BY n DESC LIMIT 15`
  ).all() as NamedCount[];

  const recentSessions = db.prepare(
    `SELECT session_id as sessionId, MIN(created_at) as firstSeen, MAX(created_at) as lastSeen,
            COUNT(*) as events,
            MAX(CASE WHEN event_type = 'mode_selected' THEN json_extract(payload, '$.mode') END) as mode,
            MAX(CASE WHEN event_type IN ('game_over','time_attack_finished') THEN 1 ELSE 0 END) as finished
     FROM events GROUP BY session_id ORDER BY lastSeen DESC LIMIT 25`
  ).all();

  const byModeMap = new Map(byMode.map((r) => [r.name ?? '(unknown)', r.n]));
  const finishByModeMap = new Map(finishByMode.map((r) => [r.name ?? '(unknown)', r.n]));
  const modes = [...byModeMap.keys()].map((name) => ({
    name,
    started: byModeMap.get(name) ?? 0,
    finished: finishByModeMap.get(name) ?? 0,
  }));

  return {
    visitors,
    started,
    finished,
    droppedBeforeStarting: Math.max(0, visitors - started),
    droppedMidGame: Math.max(0, started - finished),
    startRate: visitors > 0 ? started / visitors : null,
    finishRate: started > 0 ? finished / started : null,
    modes,
    avgSessionSeconds: duration.avgSec,
    maxSessionSeconds: duration.maxSec,
    deviceBreakdown,
    recentSessions,
  };
}

app.get('/stats/funnel', (_req, res) => {
  res.json(getFunnel());
});

function fmtSeconds(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return '-';
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

function pct(n: number | null): string {
  return n === null ? '-' : `${Math.round(n * 100)}%`;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// A readable page instead of raw JSON - same Basic Auth as every other /api/stats route
// (enforced by the host nginx, not this app), just rendered instead of dumped.
app.get('/stats/dashboard', (_req, res) => {
  const f = getFunnel();
  const barWidth = (n: number, max: number) => (max > 0 ? Math.round((n / max) * 100) : 0);
  const funnelMax = f.visitors || 1;

  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Zonke stats</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #1a1a1a; color: #eee; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; color: #ffd54f; margin: 32px 0 10px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 24px; }
  .funnel-row { display: flex; align-items: center; gap: 12px; margin: 10px 0; }
  .funnel-label { width: 160px; font-size: 13px; }
  .funnel-bar-track { flex: 1; background: #2a2a2a; border-radius: 4px; overflow: hidden; height: 22px; }
  .funnel-bar { background: #4fc3f7; height: 100%; }
  .funnel-n { width: 90px; text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #333; }
  th { color: #888; font-weight: normal; }
  .stat-grid { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat-box { background: #242424; border-radius: 6px; padding: 14px 18px; min-width: 140px; }
  .stat-box .n { font-size: 24px; font-weight: bold; color: #ffd54f; }
  .stat-box .l { font-size: 12px; color: #888; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
</style></head>
<body>
  <h1>Zonke - site stats</h1>
  <div class="sub">GET /api/stats for raw JSON, /api/stats/events for the paginated raw log</div>

  <h2>Funnel</h2>
  <div class="funnel-row">
    <div class="funnel-label">Visited</div>
    <div class="funnel-bar-track"><div class="funnel-bar" style="width:${barWidth(f.visitors, funnelMax)}%"></div></div>
    <div class="funnel-n">${f.visitors}</div>
  </div>
  <div class="funnel-row">
    <div class="funnel-label">Picked a mode</div>
    <div class="funnel-bar-track"><div class="funnel-bar" style="width:${barWidth(f.started, funnelMax)}%"></div></div>
    <div class="funnel-n">${f.started} (${pct(f.startRate)})</div>
  </div>
  <div class="funnel-row">
    <div class="funnel-label">Finished a round</div>
    <div class="funnel-bar-track"><div class="funnel-bar" style="width:${barWidth(f.finished, funnelMax)}%"></div></div>
    <div class="funnel-n">${f.finished} (${pct(f.finishRate)})</div>
  </div>

  <div class="stat-grid" style="margin-top:20px">
    <div class="stat-box"><div class="n">${f.droppedBeforeStarting}</div><div class="l">visited, never played</div></div>
    <div class="stat-box"><div class="n">${f.droppedMidGame}</div><div class="l">started, never finished</div></div>
    <div class="stat-box"><div class="n">${fmtSeconds(f.avgSessionSeconds)}</div><div class="l">avg time on site</div></div>
    <div class="stat-box"><div class="n">${fmtSeconds(f.maxSessionSeconds)}</div><div class="l">longest session</div></div>
  </div>

  <h2>By mode</h2>
  <table>
    <tr><th>Mode</th><th>Started</th><th>Finished</th><th>Finish rate</th></tr>
    ${f.modes
      .map(
        (m) =>
          `<tr><td>${esc(m.name)}</td><td>${m.started}</td><td>${m.finished}</td><td>${pct(m.started > 0 ? m.finished / m.started : null)}</td></tr>`
      )
      .join('')}
  </table>

  <h2>Devices (by screen size)</h2>
  <table>
    <tr><th>Viewport</th><th>Sessions</th></tr>
    ${f.deviceBreakdown.map((d) => `<tr><td>${esc(d.name)}</td><td>${d.n}</td></tr>`).join('')}
  </table>

  <h2>Recent sessions</h2>
  <table>
    <tr><th>First seen</th><th>Last seen</th><th>Events</th><th>Mode</th><th>Finished</th></tr>
    ${(f.recentSessions as any[])
      .map(
        (s) =>
          `<tr><td>${esc(s.firstSeen)}</td><td>${esc(s.lastSeen)}</td><td>${s.events}</td><td>${esc(s.mode ?? '-')}</td>` +
          `<td><span class="dot" style="background:${s.finished ? '#4caf50' : '#ff5252'}"></span>${s.finished ? 'yes' : 'no'}</td></tr>`
      )
      .join('')}
  </table>
</body></html>`);
});

// Raw, paginated, filterable event export - the actual answer to "every possible
// question": anything not covered by the aggregates above can be queried here directly
// instead of waiting for a new report to be written for it.
app.get('/stats/events', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const type = typeof req.query.type === 'string' ? req.query.type : null;
  const since = typeof req.query.since === 'string' ? req.query.since : null;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (type) { clauses.push('event_type = ?'); params.push(type); }
  if (since) { clauses.push('created_at >= ?'); params.push(since); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = db
    .prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  res.json(rows);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

/** Who is in the waiting room right now - public, and tiny, so the lobby can show it. */
app.get('/lobby/stats', (_req, res) => res.json(lobbyStats()));

/**
 * The Challenge board: who has won the most matches against other people. Ranked by wins,
 * then fewest losses, so 5-0 sits above 5-9.
 */
app.get('/players/top-online', (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const rows = db
    .prepare(
      `SELECT name, SUM(won) as won, SUM(lost) as lost FROM (
         SELECT winner_name as name, 1 as won, 0 as lost FROM online_results
         UNION ALL
         SELECT loser_name as name, 0 as won, 1 as lost FROM online_results
       ) GROUP BY name COLLATE NOCASE
       HAVING won > 0
       ORDER BY won DESC, lost ASC, name ASC LIMIT ?`
    )
    .all(limit);
  res.json(rows);
});

/**
 * One player's record, for the info button beside their name in the waiting room: how
 * they have done against other people, and their best run against the CPU. Public on
 * purpose - it is there to help someone decide whether to challenge them.
 */
app.get('/players/rep', (req, res) => {
  const name = cleanString(req.query.name, 24);
  if (!name) {
    res.status(400).json({ error: 'A name is required' });
    return;
  }
  const online = db
    .prepare(
      `SELECT
         SUM(CASE WHEN winner_name = ? COLLATE NOCASE THEN 1 ELSE 0 END) as won,
         SUM(CASE WHEN loser_name  = ? COLLATE NOCASE THEN 1 ELSE 0 END) as lost,
         MAX(CASE WHEN winner_name = ? COLLATE NOCASE THEN created_at END) as lastWin
       FROM online_results
       WHERE winner_name = ? COLLATE NOCASE OR loser_name = ? COLLATE NOCASE`
    )
    .get(name, name, name, name, name) as { won: number | null; lost: number | null; lastWin: string | null };

  const cpu = db
    .prepare(
      `SELECT COUNT(*) as wins, MIN(duration_ms) as fastestMs, MAX(score) as mostKills
       FROM scores WHERE mode = 'zonke' AND won = 1 AND name = ? COLLATE NOCASE`
    )
    .get(name) as { wins: number; fastestMs: number | null; mostKills: number | null };

  // Per difficulty as well as overall - beating Hard is not the same as beating Easy.
  const byDifficulty = db
    .prepare(
      `SELECT difficulty, COUNT(*) as wins, MIN(duration_ms) as fastestMs
       FROM scores WHERE mode = 'zonke' AND won = 1 AND difficulty IS NOT NULL AND name = ? COLLATE NOCASE
       GROUP BY difficulty ORDER BY difficulty`
    )
    .all(name);

  const timeAttack = db
    .prepare(`SELECT MAX(score) as best FROM scores WHERE mode = 'timeattack' AND name = ? COLLATE NOCASE`)
    .get(name) as { best: number | null };

  /**
   * How often this player actually lands the jackpot. Counted from the shot and landing
   * log rather than from saved scores, so it reflects every shot they have taken, not only
   * the runs they chose to save - and split per difficulty, because the whole point of the
   * difficulties is that the ZONKE band is a different size in each.
   */
  const zonke = db
    .prepare(
      `SELECT
         json_extract(payload, '$.difficulty') as difficulty,
         SUM(CASE WHEN event_type = 'shot' THEN 1 ELSE 0 END) as shots,
         SUM(CASE WHEN event_type = 'landing' AND json_extract(payload, '$.zonke') = 1 THEN 1 ELSE 0 END) as hits
       FROM events
       WHERE event_type IN ('shot', 'landing')
         AND json_extract(payload, '$.name') = ? COLLATE NOCASE
         AND json_extract(payload, '$.by') = 'player'
       GROUP BY difficulty`
    )
    .all(name) as { difficulty: string | null; shots: number; hits: number }[];

  const totals = zonke.reduce(
    (acc, row) => ({ shots: acc.shots + row.shots, hits: acc.hits + row.hits }),
    { shots: 0, hits: 0 }
  );

  const won = online.won ?? 0;
  const lost = online.lost ?? 0;
  res.json({
    name,
    online: { played: won + lost, won, lost, lastWin: online.lastWin },
    cpu: { wins: cpu.wins, fastestMs: cpu.fastestMs, mostKills: cpu.mostKills, byDifficulty },
    timeAttack: { best: timeAttack.best },
    zonke: {
      shots: totals.shots,
      hits: totals.hits,
      // Null rather than zero when they have not shot yet: "no data" and "never hits it"
      // are different things, and a 0% next to a new player's name would be a lie.
      rate: totals.shots > 0 ? totals.hits / totals.shots : null,
      byDifficulty: zonke
        .filter((row) => row.difficulty && row.shots > 0)
        .map((row) => ({
          difficulty: row.difficulty as string,
          shots: row.shots,
          hits: row.hits,
          rate: row.hits / row.shots,
        })),
    },
  });
});

// One HTTP server for both the REST routes and the lobby's WebSocket upgrade, since nginx
// proxies the whole of /api/ to this single port.
const PORT = Number(process.env.PORT) || 4000;
const server = createServer(app);
attachLobby(server);
server.listen(PORT, () => {
  console.log(`zonke-api listening on ${PORT} (REST + /ws lobby)`);
});
