// Fire-and-forget analytics: every call posts to the API and swallows any failure, since
// a dropped stats event should never be allowed to interrupt or crash actual gameplay.
const SESSION_KEY = 'zonke_session_id';

function sessionId(): string {
  try {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // localStorage can throw in a private tab - fall back to a per-load id rather than
    // let analytics ever be the reason the page breaks.
    return crypto.randomUUID();
  }
}

export function track(type: string, payload?: Record<string, unknown>): void {
  try {
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId(),
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
export interface ScoreSubmission {
  name: string;
  score: number;
  durationMs: number;
  mode?: ScoreMode;
  /** Whether the run was won - what the fastest-wins board is built from. */
  won?: boolean;
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
  createdAt: string;
}

/**
 * `sort: 'fastest'` returns the quickest WON runs, shortest first - a different question
 * from the default board, which ranks by score. A loss never appears on the fastest board.
 */
export async function fetchTopScores(
  limit = 10,
  mode?: ScoreMode,
  sort?: 'score' | 'fastest'
): Promise<TopScore[]> {
  try {
    const query = `limit=${limit}${mode ? `&mode=${mode}` : ''}${sort === 'fastest' ? '&sort=fastest' : ''}`;
    const res = await fetch(`/api/scores/top?${query}`);
    if (!res.ok) return [];
    return (await res.json()) as TopScore[];
  } catch {
    return [];
  }
}
