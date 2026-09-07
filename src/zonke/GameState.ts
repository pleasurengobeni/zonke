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
 * A finished figure fires by stepping its bullet one letter further across its row. Reaching
 * H only loads the shot - it is the NEXT landing on that row (or a ZONKE) that fires it,
 * takes the opponent's row down and scores.
 */
export function advanceBullet(
  active: PlayerState,
  opponent: PlayerState,
  slot: number,
  stepsSoFar: number,
  playerIndex: 0 | 1
): TurnOutcome {
  const label = rowLabel(slot);

  if (stepsSoFar >= BULLET_STEPS) {
    // The bullet is already sitting on H, so this landing is the one that lets it go.
    opponent.deadRows[slot] = true;
    active.kills += 1;
    return {
      kind: 'kill',
      result: 'H',
      message: `${active.name} fires from row ${label} - ${opponent.name}'s row ${label} is down!`,
    };
  }

  const steps = stepsSoFar + 1;
  // Player 1 lays its dashes from A onwards; player 2 works back from H.
  const letter = playerIndex === 0 ? ROWS[steps - 1] : ROWS[ROWS.length - steps];
  return {
    kind: 'bullet-advanced',
    result: letter,
    message:
      steps === BULLET_STEPS
        ? `${active.name}'s bullet on row ${label} reaches ${letter} - land here again to fire!`
        : `${active.name}'s bullet on row ${label} reaches ${letter}.`,
  };
}

export interface WinCheck {
  gameOver: boolean;
  winner?: PlayerState;
  reason?: string;
}

/**
 * Downing a row takes that slot out of play for both sides, so the ten rows are a pool the
 * two players race each other for. The game is decided once no row is still contested, or
 * as soon as the rows left cannot close the gap.
 */
export function checkWin(p1: PlayerState, p2: PlayerState): WinCheck {
  const contested = p1.deadRows.filter((dead, i) => !dead && !p2.deadRows[i]).length;

  if (p1.kills > p2.kills + contested) {
    return { gameOver: true, winner: p1, reason: `${p1.name} cannot be caught - wins!` };
  }
  if (p2.kills > p1.kills + contested) {
    return { gameOver: true, winner: p2, reason: `${p2.name} cannot be caught - wins!` };
  }
  if (contested === 0) {
    if (p1.kills === p2.kills) {
      return { gameOver: true, reason: `Every row is down - ${p1.kills} all, tie game!` };
    }
    const winner = p1.kills > p2.kills ? p1 : p2;
    return { gameOver: true, winner, reason: `${winner.name} wins on rows taken!` };
  }
  return { gameOver: false };
}
