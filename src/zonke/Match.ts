// The game, with no renderer attached.
//
// Everything below works in BOARD UNITS, not pixels: y is measured in rows from the top of
// the grid (0) to the bottom (BOARD_ROWS), the ZONKE band is negative y, and x runs across
// the eight columns. A renderer maps that onto whatever it draws - a flat canvas, or a
// table tilted back in 3D - without the simulation knowing or caring which.
//
// The constants are the 2D game's tuned pixel values divided by its design row height
// (88 * 0.92 = 80.96px), so the feel is carried over exactly rather than re-guessed: the
// same charge still reaches the same row, and the ZONKE band is still the same sliver of
// the charge. Working in rows also makes the physics genuinely device-independent, which
// the pixel version only approximated by rescaling every constant per screen.
import {
  ROWS as LETTERS,
  BOARD_ROWS,
  BULLET_STEPS,
  FIGURE_PARTS,
  advanceBullet,
  checkWin,
  createPlayer,
  rowLabel,
  type LaunchResult,
  type PlayerState,
  type Row,
  type TurnOutcome,
} from './GameState';

const DESIGN_ROW_H = 88 * 0.92; // the 2D board's row height at scale 1, the unit everything below came from

export const COLS = LETTERS.length;
/** Width of one column, in row-units - the design board's cell aspect (132px / 80.96px). */
export const CELL_W = 132 / DESIGN_ROW_H;
export const BOARD_W = COLS * CELL_W;

const FRICTION = 0.3 / DESIGN_ROW_H; // speed scrubbed off every 16ms step
const STOP_SPEED = 0.35 / DESIGN_ROW_H; // below this the ball has come to rest
const BALL_R = 12 / DESIGN_ROW_H;
const WALL_BOUNCE = 0.85;
const BOUNCE_SPREAD = 0.15; // radians either side, off the wall above ZONKE
const POWER_MAX = 1.55; // 1.0 reaches the ZONKE band; past that is the wall
// Where a charge of nothing comes to rest: just inside the BOTTOM of row 1, not its
// centre. With the floor at the centre, only half of row 1 was reachable at all - half a
// row's worth of charge out of ten - which made landing there feel impossible.
const APEX_FLOOR = BOARD_ROWS + 0.1;
const APEX_SPAN = APEX_FLOOR + 5 / DESIGN_ROW_H; // travel from there to just inside the band
export const LAUNCH_Y = (956.8 + 42 - 147.2) / DESIGN_ROW_H; // the launcher, below the grid
const STEP_MS = 1000 / 60;

export const SPLIT_MIN_BALLS = 2;
export const SPLIT_MAX_BALLS = 5;
const SPLIT_SPAWN_CHANCE = 0.01;
const SPLIT_WINDOW_MS = 15_000;

export interface EngineMode {
  name: string;
  zonkeBand: number; // rows of resting room above row 10 - thinner is harder
  chargeMs: number;
  jitter: number;
  cpuAim: number;
  cpuError: number;
}

export const MODES: EngineMode[] = [
  { name: 'Easy', zonkeBand: 95 / DESIGN_ROW_H, chargeMs: 1900, jitter: 0, cpuAim: 0.1, cpuError: 0.6 },
  { name: 'Moderate', zonkeBand: 55 / DESIGN_ROW_H, chargeMs: 1300, jitter: 0.04, cpuAim: 0.45, cpuError: 0.18 },
  { name: 'Hard', zonkeBand: 31 / DESIGN_ROW_H, chargeMs: 1000, jitter: 0.08, cpuAim: 0.6, cpuError: 0.1 },
];

export interface Ball {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  resting: boolean;
  hitWall: boolean;
  fromSplit: boolean;
}

export interface Landing {
  result: LaunchResult;
  slot: number;
  overCharged: boolean;
}

export interface GameOverInfo {
  winnerIndex: 0 | 1;
  reason: string;
  kills: [number, number];
  durationMs: number;
}

