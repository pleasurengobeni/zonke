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
export async function submitScore(
  name: string,
  score: number,
  durationMs: number,
  mode: ScoreMode = 'timeattack'
): Promise<boolean> {
  try {
    const res = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score, durationMs, mode }),
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
  createdAt: string;
}

export async function fetchTopScores(limit = 10, mode?: ScoreMode): Promise<TopScore[]> {
  try {
    const query = `limit=${limit}${mode ? `&mode=${mode}` : ''}`;
    const res = await fetch(`/api/scores/top?${query}`);
    if (!res.ok) return [];
    return (await res.json()) as TopScore[];
  } catch {
    return [];
  }
}
