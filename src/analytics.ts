// Fire-and-forget analytics: every call posts to the API and swallows any failure, since
// a dropped stats event should never be allowed to interrupt or crash actual gameplay.
//
// Two identities, not one. The visitor id lasts forever and answers "is this the same
// person coming back"; the session id covers ONE visit and answers "how long did they
// play". Both used to be the same localStorage value, which made every session look as
// long as the entire history of that browser - an average measured in days.
const VISITOR_KEY = 'zonke.visitorId';
const SESSION_KEY = 'zonke.sessionId';
const SESSION_SEEN_KEY = 'zonke.sessionLastSeen';

/** A gap this long without activity means the next event belongs to a new visit. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function visitorId(): string {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = newId();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    // localStorage can throw in a private tab - fall back to a per-load id rather than
    // let analytics ever be the reason the page breaks.
    return newId();
  }
}

/**
 * The current visit. Rotates when the tab has been idle longer than SESSION_IDLE_MS, so a
 * browser left open overnight does not report one enormous session the next morning.
 */
function sessionId(): string {
  try {
    const now = Date.now();
    const lastSeen = Number(sessionStorage.getItem(SESSION_SEEN_KEY) ?? 0);
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id || !lastSeen || now - lastSeen > SESSION_IDLE_MS) id = newId();
    sessionStorage.setItem(SESSION_KEY, id);
    sessionStorage.setItem(SESSION_SEEN_KEY, String(now));
    return id;
  } catch {
    return newId();
  }
}

/** Ends the current visit; the next event starts a fresh one. */
export function startNewSession(): string {
  try {
    const id = newId();
    sessionStorage.setItem(SESSION_KEY, id);
    sessionStorage.setItem(SESSION_SEEN_KEY, String(Date.now()));
    return id;
  } catch {
    return newId();
  }
}

// Events are buffered and flushed in batches rather than sent one at a time. The game
// has a lot to say - every shot, every landing, every mode change - and a request each
// would both flood the API and trip its per-IP limiter in the middle of a match.
const queue: { type: string; payload?: Record<string, unknown> }[] = [];
let flushTimer: number | null = null;
// Eight seconds is long enough that a slow match (a few seconds per shot) sends a handful
// of requests rather than one per shot, and short enough that little is lost if a tab dies
// in a way pagehide does not catch.
const FLUSH_AFTER_MS = 8000;
const FLUSH_AT = 25;

function flush(useBeacon = false): void {
  if (queue.length === 0) return;
  const events = queue.splice(0, queue.length);
  const body = JSON.stringify({
    sessionId: sessionId(),
    visitorId: visitorId(),
    events,
    path: location.pathname,
    referrer: document.referrer || undefined,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  });
  try {
    // On the way out of the page, sendBeacon is the only thing that reliably survives.
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/events/batch', new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch('/api/events/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never let analytics take the page down
  }
}

if (typeof window !== 'undefined') {
  // A player who closes the tab mid-match is exactly the session worth knowing about.
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}

/**
 * Queues an event. Use for anything that happens often - shots, landings, turns - so the
 * data is complete without the traffic that one request per event would mean.
 */
export function record(type: string, payload?: Record<string, unknown>): void {
  queue.push({ type, payload });
  if (queue.length >= FLUSH_AT) {
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    flushTimer = null;
    flush();
    return;
  }
  if (flushTimer === null) {
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_AFTER_MS);
  }
}

/** Sends one event immediately. Use for the few that must not wait, like page_view. */
export function track(type: string, payload?: Record<string, unknown>): void {
  try {
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId(),
        visitorId: visitorId(),
        type,
        payload,
        path: location.pathname,
        referrer: document.referrer || undefined,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never let analytics take the page down
  }
}

/** Each mode keeps its own leaderboard: Zonke scores in kills, Time Attack in points. */
export type ScoreMode = 'timeattack' | 'zonke';

/**
 * Returns whether the score actually made it, so the UI can tell the player the truth
 * instead of showing "Saved!" over a request that never landed.
 */
export type Difficulty = 'Easy' | 'Moderate' | 'Hard';

export interface ScoreSubmission {
  name: string;
  score: number;
  durationMs: number;
  mode?: ScoreMode;
  /** Whether the run was won - what the fastest-wins board is built from. */
  won?: boolean;
  /** Which board it belongs on. Easy and Hard runs are never ranked against each other. */
  difficulty?: Difficulty | string;
}

export async function submitScore(entry: ScoreSubmission): Promise<boolean> {
  try {
    const res = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'timeattack', won: false, ...entry }),
    });
    return res.ok;
  } catch {
    // best-effort - a failed submission shouldn't block showing the player their score
    return false;
  }
}

export interface TopScore {
  name: string;
  score: number;
  durationMs: number;
  mode?: ScoreMode;
  won?: 0 | 1;
  difficulty?: string | null;
  createdAt: string;
}

export interface OnlineStanding {
  name: string;
  won: number;
  lost: number;
}

/** The Challenge board: most matches won against other people. */
export async function fetchTopOnline(limit = 10): Promise<OnlineStanding[]> {
  try {
    const res = await fetch(`/api/players/top-online?limit=${limit}`);
    if (!res.ok) return [];
    return (await res.json()) as OnlineStanding[];
  } catch {
    return [];
  }
}

/**
 * `sort: 'fastest'` returns the quickest WON runs, shortest first - a different question
 * from the default board, which ranks by score. A loss never appears on the fastest board.
 */
export async function fetchTopScores(
  limit = 10,
  mode?: ScoreMode,
  sort?: 'score' | 'fastest',
  /** One row per player, their best run - the top ten PLAYERS rather than the top ten runs. */
  perPlayer = true,
  /** One difficulty at a time; omitted means every difficulty together. */
  difficulty?: Difficulty | string
): Promise<TopScore[]> {
  try {
    const query =
      `limit=${limit}${mode ? `&mode=${mode}` : ''}` +
      `${sort === 'fastest' ? '&sort=fastest' : ''}${perPlayer ? '&perPlayer=1' : ''}` +
      `${difficulty ? `&difficulty=${encodeURIComponent(difficulty)}` : ''}`;
    const res = await fetch(`/api/scores/top?${query}`);
    if (!res.ok) return [];
    return (await res.json()) as TopScore[];
  } catch {
    return [];
  }
}
