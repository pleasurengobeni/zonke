export const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
export type Row = (typeof ROWS)[number];

/** Board rows, numbered 1 at the bottom up to BOARD_ROWS at the top. */
export const BOARD_ROWS = 10;

/** A bullet steps one letter per landing; once it passes H it reaches the other side. */
export const BULLET_STEPS = ROWS.length;

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
  deadRows: boolean[]; // length BOARD_ROWS, true once THIS player's row has been shot
  kills: number;
}

export type TurnResultKind =
  | 'part-drawn'
  | 'figure-completed'
  | 'bullet-advanced'
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
    deadRows: Array.from({ length: BOARD_ROWS }, () => false),
    kills: 0,
  };
}

/** Row slot 0 is the top row, drawn as row BOARD_ROWS on the board. */
export function rowLabel(slot: number): number {
  return BOARD_ROWS - slot;
}

/**
 * A finished figure fires by stepping its bullet one letter further across its row. The
 * shot only counts when the bullet clears H and reaches the other side.
 */
export function advanceBullet(
  active: PlayerState,
  opponent: PlayerState,
  slot: number,
  stepsSoFar: number
): TurnOutcome {
  const steps = stepsSoFar + 1;
  const label = rowLabel(slot);

  if (steps >= BULLET_STEPS) {
    opponent.deadRows[slot] = true;
    active.kills += 1;
    return {
      kind: 'kill',
      result: ROWS[ROWS.length - 1],
      message: `${active.name}'s bullet clears H on row ${label} - ${opponent.name} is hit!`,
    };
  }

  return {
    kind: 'bullet-advanced',
    result: ROWS[steps],
    message: `${active.name}'s bullet on row ${label} reaches ${ROWS[steps]}.`,
  };
}

export interface WinCheck {
  gameOver: boolean;
  winner?: PlayerState;
  reason?: string;
}

/** Decided when one side has no rows left standing, or the lead can no longer be caught. */
export function checkWin(p1: PlayerState, p2: PlayerState): WinCheck {
  const p1Alive = p1.deadRows.filter((d) => !d).length;
  const p2Alive = p2.deadRows.filter((d) => !d).length;

  if (p1Alive === 0) {
    return { gameOver: true, winner: p2, reason: `${p2.name} shot every row down - wins!` };
  }
  if (p2Alive === 0) {
    return { gameOver: true, winner: p1, reason: `${p1.name} shot every row down - wins!` };
  }
  if (p1.kills > p2.kills + p1Alive) {
    return { gameOver: true, winner: p1, reason: `${p1.name} cannot be caught - wins!` };
  }
  if (p2.kills > p1.kills + p2Alive) {
    return { gameOver: true, winner: p2, reason: `${p2.name} cannot be caught - wins!` };
  }
  return { gameOver: false };
}