/** Everything the renderer is told about. All optional - a view can ignore what it likes. */
export interface MatchListener {
  onMessage?(text: string): void;
  onTurn?(activeIndex: 0 | 1): void;
  onLaunch?(ball: Ball): void;
  onSplit?(count: number, slot: number, origin: Ball): void;
  onBallsChanged?(): void;
  onBoardChanged?(): void;
  onSpecialRowsChanged?(): void;
  onGameOver?(info: GameOverInfo): void;
}

interface Timer {
  at: number;
  run: () => void;
}

/**
 * Every random number a match makes comes from its own stream, never from Math.random.
 *
 * That is what makes an online game possible: two browsers running this engine from the
 * same seed, fed the same shots in the same order, produce byte-identical matches - the
 * same wall bounces, the same split, the same rows turning gold. Only the power of each
 * shot has to cross the network; everything else is reproduced rather than transmitted.
 */
export type Rng = () => number;

/** mulberry32 - small, fast, and identical in every JS engine. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Match {
  readonly mode: EngineMode;
  private readonly rng: Rng;
  private readonly cpuPlays: boolean;
  private readonly splitWindowTurns: number;
  private splitTurnsLeft = 0;
  readonly players: [PlayerState, PlayerState];
  activeIndex: 0 | 1 = 0;

  /** [rowSlot][player] - how far that row's bullet has stepped across the letters. */
  rowBullets: number[][] = [];
  /** [rowSlot][player] - how many figure parts that row has earned. */
  rowFigureParts: number[][] = [];

  balls: Ball[] = [];
  phase: 'ready' | 'charging' | 'flying' | 'resolving' | 'over' = 'ready';

  bonusRow: number | null = null;
  lifelineRow: number | null = null;
  lifelineMultiplier = 2;
  splitRow: number | null = null;
  splitSecondsLeft = 0;

  elapsedMs = 0;
  private endedAtMs: number | null = null;
  private timers: Timer[] = [];
  private accumulator = 0;
  private chargeStartedAt = 0;
  private landings: Landing[] = [];
  private splitUsedThisTurn = false;
  private splitSeenThisGame = false;
  private splitExpiresAt = 0;
  private bonusTurnsLeft = 0;
  private bonusJustHit = false;
  private nextBallId = 1;

  constructor(
    mode: EngineMode,
    playerName: string,
    private readonly listener: MatchListener = {},
    options: { rng?: Rng; opponentName?: string; cpu?: boolean; splitWindowTurns?: number } = {}
  ) {
    this.mode = mode;
    this.rng = options.rng ?? Math.random;
    // Online, player two is another person - nothing should be taking their turn for them.
    this.cpuPlays = options.cpu ?? true;
    // Two browsers cannot agree on a wall clock to the millisecond, and the green row's
    // deadline has to be a thing both of them decide identically - so an online match
    // measures that window in TURNS, which both sides count the same way, while a local
    // match keeps the fifteen seconds.
    this.splitWindowTurns = options.splitWindowTurns ?? 0;
    this.players = [createPlayer(playerName), createPlayer(options.opponentName ?? 'CPU')];
    this.rowBullets = Array.from({ length: BOARD_ROWS }, () => [0, 0]);
    this.rowFigureParts = Array.from({ length: BOARD_ROWS }, () => [0, 0]);
    this.pickBonusRow();
    this.armBall();
  }

  /** Both helpers draw from this match's own stream, never from Math.random. */
  private between(min: number, max: number): number {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }

  private floatBetween(min: number, max: number): number {
    return min + this.rng() * (max - min);
  }

  get durationMs(): number {
    return this.endedAtMs ?? this.elapsedMs;
  }

  get isCpuTurn(): boolean {
    return this.cpuPlays && this.activeIndex === 1;
  }

  /** Whether a shot can be taken right now - the online controller gates on this. */
  get canShoot(): boolean {
    return this.phase === 'ready';
  }

  /**
   * Fires a shot of a given power, whoever it came from. Online, both players' shots
   * arrive this way - the local one straight from the release, the remote one from the
   * network - so the two engines consume their random streams in the same order.
   */
  fireShot(power: number): boolean {
    if (this.phase !== 'ready') return false;
    this.launch(power);
    return true;
  }

  /**
   * The power a charge of this many milliseconds would produce, jitter included.
   *
   * The jitter deliberately does NOT come from the match's shared stream: only the shooter
   * calls this, so drawing from the shared stream would advance one player's sequence and
   * not the other's, and the two boards would quietly drift apart. The number this returns
   * is sent over the wire anyway, so its randomness has no one to agree with.
   */
  powerForHold(heldMs: number): number {
    const base = Math.min(POWER_MAX, (heldMs / this.mode.chargeMs) * POWER_MAX);
    const jitter = (Math.random() * 2 - 1) * this.mode.jitter;
    return Math.max(0, Math.min(POWER_MAX, base + jitter));
  }

  /** The charge held so far, 0..POWER_MAX - for a view that wants to show it. */
  get charge(): number {
    if (this.phase !== 'charging') return 0;
    return Math.min(POWER_MAX, ((this.elapsedMs - this.chargeStartedAt) / this.mode.chargeMs) * POWER_MAX);
  }

  /** Where a given power brings the ball to rest - this IS the row mapping. */
  restingYFor(power: number): number {
    return APEX_FLOOR - power * APEX_SPAN;
  }

  /** The wall above ZONKE: the band's top, never above the board's own ceiling. */
  get wallY(): number {
    return Math.max(-this.mode.zonkeBand, -1.2);
  }

  rowSlotAt(y: number): number {
    return Math.min(BOARD_ROWS - 1, Math.max(0, Math.floor(y)));
  }

  columnAt(x: number): number {
    return Math.min(COLS - 1, Math.max(0, Math.floor(x / CELL_W)));
  }

  // ---- input ---------------------------------------------------------------------

  startCharge(): void {
    if (this.phase !== 'ready' || this.isCpuTurn) return;
    this.phase = 'charging';
    this.chargeStartedAt = this.elapsedMs;
    this.listener.onMessage?.('Charging - release to launch');
  }

  release(): void {
    if (this.phase !== 'charging') return;
    const power = this.charge + this.floatBetween(-this.mode.jitter, this.mode.jitter);
    this.phase = 'ready';
    this.launch(power);
  }

  // ---- the loop ------------------------------------------------------------------

  /** Advances the match by a frame. The view calls this and then draws whatever it sees. */
  update(deltaMs: number): void {
    if (this.phase === 'over') return;
    const dt = Math.min(deltaMs, 100); // a backgrounded tab must not teleport the ball
    this.elapsedMs += dt;
    this.runTimers();
    this.tickSplitWindow(dt);

    if (this.phase !== 'flying') return;
    this.accumulator += dt;
    let guard = 0;
    while (this.accumulator >= STEP_MS && this.phase === 'flying' && guard++ < 8) {
      this.accumulator -= STEP_MS;
      // A ball settling on the green row appends its splinters mid-step, so step a
      // snapshot: the new balls start moving on the next step, not halfway through this one.
      for (const ball of [...this.balls]) {
        if (!ball.resting) this.stepBall(ball);
      }
    }
  }

  private runTimers(): void {
    if (this.timers.length === 0) return;
    const due = this.timers.filter((t) => t.at <= this.elapsedMs);
    if (due.length === 0) return;
    this.timers = this.timers.filter((t) => t.at > this.elapsedMs);
    due.forEach((t) => t.run());
  }

  private after(ms: number, run: () => void): void {
    this.timers.push({ at: this.elapsedMs + ms, run });
  }

  // ---- flight --------------------------------------------------------------------

  private armBall(): void {
    this.phase = 'ready';
    // A real ball, resting on the launcher - not an empty list with the ball conjured into
    // existence at launch. The player has to be able to see what they are about to fire.
    this.balls = [
      {
        id: this.nextBallId++,
        x: BOARD_W / 2,
        y: LAUNCH_Y,
        vx: 0,
        vy: 0,
        resting: true,
        hitWall: false,
        fromSplit: false,
      },
    ];
    this.landings = [];
    this.splitUsedThisTurn = false;
    this.accumulator = 0;
    this.listener.onBallsChanged?.();
    if (this.isCpuTurn) this.after(500, () => this.takeCpuTurn());
  }

  /** A snapshot of everything two engines must agree on, for the desync check. */
  stateDigest(): string {
    return JSON.stringify({
      active: this.activeIndex,
      phase: this.phase,
      kills: this.players.map((p) => p.kills),
      dead: this.players.map((p) => p.deadRows.join('')),
      parts: this.rowFigureParts,
      bullets: this.rowBullets,
      bonus: this.bonusRow,
      lifeline: this.lifelineRow,
      split: this.splitRow,
      balls: this.balls.map((b) => [b.x.toFixed(6), b.y.toFixed(6), b.resting]),
    });
  }

  /** The CPU goes for the jackpot, missing by however much its mode allows. */
  private takeCpuTurn(): void {
    if (this.phase !== 'ready') return;
    const low = APEX_FLOOR / APEX_SPAN;
    const high = (APEX_FLOOR - this.wallY) / APEX_SPAN;
    const target = (low + high) / 2;
    const goesForIt = this.rng() < this.mode.cpuAim;
    const drift = ((this.rng() + this.rng() + this.rng() - 1.5) / 1.5) * this.mode.cpuError * POWER_MAX;
    const power = goesForIt ? target + drift : this.floatBetween(0, POWER_MAX);
    this.listener.onMessage?.('CPU is lining up a shot...');
    this.after(600, () => this.launch(power));
  }

  private launch(rawPower: number): void {
    if (this.phase !== 'ready') return;
    const power = Math.min(POWER_MAX, Math.max(0, rawPower));
    // Power buys distance; friction then eats exactly that much, so the ball coasts to a
    // stop at the height the charge promised. Aim a half-step past, since stepping in whole
    // frames loses about half a frame of travel.
    const target = Math.max(LAUNCH_Y - this.restingYFor(power), 0.01);
    const distance = target + Math.sqrt(2 * FRICTION * target) / 2;
    // The parked ball is the one that flies - keeping its id means the view animates the
    // same object rather than swapping one out for another at the moment of launch.
    const ball = this.balls[0];
    ball.x = BOARD_W / 2;
    ball.y = LAUNCH_Y;
    ball.vx = 0; // straight up - the shot has no sideways component of its own
    ball.vy = -Math.sqrt(2 * FRICTION * distance);
    ball.resting = false;
    ball.hitWall = false;
    this.balls = [ball];
    this.landings = [];
    this.splitUsedThisTurn = false;
    this.phase = 'flying';
    this.listener.onLaunch?.(ball);
    this.listener.onBallsChanged?.();
  }

  /** One 16ms tick for one ball: friction bleeds momentum, walls turn it around. */
  private stepBall(ball: Ball): void {
    const speed = Math.hypot(ball.vx, ball.vy);
    const slowed = speed - FRICTION;
    if (speed < STOP_SPEED || slowed <= 0) {
      this.settleBall(ball);
      return;
    }
    const scale = slowed / speed;
    ball.vx *= scale;
    ball.vy *= scale;
    ball.x += ball.vx;
    ball.y += ball.vy;

    if (ball.x < BALL_R) {
      ball.x = BALL_R;
      ball.vx = Math.abs(ball.vx) * WALL_BOUNCE;
    } else if (ball.x > BOARD_W - BALL_R) {
      ball.x = BOARD_W - BALL_R;
      ball.vx = -Math.abs(ball.vx) * WALL_BOUNCE;
    }

    // The wall above ZONKE is the one thing that sends it back, on a random angle.
    if (ball.y < this.wallY) {
      ball.y = this.wallY;
      const bounced = Math.hypot(ball.vx, ball.vy) * WALL_BOUNCE;
      const angle = this.floatBetween(-BOUNCE_SPREAD, BOUNCE_SPREAD);
      ball.vx = bounced * Math.sin(angle);
      ball.vy = bounced * Math.cos(angle);
      ball.hitWall = true;
    }

    if (ball.y > LAUNCH_Y) {
      ball.y = LAUNCH_Y;
      ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE;
    }
  }

  private settleBall(ball: Ball): void {
    ball.resting = true;
    ball.vx = 0;
    ball.vy = 0;
    // A ball that trickles to a stop below row 1 still scores row 1, so park it there.
    if (ball.y > BOARD_ROWS) ball.y = BOARD_ROWS - 0.5;

    const jackpot = ball.y < 0;
    const result: LaunchResult = jackpot ? 'ZONKE' : (LETTERS[this.columnAt(ball.x)] as Row);
    const slot = this.rowSlotAt(ball.y);
    this.landings.push({ result, slot, overCharged: ball.hitWall && !jackpot });

    if (!jackpot && !ball.fromSplit && !this.splitUsedThisTurn && slot === this.splitRow) {
      this.splitBall(ball, slot);
      return;
    }
    if (this.balls.every((b) => b.resting)) this.onAllSettled();
  }

  /** The green row's payoff: 2-5 balls, each with its own random speed and heading. */
  private splitBall(origin: Ball, slot: number): void {
    this.splitUsedThisTurn = true;
    const count = this.between(SPLIT_MIN_BALLS, SPLIT_MAX_BALLS);
    for (let i = 0; i < count; i++) {
      const angle = this.floatBetween(-2.2, 2.2); // fanned around straight up
      const distance = APEX_SPAN * this.floatBetween(0.15, 1);
      const speed = Math.sqrt(2 * FRICTION * distance);
      this.balls.push({
        id: this.nextBallId++,
        x: origin.x,
        y: origin.y,
        vx: speed * Math.sin(angle),
        vy: -speed * Math.cos(angle),
        resting: false,
        hitWall: false,
        fromSplit: true,
      });
    }
    this.listener.onSplit?.(count, slot, origin);
    this.listener.onBallsChanged?.();
    this.listener.onMessage?.(`SPLIT! The ball burst into ${count} - every one of them scores.`);
  }

  private onAllSettled(): void {
    this.phase = 'resolving';
    const landings = this.landings;
    const activeAtLaunch = this.activeIndex;
    this.after(450, () => this.resolve(activeAtLaunch, landings));
  }

  // ---- resolution ----------------------------------------------------------------

  private resolve(activeIndexAtLaunch: 0 | 1, landings: Landing[]): void {
    const active = this.players[activeIndexAtLaunch];
    const opponent = this.players[1 - activeIndexAtLaunch];
    const didSplit = this.splitUsedThisTurn;

    let bonusHit = false;
    let kills = 0;
    let lastMessage = '';
    landings.forEach((landing) => {
      const outcome = this.applyToBoard(activeIndexAtLaunch, landing.result, landing.slot, active, opponent);
      if (this.bonusJustHit) bonusHit = true;
      if (outcome.kind === 'kill') kills += 1;
      lastMessage = landing.overCharged
        ? `Too much power - the wall threw it back. ${outcome.message}`
        : outcome.message;
    });
    this.bonusJustHit = bonusHit;

    const headline = didSplit
      ? `Split into ${landings.length - 1} balls${kills > 0 ? ` - ${kills} row(s) down!` : ''}. `
      : '';
    this.listener.onMessage?.(`${headline}${lastMessage}`);
    this.ensureLifeline();
    this.tickSplitRow(didSplit);
    this.listener.onBoardChanged?.();

    const win = checkWin(this.players[0], this.players[1]);
    if (win.gameOver && win.winner) {
      this.phase = 'over';
      this.endedAtMs = this.elapsedMs;
      this.listener.onGameOver?.({
        winnerIndex: win.winner === this.players[0] ? 0 : 1,
        reason: win.reason ?? 'Game over',
        kills: [this.players[0].kills, this.players[1].kills],
        durationMs: this.durationMs,
      });
      return;
    }

    if (win.suddenDeath) {
      // Never a draw: wipe the board and keep playing. Kills carry over.
      this.players.forEach((p) => p.deadRows.fill(false));
      this.rowBullets = Array.from({ length: BOARD_ROWS }, () => [0, 0]);
      this.rowFigureParts = Array.from({ length: BOARD_ROWS }, () => [0, 0]);
      this.pickBonusRow();
      this.ensureLifeline();
      this.listener.onBoardChanged?.();
      this.listener.onMessage?.(
        `${this.players[0].kills} all with no rows left - sudden death! Board reset.`
      );
    }

    if (!this.bonusJustHit) {
      this.bonusTurnsLeft -= 1;
      if (this.bonusTurnsLeft <= 0) this.pickBonusRow();
    }

    this.activeIndex = (1 - activeIndexAtLaunch) as 0 | 1;
    this.listener.onTurn?.(this.activeIndex);
    this.armBall();
  }

  private applyToBoard(
    playerIndex: 0 | 1,
    result: LaunchResult,
    slot: number,
    active: PlayerState,
    opponent: PlayerState
  ): TurnOutcome {
    const slots = result === 'ZONKE' ? Array.from({ length: BOARD_ROWS }, (_r, i) => i) : [slot];
    const live = slots.filter((row) => !opponent.deadRows[row] && !active.deadRows[row]);

    if (live.length === 0) {
      return {
        kind: 'row-already-dead',
        result,
        message: `Row ${rowLabel(slot)} on ${opponent.name} is already down - no effect.`,
      };
    }

    let drew = 0;
    let last: TurnOutcome | null = null;
    let bonusHit = false;
    let lifelineHit = 0;

    live.forEach((row) => {
      let times = 1;
      if (result !== 'ZONKE') {
        if (row === this.bonusRow) {
          times = 2;
          bonusHit = true;
        } else if (row === this.lifelineRow && this.isTrailing(playerIndex)) {
          times = this.lifelineMultiplier;
          lifelineHit = this.lifelineMultiplier;
        }
      }
      for (let i = 0; i < times; i++) {
        if (opponent.deadRows[row] || active.deadRows[row]) break;
        if (this.rowFigureParts[row][playerIndex] < FIGURE_PARTS.length) {
          this.rowFigureParts[row][playerIndex] += 1;
          drew += 1;
          continue;
        }
        last = advanceBullet(active, opponent, row, this.rowBullets[row][playerIndex], playerIndex);
        this.rowBullets[row][playerIndex] = Math.min(BULLET_STEPS, this.rowBullets[row][playerIndex] + 1);
      }
    });

    if (bonusHit) this.pickBonusRow();
    this.bonusJustHit = bonusHit;
    if (lifelineHit > 0) this.lifelineRow = null;
    const prefix = bonusHit ? '2x row! ' : lifelineHit > 0 ? `${lifelineHit}x LIFELINE! ` : '';

    if (last) {
      const fired = last as TurnOutcome;
      return drew > 0
        ? { ...fired, message: `${prefix}${fired.message} (+${drew} row(s) drew a part)` }
        : { ...fired, message: `${prefix}${fired.message}` };
    }

    const part = FIGURE_PARTS[this.rowFigureParts[live[0]][playerIndex] - 1];
    return {
      kind:
        this.rowFigureParts[live[0]][playerIndex] === FIGURE_PARTS.length
          ? 'figure-completed'
          : 'part-drawn',
      result,
      message:
        result === 'ZONKE'
          ? `${active.name} hit ZONKE - ${drew} row(s) drew their next part!`
          : `${prefix}${active.name} landed on row ${rowLabel(slot)} - drew ${part}`,
    };
  }

  // ---- the three special rows -----------------------------------------------------

  private pickBonusRow(): void {
    let next = this.bonusRow;
    do {
      next = this.between(0, BOARD_ROWS - 1);
    } while (next === this.bonusRow || next === this.lifelineRow || next === this.splitRow);
    this.bonusRow = next;
    this.bonusTurnsLeft = this.between(3, 6);
    this.listener.onSpecialRowsChanged?.();
  }

  private ensureLifeline(): void {
    const [p1, p2] = this.players;
    if (p1.kills === p2.kills) {
      this.lifelineRow = null;
      this.listener.onSpecialRowsChanged?.();
      return;
    }
    if (this.lifelineRow !== null) return;
    let next: number;
    do {
      next = this.between(0, BOARD_ROWS - 1);
    } while (next === this.bonusRow || next === this.splitRow);
    this.lifelineRow = next;
    this.lifelineMultiplier = this.between(2, 3);
    this.listener.onSpecialRowsChanged?.();
  }

  private isTrailing(playerIndex: 0 | 1): boolean {
    return this.players[playerIndex].kills < this.players[1 - playerIndex].kills;
  }

  /**
   * Rolls for the match's one green row. It has to be rolled for, it lasts fifteen seconds,
   * and once that window is spent no second one opens for the rest of the game - plenty of
   * matches finish without ever seeing one, which is the whole point of it.
   */
  private tickSplitRow(claimed: boolean): void {
    if (claimed) {
      this.closeSplitRow();
      return;
    }
    if (this.splitRow !== null) {
      if (this.splitWindowTurns > 0) {
        this.splitTurnsLeft -= 1;
        this.splitSecondsLeft = this.splitTurnsLeft;
        if (this.splitTurnsLeft <= 0) this.closeSplitRow();
      }
      return;
    }
    if (this.splitSeenThisGame) return;
    if (this.rng() >= SPLIT_SPAWN_CHANCE) return;

    let next: number;
    do {
      next = this.between(0, BOARD_ROWS - 1);
    } while (next === this.bonusRow || next === this.lifelineRow);
    this.splitRow = next;
    this.splitSeenThisGame = true;
    this.splitExpiresAt = this.elapsedMs + SPLIT_WINDOW_MS;
    this.splitTurnsLeft = this.splitWindowTurns;
    this.splitSecondsLeft = this.splitWindowTurns > 0 ? this.splitWindowTurns : SPLIT_WINDOW_MS / 1000;
    this.listener.onSpecialRowsChanged?.();
    this.listener.onMessage?.(
      this.splitWindowTurns > 0
        ? `A GREEN SPLIT ROW opened on row ${rowLabel(next)} - ${this.splitWindowTurns} turns to land on it!`
        : `A GREEN SPLIT ROW opened on row ${rowLabel(next)} - ${SPLIT_WINDOW_MS / 1000} seconds to land on it!`
    );
  }

  /**
   * The open row's fifteen seconds, counted down in real time. Held while a ball is in the
   * air or a charge is building: a shot already on its way to the green row has earned its
   * chance, and shutting the window underneath it would just read as a cheat.
   */
  private tickSplitWindow(dt: number): void {
    if (this.splitRow === null) return;
    if (this.splitWindowTurns > 0) return; // counted in turns instead - see the constructor
    if (this.phase === 'flying' || this.phase === 'charging' || this.phase === 'resolving') {
      // Genuinely held, not merely unchecked: the deadline moves with the clock, so a long
      // flight or a slow charge costs the player none of their fifteen seconds.
      this.splitExpiresAt += dt;
      return;
    }
    const left = Math.ceil((this.splitExpiresAt - this.elapsedMs) / 1000);
    if (left <= 0) {
      this.closeSplitRow();
      return;
    }
    this.splitSecondsLeft = left;
  }

  private closeSplitRow(): void {
    if (this.splitRow === null) return;
    this.splitRow = null;
    this.splitSecondsLeft = 0;
    this.splitTurnsLeft = 0;
    this.listener.onSpecialRowsChanged?.();
  }
}
