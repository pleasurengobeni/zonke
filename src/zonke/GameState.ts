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
    bullets: ROWS.map(() => false),
    deadRows: ROWS.map(() => false),
    kills: 0,
  };
}

export function rowIndex(row: Row): number {
  return ROWS.indexOf(row);
}

/**
 * The shooting half of a turn, used only once a row's figure is finished and holding a gun.
 * Which row did the shooting does not matter here - bullets and downed columns are tracked
 * per column, across the whole board.
 */
export function applyBullet(
  active: PlayerState,
  opponent: PlayerState,
  column: Row
): TurnOutcome {
  const idx = rowIndex(column);

  if (opponent.deadRows[idx]) {
    return {
      kind: 'row-already-dead',
      result: column,
      message: `Column ${column} on ${opponent.name} is already down - no effect.`,
    };
  }

  if (EDGE_ROWS.includes(column)) {
    // Instant hit on the opponent, no pre-loaded bullet required.
    opponent.deadRows[idx] = true;
    active.kills += 1;
    return {
      kind: 'instant-hit',
      result: column,
      message: `${active.name} lands on edge column ${column} - instant hit on ${opponent.name}!`,
    };
  }

  if (active.bullets[idx]) {
    opponent.deadRows[idx] = true;
    active.kills += 1;
    return {
      kind: 'kill',
      result: column,
      message: `${active.name} fires on column ${column} - ${opponent.name} is hit!`,
    };
  }

  active.bullets[idx] = true;
  return {
    kind: 'bullet-loaded',
    result: column,
    message: `${active.name} loads a bullet on column ${column}.`,
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
