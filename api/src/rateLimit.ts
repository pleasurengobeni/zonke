import type { Request, Response, NextFunction } from 'express';

// A small in-memory sliding-window limiter - no Redis, no extra dependency. This service
// runs as one container instance behind one nginx, so per-process memory is the right
// place for this; it does not need to survive a restart or be shared across replicas.
// Overridable from the environment: the browser-driven checks in scripts/ drive several
// sessions from one address inside a minute and would otherwise be throttled mid-run, and
// it means the production limit can be retuned by restarting the container rather than by
// editing and redeploying this file. The defaults are the shipped values.
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT_MAX) || 60;
const hits = new Map<string, number[]>();

// Sweep stale IPs periodically so this map doesn't grow without bound over a long uptime.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, times] of hits) {
    const kept = times.filter((t) => t > cutoff);
    if (kept.length === 0) hits.delete(ip);
    else hits.set(ip, kept);
  }
}, WINDOW_MS).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const times = (hits.get(ip) ?? []).filter((t) => t > cutoff);
  if (times.length >= MAX_PER_WINDOW) {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }
  times.push(now);
  hits.set(ip, times);
  next();
}
