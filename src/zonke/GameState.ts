export const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
export type Row = (typeof ROWS)[number];

/** Numeric label shown alongside each letter, matching the original "2-9" description. */
export const ROW_NUMBERS: Record<Row, number> = {
  A: 2,
  B: 3,
  C: 4,
  D: 5,
  E: 6,
  F: 7,
  G: 8,
  H: 9,
};

/** Edge columns are instant-hit columns; the rest use the load-then-kill bullet mechanic. */
export const EDGE_ROWS: Row[] = ['A', 'H'];
export const NORMAL_ROWS: Row[] = ['B', 'C', 'D', 'E', 'F', 'G'];

export const FIGURE_PARTS = [
  'head',
  'spine',
  'leftArm',
  'rightArm',
  'leftLeg',
  'rightLeg',
  'gun',
] as const;
export type FigurePart = (typeof FIGURE_PARTS)[number];

export type LaunchResult = Row | 'ZONKE';

export interface PlayerState {
  name: string;
  drawnParts: boolean[]; // length FIGURE_PARTS.length, true once that specific part has been drawn
  bullets: boolean[]; // length ROWS.length, bullet loaded on that row (aimed at opponent)
  deadRows: boolean[]; // length ROWS.length, true if THIS player was shot on that row
  kills: number;
}

export type TurnResultKind =
  | 'part-drawn'
  | 'figure-completed'
  | 'part-already-drawn'
  | 'bullet-loaded'
  | 'instant-hit'
  | 'kill'
  | 'row-already-dead';

export interface TurnOutcome {
  kind: TurnResultKind;
  result: LaunchResult;
  message: string;
}

export function createPlayer(name: string): PlayerState {
  return {
    name,
    drawnParts: FIGURE_PARTS.map(() => false),
    bullets: ROWS.map(() => false),
    deadRows: ROWS.map(() => false),
    kills: 0,
  };
}

export function isFigureComplete(p: PlayerState): boolean {
  return p.drawnParts.every(Boolean);
}

export function rowIndex(row: Row): number {
  return ROWS.indexOf(row);
}

/** Applies a launch result to the active player. Mutates both player states. */
export function applyLaunch(
  active: PlayerState,
  opponent: PlayerState,
  result: LaunchResult
): TurnOutcome {
  if (!isFigureComplete(active)) {
    // --- Building phase --- every landing (any column, including ZONKE) draws the
    // next part in a fixed sequence: head, spine, arm, arm, leg, leg, gun.
    const partIndex = active.drawnParts.findIndex((drawn) => !drawn);
    active.drawnParts[partIndex] = true;
    const justCompleted = isFigureComplete(active);
    return {
      kind: justCompleted ? 'figure-completed' : 'part-drawn',
      result,
      message: justCompleted
        ? `${active.name} landed on ${result} — figure complete!`
        : `${active.name} landed on ${result} — drew ${FIGURE_PARTS[partIndex]}`,
    };
  }

  // --- Bullet phase ---
  if (result === 'ZONKE') {
    let loaded = 0;
    NORMAL_ROWS.forEach((row) => {
      const i = rowIndex(row);
      if (!active.bullets[i] && !opponent.deadRows[i]) {
        active.bullets[i] = true;
        loaded++;
      }
    });
    return {
      kind: 'bullet-loaded',
      result,
      message: `${active.name} rolled ZONKE — loaded ${loaded} bullet(s)!`,
    };
  }

  const idx = rowIndex(result);

  if (opponent.deadRows[idx]) {
    return {
      kind: 'row-already-dead',
      result,
      message: `Column ${result} on ${opponent.name} is already down — no effect.`,
    };
  }

  if (EDGE_ROWS.includes(result)) {
    // Instant hit on the opponent, no pre-loaded bullet required.
    opponent.deadRows[idx] = true;
    active.kills += 1;
    return {
      kind: 'instant-hit',
      result,
      message: `${active.name} lands on edge column ${result} — instant hit on ${opponent.name}!`,
    };
  }

  if (active.bullets[idx]) {
    opponent.deadRows[idx] = true;
    active.kills += 1;
    return {
      kind: 'kill',
      result,
      message: `${active.name} fires on column ${result} — ${opponent.name} is hit!`,
    };
  }

  active.bullets[idx] = true;
  return {
    kind: 'bullet-loaded',
    result,
    message: `${active.name} loads a bullet on column ${result}.`,
  };
}

export interface WinCheck {
  gameOver: boolean;
  winner?: PlayerState;
  reason?: string;
}

/** Checks whether the game has been decided (kill race with early-out). */
export function checkWin(p1: PlayerState, p2: PlayerState): WinCheck {
  const p1Kills = p1.kills;
  const p2Kills = p2.kills;
  const p1AliveRows = p1.deadRows.filter((d) => !d).length; // rows p1 can still lose (p2 can still kill)
  const p2AliveRows = p2.deadRows.filter((d) => !d).length; // rows p2 can still lose (p1 can still kill)

  const p1MaxPossible = p1Kills + p2AliveRows; // p1's kills come from p2's rows
  const p2MaxPossible = p2Kills + p1AliveRows;

  if (p1Kills > p2MaxPossible) {
    return { gameOver: true, winner: p1, reason: `${p1.name} cannot be caught — wins!` };
  }
  if (p2Kills > p1MaxPossible) {
    return { gameOver: true, winner: p2, reason: `${p2.name} cannot be caught — wins!` };
  }
  if (p1AliveRows === 0 && p2AliveRows === 0) {
    if (p1Kills === p2Kills) {
      return { gameOver: true, reason: 'All rows down — tie game!' };
    }
    const winner = p1Kills > p2Kills ? p1 : p2;
    return { gameOver: true, winner, reason: `${winner.name} wins on kill count!` };
  }
  return { gameOver: false };
}
