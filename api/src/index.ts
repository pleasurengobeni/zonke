import express from 'express';
import { db } from './db.js';
import { rateLimit } from './rateLimit.js';

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

app.post('/scores', rateLimit, (req, res) => {
  const name = cleanString(req.body?.name, 24);
  // 5000 is a generous ceiling above any realistic Time Attack round (20-point ZONKE
  // landings every couple of seconds for the whole round would not reach it) - it exists
  // to reject obviously forged submissions, not to model the real scoring curve exactly.
  const score = boundedInt(req.body?.score, 0, 5000);
  const durationMs = boundedInt(req.body?.durationMs, 1000, 300_000);
  if (!name || score === null || durationMs === null) {
    res.status(400).json({ error: 'Invalid score submission' });
    return;
  }
  const info = db
    .prepare('INSERT INTO scores (name, score, duration_ms) VALUES (?, ?, ?)')
    .run(name, score, durationMs);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/scores/top', (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const rows = db
    .prepare('SELECT name, score, duration_ms as durationMs, created_at as createdAt FROM scores ORDER BY score DESC, created_at ASC LIMIT ?')
    .all(limit);
  res.json(rows);
});

// ---- events (analytics) -------------------------------------------------------------

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
    .prepare('SELECT COUNT(*) as n, AVG(score) as avg, MAX(score) as max FROM scores')
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
    eventsPerDayLast7: last7Days,
  });
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

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log(`zonke-api listening on ${PORT}`);
});
