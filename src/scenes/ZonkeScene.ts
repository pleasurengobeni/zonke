import Phaser from 'phaser';
import { track, submitScore, fetchTopScores } from '../analytics';
import { ensurePlayerName, storedPlayerName, DEFAULT_NAME } from '../player';
import {
  ROWS,
  BULLET_STEPS,
  FIGURE_PARTS,
  createPlayer,
  advanceBullet,
  rowLabel,
  checkWin,
  type PlayerState,
  type LaunchResult,
  type Row,
  type TurnOutcome,
} from '../zonke/GameState';

// The ball is shot up the board and friction bleeds its momentum away until it stops -
// wherever it comes to rest IS the result. It never falls back down; the only thing that
// turns it around is the wall above the ZONKE row.
// FRICTION, STOP_SPEED and BALL_R are all tuned at a 1160-tall design canvas (S = 1) and
// rescaled by computeLayout() below - without that, the same absolute px/frame friction on
// a phone-sized board would eat a much bigger fraction of the flight than on a desktop one,
// silently drifting every mode's difficulty by device.
let FRICTION = 0.3; // speed scrubbed off every 16ms frame, at S = 1
let STOP_SPEED = 0.35; // below this the ball has come to rest, at S = 1
const WALL_BOUNCE = 0.85; // energy kept bouncing off a wall (sides, and the one above ZONKE)
const BOUNCE_SPREAD = 0.15; // how wide the wall can kick the ball off (radians either side)
const POWER_MAX = 1.55; // 1.0 reaches row 10; past that is the ZONKE band, then the wall
let BALL_R = 12;


interface Mode {
  name: string;
  zonkeBand: number; // px of resting room above row 10 - thinner is harder
  chargeMs: number; // a faster bar makes that band a shorter moment in real time
  jitter: number; // random power the shot picks up on release
  cpuAim: number; // how often the CPU actually goes for the jackpot
  cpuError: number; // how far its aim drifts when it does
}

// Two levers make ZONKE harder: the wall drops so there is less room to stop in above row
// 10, and the bar charges faster so that room passes sooner. Measured windows are roughly
// 365ms of a 1900ms charge on Easy, 156ms of 1300ms on Moderate, 65ms of 1000ms on Hard.
// zonkeBand is tuned at S = 1 like the physics above, and read through wallY() which
// applies the same scale factor, so the odds hold steady across screen sizes.
const MODES: Mode[] = [
  { name: 'Easy', zonkeBand: 95, chargeMs: 1900, jitter: 0, cpuAim: 0.1, cpuError: 0.6 },
  { name: 'Moderate', zonkeBand: 55, chargeMs: 1300, jitter: 0.04, cpuAim: 0.45, cpuError: 0.18 },
  { name: 'Hard', zonkeBand: 31, chargeMs: 1000, jitter: 0.08, cpuAim: 0.6, cpuError: 0.1 },
];

const P1_COLOR = '#4caf50';
const P2_COLOR = '#2196f3';
const P1_COLOR_HEX = 0x4caf50;
const P2_COLOR_HEX = 0x2196f3;
const KILL_COLOR = '#ff5252';
const NEUTRAL_COLOR = '#888888';
const SPLIT_COLOR = '#00e676';
const SPLIT_COLOR_HEX = 0x00e676;

// The split row's payout: landing on it bursts the ball into this many new ones, each with
// its own random speed and heading, and every one of them scores where it stops.
const SPLIT_MIN_BALLS = 2;
const SPLIT_MAX_BALLS = 5;

// It is a rare event, not a fixture. Most turns there is no green row on the board at all,
// and plenty of matches finish without one ever opening - that scarcity is the point, and
// it is what keeps a split feeling like luck rather than another row to farm. At roughly a
// 1-in-100 roll per turn, gated by a cooldown after each one closes, a typical match sees
// about one open, and close to half of them see none.
// At most ONE green row per match, and only if the roll goes that way: it opens for fifteen
// seconds, and it is gone for the rest of that game the moment it is hit or the clock runs
// out - whichever comes first.
// Measured against a ~70-turn match (see scripts/check-features.mjs), a 1-in-100 roll per
// turn opens one in roughly half of matches - the other half finish without ever seeing it.
const SPLIT_SPAWN_CHANCE = 0.01; // rolled once per turn, until the one chance is spent
const SPLIT_WINDOW_MS = 15_000;

/**
 * One ball in flight. A shot starts as a single ball, but the split row turns it into
 * several at once, so every bit of physics below works over a list instead of one fixed
 * set of coordinates.
 */
interface FlightBall {
  gfx: Phaser.GameObjects.Arc;
  x: number;
  y: number;
  vx: number;
  vy: number;
  resting: boolean;
  hitWall: boolean;
  fromSplit: boolean;
}

/** Where one ball came to rest, waiting to be applied to the board. */
interface Landing {
  result: LaunchResult;
  slot: number;
  overCharged: boolean;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// The whole board is designed on a 1500x1160 canvas; every position below is expressed as
// a fraction of that design and re-applied to whatever size Phaser actually hands the scene,
// so the game fills the real device instead of being letterboxed or centred with dead space.
// Width and height scale independently - the grid keeps the same share of the real width
// (so player margins scale with a phone's narrow screen too), while S scales everything
// vertical (rows, chrome, type, physics) off the real height, since ten rows have to fit
// however tall or short the screen is.
const DESIGN_W = 1500;
const DESIGN_H = 1160;
const DESIGN_GRID_W = 1056; // 8 columns x 132px in the original design

let S = 1; // vertical/uniform scale: real height over the 1160 design height
let CANVAS_W = DESIGN_W;
let CANVAS_H = DESIGN_H;
let CENTER_X = CANVAS_W / 2;
let CELL_W = 132;
let GRID_LEFT = CENTER_X - (ROWS.length * CELL_W) / 2;
let GRID_RIGHT = GRID_LEFT + ROWS.length * CELL_W;
// The match clock lives in a band above the board; the board itself is scaled down a
// notch to pay for that band rather than pushing the bottom chrome off short screens.
let TOP_BAR_H = 46;
const BOARD_SHRINK = 0.92;
let HEADER_TOP = TOP_BAR_H;
let HEADER_H = 110;
let ROW_H = 88; // full row height, sized so a figure fits between rows without crowding
// The figures live out in the margins, one per row per side, lined up with the row centre.
let FIGURE_X: [number, number] = [GRID_LEFT / 2, (GRID_RIGHT + CANVAS_W) / 2];
let FIGURE_SCALE = 2.2;
let SUB_H = ROW_H / 2;
const MAX_VISIBLE_ROWS = 10;
let LOG_TOP = HEADER_TOP + HEADER_H;
let TABLE_BOTTOM = LOG_TOP + MAX_VISIBLE_ROWS * ROW_H;

// Power maps straight onto height: 0 barely clears row 1, 1.0 puts the apex in the ZONKE
// band, and anything past that drives the ball into the top line.
let APEX_FLOOR_Y = LOG_TOP + (MAX_VISIBLE_ROWS - 1) * ROW_H + ROW_H / 2; // centre of row 1
let APEX_SPAN = APEX_FLOOR_Y - (LOG_TOP - 5); // travel from row 1 to just inside the ZONKE band

/** Font-size helper: scales a design-space point size by S and rounds to a whole px string. */
function fs(n: number): string {
  return `${Math.max(1, Math.round(n * S))}px`;
}

/**
 * Re-derives every layout constant above from the real canvas size Phaser gives the scene.
 * Must run before anything else in create(), since every position in this file reads these.
 */
function computeLayout(width: number, height: number): void {
  CANVAS_W = width;
  CANVAS_H = height;
  S = height / DESIGN_H;

  CENTER_X = CANVAS_W / 2;
  CELL_W = (CANVAS_W * (DESIGN_GRID_W / DESIGN_W)) / ROWS.length;
  GRID_LEFT = CENTER_X - (ROWS.length * CELL_W) / 2;
  GRID_RIGHT = GRID_LEFT + ROWS.length * CELL_W;

  TOP_BAR_H = 46 * S;
  HEADER_TOP = TOP_BAR_H;
  HEADER_H = 110 * S * BOARD_SHRINK;
  ROW_H = 88 * S * BOARD_SHRINK;
  FIGURE_X = [GRID_LEFT / 2, (GRID_RIGHT + CANVAS_W) / 2];
  FIGURE_SCALE = 2.2 * S * BOARD_SHRINK;
  SUB_H = ROW_H / 2;
  LOG_TOP = HEADER_TOP + HEADER_H;
  TABLE_BOTTOM = LOG_TOP + MAX_VISIBLE_ROWS * ROW_H;
  APEX_FLOOR_Y = LOG_TOP + (MAX_VISIBLE_ROWS - 1) * ROW_H + ROW_H / 2;
  APEX_SPAN = APEX_FLOOR_Y - (LOG_TOP - 5 * S);

  // A ball sized for a big desktop board would swallow a phone's narrow columns, so it is
  // also capped relative to CELL_W.
  BALL_R = Math.min(12 * S, CELL_W * 0.4);
  FRICTION = 0.3 * S;
  STOP_SPEED = 0.35 * S;

  // The margin each side actually has to work with, once the grid claims the middle.
  MARGIN_L = GRID_LEFT;
  MARGIN_R = CANVAS_W - GRID_RIGHT;
  // A figure's widest point in drawMiniFigure() is ~21 design units from centre - never let
  // it overflow past its own margin into the grid or off the edge of the canvas.
  FIGURE_SCALE = Math.min(FIGURE_SCALE, (Math.min(MARGIN_L, MARGIN_R) / 2 - 6 * S) / 21);
}

let MARGIN_L = 0;
let MARGIN_R = 0;

/**
 * Shrinks a text object's font size until it fits within maxWidth, instead of trusting a
 * fixed fraction of screen width to always be enough room - the failure mode of that was a
 * label like "Player 1" clipping off the edge of a narrow phone. Falls back to shortLabel
 * (e.g. "P1") if it still won't fit at a legible size.
 */
function fitLabel(text: Phaser.GameObjects.Text, maxWidth: number, shortLabel?: string): void {
  const minPx = 11;
  while (text.width > maxWidth && text.style.fontSize && parseInt(text.style.fontSize as string, 10) > minPx) {
    const next = parseInt(text.style.fontSize as string, 10) - 1;
    text.setFontSize(next);
  }
  if (text.width > maxWidth && shortLabel) {
    text.setText(shortLabel);
    while (text.width > maxWidth && parseInt(text.style.fontSize as string, 10) > minPx) {
      text.setFontSize(parseInt(text.style.fontSize as string, 10) - 1);
    }
  }
}



/**
 * When set, the scene stops drawing its own flat ball and figures and publishes their
 * positions instead, for the 3D actor overlay to draw in their place. Nothing else about
 * the board changes - the grid, the header, the bullet dashes, the crosses and every
 * layout number stay exactly as they are, because the overlay only replaces two things.
 */
let USE_3D_ACTORS = false;

export function enable3DActors(): void {
  USE_3D_ACTORS = true;
}

/** The board's live pixel geometry, for anything drawing on top of it. */
export interface ActorLayout {
  canvasW: number;
  canvasH: number;
  gridLeft: number;
  cellW: number;
  logTop: number;
  rowH: number;
  figureX: [number, number];
  figureScale: number;
  ballR: number;
}

export interface ActorBall {
  x: number;
  y: number;
  r: number;
  split: boolean;
}

export interface ActorFigure {
  slot: number;
  side: 0 | 1;
  parts: number;
}

export class ZonkeScene extends Phaser.Scene {
  private players!: [PlayerState, PlayerState];
  private activeIndex = 0;
  // How far each row's bullet has stepped across the letters: [rowSlot][0=p1/1=p2]
  private rowBullets: number[][] = [];

  private killTexts: [Phaser.GameObjects.Text, Phaser.GameObjects.Text] = [
    null as any,
    null as any,
  ];
  // Pool of cell texts: [rowSlot][0=p1/1=p2][columnIndex]
  private cellTextPool: Phaser.GameObjects.Text[][][] = [];
  // Pool of per-row figures: [rowSlot][0=p1/1=p2]
  private miniFigureGfx: Phaser.GameObjects.Graphics[][] = [];
  // How many figure parts each row has earned: [rowSlot][0=p1/1=p2]. Every row builds its
  // own figure from scratch - landing there again adds the next part to THAT row only.
  private rowFigureParts: number[][] = [];

  private turnText!: Phaser.GameObjects.Text;
  private messageText!: Phaser.GameObjects.Text;
  private columnHighlight!: Phaser.GameObjects.Rectangle;
  private gameOverText!: Phaser.GameObjects.Text;
  private nameText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private ball!: Phaser.GameObjects.Arc;
  private ballRestY = 0;
  private ballX = 0;
  private ballY = 0;

  // Every ball currently on the board - one on a normal shot, up to six after a split.
  private balls: FlightBall[] = [];
  // Where those balls came to rest, applied to the board together once they have all stopped.
  private landings: Landing[] = [];
  private splitUsedThisTurn = false;

  // The match clock, shown above the board. It starts when a difficulty is picked (not at
  // page load, which would count the time spent reading the menu) and freezes on the win.
  private matchStartAt = 0;
  private matchEndedAt: number | null = null;
  private pickerShown = false;

  private ready = false; // waiting for the player to launch
  private charging = false; // SPACE is held down, power is building
  private chargeStart = 0;
  private power = 0;
  private flying = false; // ball is in the air, outcome not decided yet
  private gameOver = false;
  private mode: Mode | null = null; // null while the difficulty is still being chosen
  private modeUi: Phaser.GameObjects.GameObject[] = [];
  private bulletGfx!: Phaser.GameObjects.Graphics;
  private laidOutW = 0;
  private laidOutH = 0;
  private resizeTimer?: Phaser.Time.TimerEvent;

  // A random row flashes gold every few turns; landing on it (not via ZONKE) processes
  // that landing twice - a smaller, more frequent jackpot alongside the ZONKE one.
  private bonusRow: number | null = null;
  private bonusTurnsLeft = 0;
  private bonusHighlight!: Phaser.GameObjects.Rectangle;
  private bonusJustHit = false;

  // A second, independent flashing row that only helps whichever player is currently
  // behind on kills - a comeback chance, not a universal bonus. Multiplier is random
  // (2x or 3x) each time it appears, and shown as text so it's never a guess.
  private lifelineRow: number | null = null;
  private lifelineMultiplier = 2;
  private lifelineHighlight!: Phaser.GameObjects.Rectangle;
  private lifelineLabel!: Phaser.GameObjects.Text;

  // A third flashing row, green, and the only one that is usually not there at all: a ball
  // that comes to rest on it bursts into 2-5 balls, each flying off at its own random
  // speed, and every one of them scores where it lands.
  private splitRow: number | null = null;
  private splitExpiresAt = 0;
  // One green row per match, full stop - once this is set, no further roll can open another.
  private splitSeenThisGame = false;
  private splitHighlight!: Phaser.GameObjects.Rectangle;
  private splitLabel!: Phaser.GameObjects.Text;

  constructor() {
    super('ZonkeScene');
  }

  init(data: { mode?: Mode }): void {
    this.mode = data?.mode ?? null;
  }

  create(): void {
    computeLayout(this.scale.width, this.scale.height);
    this.laidOutW = this.scale.width;
    this.laidOutH = this.scale.height;
    this.scale.on('resize', this.onScaleResize, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.onScaleResize, this));

    // The name is asked for once per session (see ensurePlayerName below); until it comes
    // back the board is built with the placeholder, then relabelled in place.
    const knownName = storedPlayerName();
    this.players = [createPlayer(knownName ?? DEFAULT_NAME), createPlayer('CPU')];
    this.activeIndex = 0;
    this.resetBoard();
    this.gameOver = false;
    this.matchEndedAt = null;
    this.pickerShown = false;
    this.balls = [];
    this.landings = [];
    this.splitUsedThisTurn = false;

    // Each margin label is measured and shrunk (or abbreviated) to actually fit the
    // margin it sits in, rather than trusting that a fraction of screen width is always
    // wide enough - that assumption is what clipped "Player 1" to "layer 1" on a phone.
    const gutter = 6 * S;
    this.nameText = this.add
      .text(FIGURE_X[0], 6 * S, this.players[0].name, { fontSize: fs(30), color: P1_COLOR })
      .setOrigin(0.5, 0);
    fitLabel(this.nameText, MARGIN_L - gutter * 2, 'P1');
    const nameR = this.add
      .text(FIGURE_X[1], 6 * S, 'CPU', { fontSize: fs(24), color: P2_COLOR })
      .setOrigin(0.5, 0);
    fitLabel(nameR, MARGIN_R - gutter * 2);

    this.killTexts = [
      this.add.text(FIGURE_X[0], 38 * S, 'Kills: 0', { fontSize: fs(20), color: '#ffd54f' }).setOrigin(0.5, 0),
      this.add.text(FIGURE_X[1], 38 * S, 'Kills: 0', { fontSize: fs(20), color: '#ffd54f' }).setOrigin(0.5, 0),
    ];
    fitLabel(this.killTexts[0], MARGIN_L - gutter * 2);
    fitLabel(this.killTexts[1], MARGIN_R - gutter * 2);

    // Sits in the band above the board, centred over the grid so it never runs into the
    // player names out in the margins.
    this.clockText = this.add
      .text(CENTER_X, 8 * S, `Time  ${formatClock(0)}`, {
        fontSize: fs(26),
        color: '#e0e0e0',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0);

    this.drawHeader();

    // Created before the cell pool so its text and figures draw on top of this wash, not
    // under it - the highlight is a background tint, not something that should cover marks.
    // Fill alpha of 1 here, not a dim value - the tween below drives the actual visible
    // opacity via the GameObject's own .alpha, and the two multiply together. Baking a low
    // fill alpha in AND tweening .alpha compounds to under 4% opacity - invisible in
    // practice, which is exactly what shipped here the first time.
    this.bonusHighlight = this.add
      .rectangle(0, 0, ROWS.length * CELL_W, ROW_H, 0xffd54f, 1)
      .setOrigin(0.5);
    this.tweens.add({
      targets: this.bonusHighlight,
      alpha: { from: 0.08, to: 0.3 },
      duration: 650,
      yoyo: true,
      repeat: -1,
    });
    this.pickBonusRow();

    // A different colour from the universal bonus row, since this one only does anything
    // for whoever is currently behind - it should read as distinct at a glance.
    this.lifelineHighlight = this.add
      .rectangle(0, 0, ROWS.length * CELL_W, ROW_H, 0xff9800, 1)
      .setOrigin(0.5)
      .setVisible(false);
    this.tweens.add({
      targets: this.lifelineHighlight,
      alpha: { from: 0.1, to: 0.34 },
      duration: 500,
      yoyo: true,
      repeat: -1,
    });
    this.lifelineLabel = this.add
      .text(0, 0, '', { fontSize: fs(22), color: '#ffb74d', fontStyle: 'bold' })
      .setOrigin(0.5)
      .setVisible(false);
    this.ensureLifeline();

    this.splitHighlight = this.add
      .rectangle(0, 0, ROWS.length * CELL_W, ROW_H, SPLIT_COLOR_HEX, 1)
      .setOrigin(0.5)
      .setVisible(false);
    this.tweens.add({
      targets: this.splitHighlight,
      alpha: { from: 0.1, to: 0.32 },
      duration: 800,
      yoyo: true,
      repeat: -1,
    });
    this.splitLabel = this.add
      .text(0, 0, 'SPLIT', { fontSize: fs(20), color: SPLIT_COLOR, fontStyle: 'bold' })
      .setOrigin(0.5)
      .setDepth(1)
      .setVisible(false);
    // Deliberately nothing to show yet - the board starts with no green row, and this match
    // may well finish without one.
    this.splitRow = null;
    this.splitSeenThisGame = false;

    this.createCellPool();

    // Parked clear of the board's bottom border rather than sitting right on it - at 26px
    // the ball read as part of the line it was resting against. Power still maps to the
    // same rows: launchWithPower() aims at an absolute resting height, so a lower start
    // just means a fractionally longer flight, not a different landing.
    this.ballRestY = TABLE_BOTTOM + 42 * S;
    this.ball = this.add.circle(0, 0, BALL_R, 0xffd54f);
    // The overlay draws a real sphere in its place, at this exact position.
    this.ball.setVisible(!USE_3D_ACTORS);
    this.positionBallAtRest();

    const turnY = this.ballRestY + 28 * S;
    this.turnText = this.add
      .text(CENTER_X, turnY, `${this.players[0].name}'s turn`, { fontSize: fs(24), color: P1_COLOR })
      .setOrigin(0.5, 0);

    // Wrapped: a split turn's message is a good deal longer than a single landing's, and
    // an unwrapped line runs straight off both edges of a phone.
    this.messageText = this.add
      .text(CENTER_X, turnY + 32 * S, 'Hold to charge, release to launch', {
        fontSize: fs(21),
        color: '#cccccc',
        align: 'center',
        wordWrap: { width: CANVAS_W * 0.92 },
      })
      .setOrigin(0.5, 0);

    this.gameOverText = this.add
      .text(CENTER_X, turnY + 62 * S, '', { fontSize: fs(28), color: '#ffeb3b', fontStyle: 'bold' })
      .setOrigin(0.5, 0);


    this.columnHighlight = this.add
      .rectangle(0, HEADER_TOP, CELL_W, TABLE_BOTTOM - HEADER_TOP, 0xffffff, 0.12)
      .setOrigin(0.5, 0)
      .setVisible(false);

    this.bulletGfx = this.add.graphics();

    this.input.keyboard!.on('keydown-SPACE', this.onChargeStart, this);
    this.input.keyboard!.on('keyup-SPACE', this.onRelease, this);
    this.input.keyboard!.on('keydown-R', this.restartGame, this);

    this.input.keyboard!.on('keydown-ONE', () => this.chooseMode(0), this);
    this.input.keyboard!.on('keydown-TWO', () => this.chooseMode(1), this);
    this.input.keyboard!.on('keydown-THREE', () => this.chooseMode(2), this);
    this.input.keyboard!.on('keydown-FOUR', () => this.startTimeAttack(), this);

    // Touch/mouse: press-and-hold anywhere on the board to charge, same as holding SPACE.
    // Tapping while the game is over restarts, so there is no keyboard-only control left.
    this.input.on('pointerdown', () => {
      // No tap-anywhere restart once the game is over: the win screen has its own Save and
      // Play again buttons, and a stray tap beside Save must not throw the run away before
      // it has been captured.
      if (this.gameOver) return;
      this.onChargeStart();
    });
    this.input.on('pointerup', this.onRelease, this);
    this.input.on('pointerupoutside', this.onRelease, this);

    this.redrawAll();

    if (this.mode) {
      // Came back from a restart with a difficulty already chosen - the clock starts again.
      this.matchStartAt = this.time.now;
      this.armBall();
    } else if (knownName) {
      this.showModePicker();
    } else {
      // First round of the session: the board is already drawn behind the prompt, and the
      // difficulty picker waits until we know who is playing.
      this.turnText.setText('');
      this.messageText.setText('');
      ensurePlayerName().then((name) => {
        this.applyPlayerName(name);
        // A resize (a phone keyboard opening, say) can restart the scene while the prompt
        // is still open, leaving two callbacks waiting on one shared promise - the guard
        // keeps the second one from stacking a duplicate picker on top of the first.
        if (this.mode || this.pickerShown) return;
        this.showModePicker();
      });
    }
  }

  /** The pixel geometry the board is currently laid out on. */
  actorLayout(): ActorLayout {
    return {
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      gridLeft: GRID_LEFT,
      cellW: CELL_W,
      logTop: LOG_TOP,
      rowH: ROW_H,
      figureX: [FIGURE_X[0], FIGURE_X[1]],
      figureScale: FIGURE_SCALE,
      ballR: BALL_R,
    };
  }

  /** Every ball on the board: the ones in flight, or the one parked on the launcher. */
  actorBalls(): ActorBall[] {
    if (this.balls.length > 0) {
      return this.balls.map((b) => ({
        x: b.x,
        y: b.y,
        r: b.fromSplit ? BALL_R * 0.78 : BALL_R,
        split: b.fromSplit,
      }));
    }
    return [{ x: this.ballX, y: this.ballY, r: BALL_R, split: false }];
  }

  /** How many parts each row's figure has earned, per side. */
  actorFigures(): ActorFigure[] {
    const out: ActorFigure[] = [];
    this.rowFigureParts.forEach((row, slot) =>
      row.forEach((parts, side) => {
        if (parts > 0) out.push({ slot, side: side as 0 | 1, parts });
      })
    );
    return out;
  }

  /** Relabels the human player once the session's name comes back from the prompt. */
  private applyPlayerName(name: string): void {
    this.players[0].name = name;
    this.nameText.setFontSize(Math.max(1, Math.round(30 * S)));
    this.nameText.setText(name);
    fitLabel(this.nameText, MARGIN_L - 12 * S, 'P1');
    if (!this.gameOver && this.mode) {
      this.turnText.setText(`${this.players[this.activeIndex].name}'s turn`);
    }
  }

  private showModePicker(): void {
    this.pickerShown = true;
    // Built as a top-down stack, each block placed from the ACTUAL measured height of the
    // one before it - not fixed offsets guessed at one screen size. That is what the old
    // version got wrong: a hint line that happened to wrap to two lines on a narrow phone
    // had no extra room reserved for it, so it overlapped the block below it. Word-wrapping
    // long lines to the panel's own width, instead of relying on a hand-picked line break,
    // is the other half of the same fix.
    const availW = CANVAS_W * 0.94;
    const availH = CANVAS_H * 0.94;
    const panelW = Math.min(720 * S, availW);
    const textW = panelW - 48 * S;
    const gap = 14 * S;

    const title = this.add
      .text(CENTER_X, 0, 'Choose difficulty', { fontSize: fs(34), color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5, 0);

    const btnW = Math.min(560 * S, panelW * 0.9);
    const btnH = 52 * S;
    const pickerButtons: { label: string; color: string; onClick: () => void }[] = [
      ...MODES.map((m, i) => ({
        label: `${i + 1}   ${m.name}`,
        color: '#ffd54f',
        onClick: () => this.chooseMode(i),
      })),
      {
        label: '4   Time Attack (solo, 60s)',
        color: '#4fc3f7',
        onClick: () => this.startTimeAttack(),
      },
    ];
    const buttonPairs = pickerButtons.map(({ label: text, color, onClick }) => {
      const btn = this.add
        .rectangle(CENTER_X, 0, btnW, btnH, 0xffffff, 0.06)
        .setStrokeStyle(1, 0xffd54f, 0.5)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(CENTER_X, 0, text, { fontSize: fs(26), color })
        .setOrigin(0.5, 0.5);
      btn.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, event: { stopPropagation: () => void }) => {
        event.stopPropagation();
        onClick();
      });
      return { btn, label };
    });

    const hint = this.add
      .text(CENTER_X, 0, 'Harder modes charge faster and the CPU aims better', {
        fontSize: fs(18),
        color: '#aaaaaa',
        align: 'center',
        wordWrap: { width: textW },
      })
      .setOrigin(0.5, 0);

    const rules = this.add
      .text(
        CENTER_X,
        0,
        'Land on a row to draw its figure. Once it holds a gun, each landing steps its bullet one letter - past H it hits. A gold row doubles any landing; an orange row is a lifeline - double or triple, but only for whoever is behind; and once a game, if you are lucky, a green row opens for 15 seconds - land on that one and your ball splits into 2-5, each with its own speed, and every one of them scores.',
        { fontSize: fs(17), color: '#888888', align: 'center', lineSpacing: 6 * S, wordWrap: { width: textW } }
      )
      .setOrigin(0.5, 0);

    // Stack everything from a running cursor, then find out how tall the whole thing
    // actually turned out to be once wrapping and font-fit have had their say. If it still
    // doesn't fit the screen, shrink every piece by the same factor and lay it out again -
    // once - rather than let the panel clip its own last line.
    let btnHeight = btnH;
    let curGap = gap;
    const stack = (): number => {
      let cy = 0;
      title.setY(cy);
      cy += title.height + curGap * 1.4;
      buttonPairs.forEach(({ btn, label }) => {
        btn.setY(cy + btnHeight / 2);
        label.setY(cy + btnHeight / 2);
        cy += btnHeight + curGap * 0.5;
      });
      cy += curGap * 0.6;
      hint.setY(cy);
      cy += hint.height + curGap * 0.5;
      rules.setY(cy);
      cy += rules.height;
      return cy;
    };

    let contentH = stack();
    if (contentH + 48 * S > availH) {
      const shrink = Phaser.Math.Clamp((availH - 48 * S) / contentH, 0.55, 1);
      [title, hint, rules, ...buttonPairs.map((p) => p.label)].forEach((t) =>
        t.setFontSize(Math.max(10, Math.round(parseInt(t.style.fontSize as string, 10) * shrink)))
      );
      btnHeight *= shrink;
      curGap *= shrink;
      buttonPairs.forEach(({ btn }) => btn.setSize(btn.width, btnHeight));
      contentH = stack();
    }

    const panelH = Math.min(contentH + 48 * S, availH);
    const midY = CANVAS_H / 2;
    const startY = midY - contentH / 2;

    // Shift the whole stack from the relative coordinates it was built in down to its
    // actual position, now that the total height is known.
    title.setY(title.y + startY);
    buttonPairs.forEach(({ btn, label }) => {
      btn.setY(btn.y + startY);
      label.setY(label.y + startY);
    });
    hint.setY(hint.y + startY);
    rules.setY(rules.y + startY);

    const panel = this.add.rectangle(CENTER_X, midY, panelW, panelH, 0x000000, 0.88).setOrigin(0.5);

    [title, hint, rules, ...buttonPairs.flatMap((p) => [p.btn, p.label])].forEach((o) =>
      o.setDepth(1)
    );
    this.modeUi = [panel, title, hint, rules, ...buttonPairs.flatMap((p) => [p.btn, p.label])];
    this.turnText.setText('');
    this.messageText.setText('');
  }

  private chooseMode(index: number): void {
    if (this.mode) return;
    this.mode = MODES[index];
    track('mode_selected', { mode: this.mode.name });
    this.modeUi.forEach((o) => o.destroy());
    this.modeUi = [];
    this.matchStartAt = this.time.now;
    this.turnText.setText(`${this.players[0].name}'s turn`);
    this.messageText.setText('Hold to charge, release to launch');
    this.armBall();
  }

  private startTimeAttack(): void {
    if (this.mode) return;
    track('mode_selected', { mode: 'TimeAttack' });
    this.scene.start('TimeAttackScene');
  }

  private drawHeader(): void {
    const g = this.add.graphics();
    g.lineStyle(2, 0xffffff, 1);

    const tableWidth = ROWS.length * CELL_W;

    // Outer border around the whole table (header + all round rows).
    g.strokeRect(GRID_LEFT, HEADER_TOP, tableWidth, TABLE_BOTTOM - HEADER_TOP);
    g.lineBetween(GRID_LEFT, LOG_TOP, GRID_LEFT + tableWidth, LOG_TOP);

    // One divider per row and nothing inside it. The half-height sub-line that used to
    // split each row in two is gone: the two players' bullet dashes already sit in their
    // own halves, so the line only added clutter to every single row.
    for (let r = 0; r < MAX_VISIBLE_ROWS; r++) {
      const y = LOG_TOP + r * ROW_H;
      if (r > 0) {
        g.lineStyle(2, 0xffffff, 1);
        g.lineBetween(GRID_LEFT, y, GRID_LEFT + tableWidth, y);
      }

      // Row position label: bottom row = 1, counting upward to MAX_VISIBLE_ROWS at the top.
      const rowNumber = MAX_VISIBLE_ROWS - r;
      this.add
        .text(GRID_LEFT - 20 * S, y + ROW_H / 2, String(rowNumber), {
          fontSize: fs(20),
          color: '#777777',
        })
        .setOrigin(1, 0.5);
    }

    // The header row IS the ZONKE row - "ZONKE" sits on its own line on top, bigger and clear
    // of the column letters/numbers stacked below it, so nothing overlaps.
    this.add
      .text(GRID_LEFT + tableWidth / 2, HEADER_TOP + 8 * S, 'ZONKE', {
        fontSize: fs(42),
        color: '#ffd54f',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0);

    ROWS.forEach((row, i) => {
      const cx = GRID_LEFT + i * CELL_W + CELL_W / 2;
      const isLast = i === ROWS.length - 1;
      this.add
        .text(cx, HEADER_TOP + 64 * S, row, {
          fontSize: fs(30),
          color: isLast ? KILL_COLOR : '#ffffff',
          fontStyle: 'bold',
        })
        .setOrigin(0.5, 0);
    });
  }

  private createCellPool(): void {
    this.cellTextPool = [];
    this.miniFigureGfx = [];
    for (let r = 0; r < MAX_VISIBLE_ROWS; r++) {
      const rowY = LOG_TOP + r * ROW_H;
      const subPools: Phaser.GameObjects.Text[][] = [];
      const miniRow: Phaser.GameObjects.Graphics[] = [];
      [0, 1].forEach((sub) => {
        const y = rowY + sub * SUB_H + 4 * S;
        const subTexts: Phaser.GameObjects.Text[] = [];
        ROWS.forEach((_row, i) => {
          const cx = GRID_LEFT + i * CELL_W + CELL_W / 2;
          const t = this.add
            .text(cx, y, '', { fontSize: fs(26), color: NEUTRAL_COLOR })
            .setOrigin(0.5, 0);
          subTexts.push(t);
        });
        subPools.push(subTexts);
        miniRow.push(this.add.graphics());
      });
      this.cellTextPool.push(subPools);
      this.miniFigureGfx.push(miniRow);
    }
  }

  private positionBallAtRest(): void {
    this.ballX = GRID_LEFT + (ROWS.length * CELL_W) / 2;
    this.ballY = this.ballRestY;
    this.ball.setPosition(this.ballX, this.ballY);
  }

  /** Parks the ball on the launcher and waits for the player to charge a shot. */
  private armBall(): void {
    this.ready = true;
    this.flying = false;
    this.charging = false;
    this.power = 0;
    this.clearSplitBalls();
    this.balls = [];
    this.landings = [];
    this.splitUsedThisTurn = false;
    this.positionBallAtRest();
    this.ball.setVisible(!USE_3D_ACTORS);
    this.columnHighlight.setVisible(false);
    if (this.isCpuTurn() && !this.gameOver && this.mode) {
      this.time.delayedCall(500, () => this.takeCpuTurn());
    }
  }

  /** Where a given power brings the ball to rest - this IS the row/ZONKE mapping. */
  private restingYFor(power: number): number {
    return APEX_FLOOR_Y - power * APEX_SPAN;
  }

  private onChargeStart(): void {
    if (!this.mode || this.isCpuTurn()) return;
    if (this.gameOver || this.flying || this.charging || !this.ready) return;
    this.charging = true;
    this.power = 0;
    this.chargeStart = this.time.now;
    this.messageText.setText('Charging - release to launch');
  }

  private onRelease(): void {
    if (!this.charging) return;
    this.charging = false;
    // Harder modes add a little slop, so the same hold does not always go the same distance.
    const jitter = Phaser.Math.FloatBetween(-this.mode!.jitter, this.mode!.jitter);
    this.launchWithPower(this.power + jitter);
  }

  private isCpuTurn(): boolean {
    return this.activeIndex === 1;
  }

  /** The CPU goes for the jackpot, missing by however much its mode allows. */
  private takeCpuTurn(): void {
    if (this.gameOver || !this.ready || !this.mode) return;
    // The band moves with the wall, so the CPU has to aim at this mode's band, not a fixed
    // spot - otherwise a lower wall would make it worse rather than better.
    const low = (APEX_FLOOR_Y - LOG_TOP) / APEX_SPAN;
    const high = (APEX_FLOOR_Y - this.wallY()) / APEX_SPAN;
    const target = (low + high) / 2;
    // On easier modes it mostly just takes a shot; on Hard it nearly always goes for ZONKE.
    const goesForIt = Math.random() < this.mode.cpuAim;
    // Sum of three uniforms - clusters near the target, with the odd wild miss.
    const drift =
      ((Math.random() + Math.random() + Math.random() - 1.5) / 1.5) *
      this.mode.cpuError *
      POWER_MAX;
    const power = goesForIt
      ? target + drift
      : Phaser.Math.FloatBetween(0, POWER_MAX);
    this.messageText.setText('CPU is lining up a shot...');
    this.time.delayedCall(600, () => this.launchWithPower(power));
  }

  private launchWithPower(power: number): void {
    if (this.flying || !this.ready) return;
    this.power = Phaser.Math.Clamp(power, 0, POWER_MAX);
    this.ready = false;
    this.flying = true;

    // Power buys distance. Friction then eats exactly that much momentum, so the ball
    // coasts to a stop at the height the gauge promised - it does not fall back.
    const target = Math.max(this.ballRestY - this.restingYFor(this.power), 1);
    // Stepping in whole frames loses about half a frame of travel, so aim slightly past the
    // target - that keeps the ball stopping exactly where the gauge promised it would.
    const distance = target + Math.sqrt(2 * FRICTION * target) / 2;
    this.landings = [];
    this.splitUsedThisTurn = false;
    this.balls = [
      {
        gfx: this.ball,
        x: this.ballX,
        y: this.ballY,
        // Straight up the board - the shot has no sideways component of its own.
        vx: 0,
        vy: -Math.sqrt(2 * FRICTION * distance),
        resting: false,
        hitWall: false,
        fromSplit: false,
      },
    ];

    this.columnHighlight.setVisible(true);
    this.columnHighlight.setFillStyle(this.activeIndex === 0 ? P1_COLOR_HEX : P2_COLOR_HEX, 0.15);
  }

  update(_time: number, delta: number): void {
    if (this.mode && !this.gameOver) this.updateClock();
    if (this.gameOver || !this.mode) return;
    this.updateSplitWindow();

    if (this.charging) {
      const held = this.time.now - this.chargeStart;
      // Deliberately no gauge: the player has to judge the hold by feel, which is what
      // keeps the ZONKE band hard to hit. The flight itself is the only feedback.
      this.power = Math.min(POWER_MAX, (held / this.mode!.chargeMs) * POWER_MAX);
      return;
    }

    if (!this.flying) return;

    // Integrate in fixed 16ms steps so the same power always travels the same distance.
    const steps = Math.min(4, Math.max(1, Math.round(delta / 16.667)));
    for (let i = 0; i < steps && this.flying; i++) {
      // A ball settling on the split row appends its splinters mid-step, so step over a
      // snapshot: the new balls start moving on the next tick, not halfway through this one.
      this.balls.slice().forEach((ball) => {
        if (!ball.resting) this.stepBall(ball);
      });
    }

    this.balls.forEach((ball) => ball.gfx.setPosition(ball.x, ball.y));
    this.highlightColumnUnderBall();
  }

  private updateClock(): void {
    this.clockText.setText(`Time  ${formatClock(this.matchDurationMs())}`);
  }

  /** How long this match has been running; frozen at the moment someone won. */
  private matchDurationMs(): number {
    if (!this.matchStartAt) return 0;
    return (this.matchEndedAt ?? this.time.now) - this.matchStartAt;
  }

  /** One 16ms tick for one ball: friction bleeds momentum, walls turn it around. */
  private stepBall(ball: FlightBall): void {
    const speed = Math.hypot(ball.vx, ball.vy);
    const slowed = speed - FRICTION;
    if (speed < STOP_SPEED || slowed <= 0) {
      this.settleBall(ball);
      return;
    }

    // Friction acts against the direction of travel, so the ball keeps its heading.
    const scale = slowed / speed;
    ball.vx *= scale;
    ball.vy *= scale;
    ball.x += ball.vx;
    ball.y += ball.vy;

    const left = GRID_LEFT + BALL_R;
    const right = GRID_LEFT + ROWS.length * CELL_W - BALL_R;
    if (ball.x < left) {
      ball.x = left;
      ball.vx = Math.abs(ball.vx) * WALL_BOUNCE;
    } else if (ball.x > right) {
      ball.x = right;
      ball.vx = -Math.abs(ball.vx) * WALL_BOUNCE;
    }

    // The wall above ZONKE is the one thing that sends it back. Whatever momentum it still
    // had going up now carries it back down, so the harder you overshot, the lower you land.
    const wall = this.wallY();
    if (ball.y < wall) {
      ball.y = wall;
      // Coming off the wall is the only thing that sends the ball sideways: whatever
      // momentum it had left comes back down on a random angle.
      const bounced = Math.hypot(ball.vx, ball.vy) * WALL_BOUNCE;
      const angle = Phaser.Math.FloatBetween(-BOUNCE_SPREAD, BOUNCE_SPREAD);
      ball.vx = bounced * Math.sin(angle);
      ball.vy = bounced * Math.cos(angle);
      ball.hitWall = true;
    }

    if (ball.y > this.ballRestY) {
      ball.y = this.ballRestY;
      ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE;
    }
  }

  /** The wall the ball bounces off: the band's top, never above the board's own top edge. */
  private wallY(): number {
    return Math.max(LOG_TOP - this.mode!.zonkeBand * S, HEADER_TOP + BALL_R);
  }

  private highlightColumnUnderBall(): void {
    // With several balls up, the column strip tracks whichever is still moving - it is a
    // "where is this going" hint, and a ball that has already stopped has no answer left.
    const tracked = this.balls.find((b) => !b.resting) ?? this.balls[0];
    if (!tracked) return;
    const cx = GRID_LEFT + this.columnAt(tracked.x) * CELL_W + CELL_W / 2;
    this.columnHighlight.setPosition(cx, HEADER_TOP);
  }

  private columnAt(x: number): number {
    return Phaser.Math.Clamp(Math.floor((x - GRID_LEFT) / CELL_W), 0, ROWS.length - 1);
  }

  /** Which board row a ball is sitting in; a ZONKE rests above row 10, so it pays out there. */
  private rowSlotAt(y: number): number {
    return Phaser.Math.Clamp(Math.floor((y - LOG_TOP) / ROW_H), 0, MAX_VISIBLE_ROWS - 1);
  }

  /** One ball has stopped. Whatever cell it is sitting in is that ball's result. */
  private settleBall(ball: FlightBall): void {
    ball.resting = true;
    ball.vx = 0;
    ball.vy = 0;
    // A ball can trickle to a stop in the gutter below row 1 - a weak shot, or a splinter
    // that spent itself bouncing off the floor. rowSlotAt already scores that as row 1, so
    // park it in row 1 too: a ball sitting outside the grid while row 1 takes the hit just
    // reads as a bug.
    if (ball.y > TABLE_BOTTOM) ball.y = TABLE_BOTTOM - ROW_H / 2;
    ball.gfx.setPosition(ball.x, ball.y);

    // Coming to rest above row 10 means it stopped in the ZONKE band - the jackpot.
    const jackpot = ball.y < LOG_TOP;
    const result: LaunchResult = jackpot ? 'ZONKE' : (ROWS[this.columnAt(ball.x)] as Row);
    const slot = this.rowSlotAt(ball.y);
    this.landings.push({ result, slot, overCharged: ball.hitWall && !jackpot });

    // The split row fires on a direct landing only, once per turn, and never off a ball
    // that is itself a splinter - that is what keeps one lucky shot from cascading forever.
    if (!jackpot && !ball.fromSplit && !this.splitUsedThisTurn && slot === this.splitRow) {
      this.splitBall(ball, slot);
      return;
    }

    if (this.balls.every((b) => b.resting)) this.onAllSettled();
  }

  /**
   * The green row's payoff: the ball that landed on it bursts into 2-5 balls, each thrown
   * off at its own random speed and heading. Every one of them scores wherever it comes to
   * rest, so a single shot can work several rows - or hit ZONKE - all at once.
   */
  private splitBall(origin: FlightBall, slot: number): void {
    this.splitUsedThisTurn = true;
    const count = Phaser.Math.Between(SPLIT_MIN_BALLS, SPLIT_MAX_BALLS);
    this.flashSplitRow(slot);

    for (let i = 0; i < count; i++) {
      // Headings fan out around straight up rather than over a full circle: a ball sent
      // straight back down just parks itself on the launcher without crossing a row.
      const angle = Phaser.Math.FloatBetween(-2.2, 2.2);
      // Each ball gets its own random distance to travel, which IS its own speed once
      // friction is accounted for - the same power-to-distance maths the launcher uses.
      const distance = APEX_SPAN * Phaser.Math.FloatBetween(0.15, 1);
      const speed = Math.sqrt(2 * FRICTION * distance);
      const gfx = this.add.circle(origin.x, origin.y, BALL_R * 0.78, SPLIT_COLOR_HEX);
      gfx.setVisible(!USE_3D_ACTORS);
      this.balls.push({
        gfx,
        x: origin.x,
        y: origin.y,
        vx: speed * Math.sin(angle),
        vy: -speed * Math.cos(angle),
        resting: false,
        hitWall: false,
        fromSplit: true,
      });
    }

    this.messageText.setText(`SPLIT! The ball burst into ${count} - every one of them scores.`);
    track('split_row_hit', { balls: count, mode: this.mode?.name });
  }

  /** The row itself turning green, for the moment a ball lands on it. */
  private flashSplitRow(slot: number): void {
    const flash = this.add
      .rectangle(
        GRID_LEFT + (ROWS.length * CELL_W) / 2,
        LOG_TOP + slot * ROW_H + ROW_H / 2,
        ROWS.length * CELL_W,
        ROW_H,
        SPLIT_COLOR_HEX,
        0.85
      )
      .setOrigin(0.5)
      .setDepth(2);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 600,
      onComplete: () => flash.destroy(),
    });
  }

  /** Nothing is moving any more - every ball's landing is applied together. */
  private onAllSettled(): void {
    this.flying = false;
    this.columnHighlight.setVisible(false);
    const landings = this.landings;
    const activeAtLaunch = this.activeIndex as 0 | 1;
    this.time.delayedCall(450, () => this.resolveLaunch(activeAtLaunch, landings));
  }

  /** Clears away the splinters from a split, leaving the launcher's own ball alone. */
  private clearSplitBalls(): void {
    this.balls.forEach((ball) => {
      if (ball.fromSplit) ball.gfx.destroy();
    });
  }

  /**
   * Applies every ball's landing from this turn, in the order they came to rest. A normal
   * shot has exactly one; a split has the landing that triggered it plus one per splinter.
   */
  private resolveLaunch(activeIndexAtLaunch: 0 | 1, landings: Landing[]): void {
    const active = this.players[activeIndexAtLaunch];
    const opponent = this.players[1 - activeIndexAtLaunch];
    const didSplit = this.splitUsedThisTurn;

    let bonusHit = false;
    let kills = 0;
    let lastMessage = '';
    landings.forEach((landing) => {
      const outcome = this.applyToBoard(
        activeIndexAtLaunch,
        landing.result,
        landing.slot,
        active,
        opponent
      );
      // applyToBoard records the bonus per landing; across a split, any one of them
      // claiming the gold row is what should stop the countdown ticking down.
      if (this.bonusJustHit) bonusHit = true;
      if (outcome.kind === 'kill') kills += 1;
      lastMessage = landing.overCharged
        ? `Too much power - the wall threw it back. ${outcome.message}`
        : outcome.message;
    });
    this.bonusJustHit = bonusHit;

    // One landing's message is the whole story. Several need a headline, or a kill from the
    // third ball of a split would be buried under whatever the fifth one happened to do.
    const headline = didSplit
      ? `Split into ${landings.length - 1} balls${kills > 0 ? ` - ${kills} row(s) down!` : ''}. `
      : '';
    this.messageText.setText(`${headline}${lastMessage}`);

    // Kills may have just changed, so re-check who (if anyone) is behind and needs a
    // lifeline - appears the moment someone pulls ahead, gone once it's even again.
    this.ensureLifeline();
    // Open, count down, or roll for a new one - see tickSplitRow for why it is this rare.
    this.tickSplitRow(didSplit);

    this.redrawAll();

    const win = checkWin(this.players[0], this.players[1]);
    if (win.gameOver && win.winner) {
      this.gameOver = true;
      this.matchEndedAt = this.time.now;
      this.updateClock();
      // The win screen carries all of this now, in letters you can read across the room.
      this.gameOverText.setText('');
      this.turnText.setText('');
      track('game_over', {
        mode: this.mode?.name,
        result: win.winner === this.players[0] ? 'p1_win' : 'cpu_win',
        p1Kills: this.players[0].kills,
        cpuKills: this.players[1].kills,
        durationMs: Math.round(this.matchDurationMs()),
      });
      this.showCelebration(win.winner, win.reason ?? '');
      return;
    }

    if (win.suddenDeath) {
      // Never a draw: every row is spoken for and the score is level, so the board is
      // wiped clean - figures, bullets, and every row's dead flag - and play continues.
      // Kills carry over; only the board itself resets.
      this.players.forEach((p) => p.deadRows.fill(false));
      this.resetBoard();
      this.pickBonusRow();
      this.ensureLifeline();
      this.redrawAll();
      this.messageText.setText(
        `${this.players[0].kills} all with no rows left - sudden death! Board reset.`
      );
    }

    if (!this.bonusJustHit) {
      this.bonusTurnsLeft -= 1;
      if (this.bonusTurnsLeft <= 0) this.pickBonusRow();
    }

    this.activeIndex = 1 - activeIndexAtLaunch;
    this.turnText.setText(`${this.players[this.activeIndex].name}'s turn`);
    this.turnText.setColor(this.activeIndex === 0 ? P1_COLOR : P2_COLOR);
    this.armBall();
  }

  private resetBoard(): void {
    this.rowBullets = Array.from({ length: MAX_VISIBLE_ROWS }, () => [0, 0]);
    this.rowFigureParts = Array.from({ length: MAX_VISIBLE_ROWS }, () => [0, 0]);
  }

  /** Moves the flashing bonus row somewhere new and resets its countdown. */
  private pickBonusRow(): void {
    let next = this.bonusRow;
    do {
      next = Phaser.Math.Between(0, MAX_VISIBLE_ROWS - 1);
    } while (
      MAX_VISIBLE_ROWS > 1 &&
      (next === this.bonusRow || next === this.lifelineRow || next === this.splitRow)
    );
    this.bonusRow = next;
    this.bonusTurnsLeft = Phaser.Math.Between(3, 6);
    this.bonusHighlight.setPosition(
      GRID_LEFT + (ROWS.length * CELL_W) / 2,
      LOG_TOP + this.bonusRow * ROW_H + ROW_H / 2
    );
  }

  /**
   * The lifeline only exists while the two players' kill counts differ - a comeback chance
   * for whoever is behind, not something either side sees when the game is even. Called
   * after every turn, so it appears the moment someone pulls ahead and disappears again if
   * the trailing side catches all the way back up.
   */
  private ensureLifeline(): void {
    const [p1, p2] = this.players;
    if (!p1 || !p2 || p1.kills === p2.kills) {
      this.lifelineRow = null;
      this.lifelineHighlight.setVisible(false);
      this.lifelineLabel.setVisible(false);
      return;
    }
    if (this.lifelineRow === null) this.pickLifelineRow();
  }

  private pickLifelineRow(): void {
    let next: number;
    do {
      next = Phaser.Math.Between(0, MAX_VISIBLE_ROWS - 1);
    } while (
      MAX_VISIBLE_ROWS > 1 &&
      (next === this.bonusRow || next === this.lifelineRow || next === this.splitRow)
    );
    this.lifelineRow = next;
    // "Reasonable double or triple" - random each time, and always shown as a number rather
    // than left for the player to guess at.
    this.lifelineMultiplier = Phaser.Math.Between(2, 3);
    const x = GRID_LEFT + (ROWS.length * CELL_W) / 2;
    const y = LOG_TOP + this.lifelineRow * ROW_H + ROW_H / 2;
    this.lifelineHighlight.setPosition(x, y).setVisible(true);
    this.lifelineLabel.setText(`${this.lifelineMultiplier}x`).setPosition(x, y).setVisible(true);
  }

  /**
   * Rolls for the match's one green row, after every launch. Unlike the gold and orange
   * rows, which are always somewhere on the board, this one is usually absent: it has to be
   * rolled for, it lasts fifteen seconds, and once that window is spent no second one can
   * open for the rest of the game. A match ending without a single green row is an
   * perfectly ordinary match - that scarcity is the whole point of it.
   */
  private tickSplitRow(claimed: boolean): void {
    if (claimed) {
      this.closeSplitRow();
      return;
    }
    if (this.splitRow !== null) return; // open - update() runs its fifteen-second clock
    if (this.splitSeenThisGame) return; // spent, and it does not come back this match
    if (Math.random() < SPLIT_SPAWN_CHANCE) this.openSplitRow();
  }

  /** The one green row of the match opens, clear of the other two, for fifteen seconds. */
  private openSplitRow(): void {
    let next: number;
    do {
      next = Phaser.Math.Between(0, MAX_VISIBLE_ROWS - 1);
    } while (MAX_VISIBLE_ROWS > 1 && (next === this.bonusRow || next === this.lifelineRow));
    this.splitRow = next;
    this.splitSeenThisGame = true;
    this.splitExpiresAt = this.time.now + SPLIT_WINDOW_MS;
    const x = GRID_LEFT + (ROWS.length * CELL_W) / 2;
    const y = LOG_TOP + next * ROW_H + ROW_H / 2;
    this.splitHighlight.setPosition(x, y).setVisible(true);
    this.splitLabel.setText(`SPLIT ${SPLIT_WINDOW_MS / 1000}s`).setPosition(x, y).setVisible(true);
    // One chance per match, on the clock - a player not watching that row would otherwise
    // miss the only one the whole game is going to offer.
    this.messageText.setText(
      `${this.messageText.text}  A GREEN SPLIT ROW opened on row ${rowLabel(next)} - ${SPLIT_WINDOW_MS / 1000} seconds to land on it!`
    );
    track('split_row_opened', { row: rowLabel(next), mode: this.mode?.name });
  }

  /**
   * Counts the open row's fifteen seconds down on its own label. The clock is held while a
   * ball is in the air: a shot already on its way to the green row has earned its chance,
   * and having the window shut underneath it mid-flight would just read as a cheat.
   */
  private updateSplitWindow(): void {
    if (this.splitRow === null) return;
    if (this.flying || this.charging) return;
    const secondsLeft = Math.ceil((this.splitExpiresAt - this.time.now) / 1000);
    if (secondsLeft <= 0) {
      this.closeSplitRow();
      return;
    }
    this.splitLabel.setText(`SPLIT ${secondsLeft}s`);
  }

  private closeSplitRow(): void {
    this.splitRow = null;
    this.splitHighlight.setVisible(false);
    this.splitLabel.setVisible(false);
  }

  /** Whichever player currently has fewer kills - who the lifeline is for, if it exists. */
  private isTrailing(playerIndex: 0 | 1): boolean {
    const opponent = this.players[1 - playerIndex];
    return this.players[playerIndex].kills < opponent.kills;
  }

  /**
   * A landing works one row (or every row, on a ZONKE). While that row's figure is unfinished
   * it draws the next part; once the figure is holding a gun the row's bullet steps one
   * letter further across the board, and clearing H is what actually hits the opponent.
   */
  private applyToBoard(
    playerIndex: 0 | 1,
    result: LaunchResult,
    slot: number,
    active: PlayerState,
    opponent: PlayerState
  ): TurnOutcome {
    const slots =
      result === 'ZONKE' ? Array.from({ length: MAX_VISIBLE_ROWS }, (_row, i) => i) : [slot];
    // A downed row is disabled for both sides: the owner can no longer build or fire from
    // it, and there is nothing left to shoot at across from it.
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
    let lifelineMultiplierHit = 0;

    live.forEach((row) => {
      // The bonus row is its own small jackpot, separate from ZONKE - landing on it
      // (directly, not via a ZONKE that already hits every row) processes the landing
      // twice, which can carry a figure straight through completion into its first bullet
      // step, or fire an already-loaded gun immediately. The lifeline only fires for
      // whoever is currently behind - the other player can land on that row with no effect.
      let times = 1;
      if (result !== 'ZONKE') {
        if (row === this.bonusRow) {
          times = 2;
          bonusHit = true;
        } else if (row === this.lifelineRow && this.isTrailing(playerIndex)) {
          times = this.lifelineMultiplier;
          lifelineMultiplierHit = this.lifelineMultiplier;
        }
      }
      for (let i = 0; i < times; i++) {
        if (opponent.deadRows[row] || active.deadRows[row]) break;
        if (this.rowFigureParts[row][playerIndex] < FIGURE_PARTS.length) {
          this.rowFigureParts[row][playerIndex] += 1;
          drew += 1;
          continue;
        }
        const outcome = advanceBullet(
          active,
          opponent,
          row,
          this.rowBullets[row][playerIndex],
          playerIndex
        );
        this.rowBullets[row][playerIndex] = Math.min(
          BULLET_STEPS,
          this.rowBullets[row][playerIndex] + 1
        );
        last = outcome;
      }
    });

    // The bonus is consumed the moment someone actually lands on it, rather than waiting
    // out its normal countdown - claiming it is what makes a new one appear.
    if (bonusHit) this.pickBonusRow();
    this.bonusJustHit = bonusHit;
    // Consumed on use, same as the regular bonus - ensureLifeline() (called after this, in
    // resolveLaunch) re-picks it only if whoever used it is still behind afterwards.
    if (lifelineMultiplierHit > 0) this.lifelineRow = null;
    const prefix = bonusHit
      ? '2x row! '
      : lifelineMultiplierHit > 0
        ? `${lifelineMultiplierHit}x LIFELINE! `
        : '';

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

  /**
   * The end of a match is an event, not a status line: the board dims, the winner's name
   * fills the screen, and the run's own numbers - kills and how long it took - are offered
   * for the leaderboard right there, which is the only moment they exist.
   */
  private showCelebration(winner: PlayerState, reason: string): void {
    const DEPTH = 20;
    const human = this.players[0];
    const cpu = this.players[1];
    const playerWon = winner === human;
    const durationMs = Math.round(this.matchDurationMs());
    const maxW = CANVAS_W * 0.92;

    // Interactive purely to swallow taps, so nothing reaches the board underneath.
    this.add
      .rectangle(CENTER_X, CANVAS_H / 2, CANVAS_W, CANVAS_H, 0x000000, 0.86)
      .setOrigin(0.5)
      .setDepth(DEPTH)
      .setInteractive();

    this.launchConfetti(DEPTH + 1, playerWon);

    const title = this.add
      .text(CENTER_X, 0, `${winner.name.toUpperCase()} WINS!`, {
        fontSize: fs(88),
        color: playerWon ? '#ffd54f' : '#ff8a65',
        fontStyle: 'bold',
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 2);
    fitLabel(title, maxW);

    const subtitle = this.add
      .text(CENTER_X, 0, reason, {
        fontSize: fs(22),
        color: '#dddddd',
        align: 'center',
        wordWrap: { width: maxW },
      })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 2);

    const stats = this.add
      .text(
        CENTER_X,
        0,
        `Kills  ${human.kills} - ${cpu.kills}      Time  ${formatClock(durationMs)}`,
        { fontSize: fs(26), color: '#ffffff', fontStyle: 'bold' }
      )
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 2);
    fitLabel(stats, maxW);

    let btnW = Math.min(440 * S, CANVAS_W * 0.86);
    let btnH = 54 * S;
    const makeButton = (label: string, color: number, onClick: () => void) => {
      const rect = this.add
        .rectangle(CENTER_X, 0, btnW, btnH, color, 0.16)
        .setStrokeStyle(1, color, 0.85)
        .setDepth(DEPTH + 2)
        .setInteractive({ useHandCursor: true });
      const text = this.add
        .text(CENTER_X, 0, label, { fontSize: fs(23), color: '#ffffff' })
        .setOrigin(0.5)
        .setDepth(DEPTH + 3);
      fitLabel(text, btnW - 20 * S);
      rect.on(
        'pointerdown',
        (_p: unknown, _x: unknown, _y: unknown, event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          onClick();
        }
      );
      return { rect, text };
    };

    const board = this.add
      .text(CENTER_X, 0, '', {
        fontSize: fs(18),
        color: '#cccccc',
        align: 'center',
        lineSpacing: 5 * S,
      })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 2);

    let saving = false;
    let saved = false;
    const setButtonLabel = (btn: { text: Phaser.GameObjects.Text }, label: string): void => {
      btn.text.setFontSize(Math.max(1, Math.round(23 * S)));
      btn.text.setText(label);
      fitLabel(btn.text, btnW - 20 * S);
    };

    const save = makeButton(
      `Save my score - ${human.kills} kills in ${formatClock(durationMs)}`,
      0x4caf50,
      () => void onSave()
    );

    const onSave = async (): Promise<void> => {
      if (saving || saved) return;
      saving = true;
      setButtonLabel(save, 'Saving...');
      const ok = await submitScore({
        name: human.name,
        score: human.kills,
        // The API's floor is one second; a match can't realistically be shorter, but a
        // rejected submission over a rounding edge would be a silly way to lose a run.
        durationMs: Math.max(1000, durationMs),
        mode: 'zonke',
        won: playerWon,
      });
      saving = false;
      // A restart while the request was in flight destroys these objects - Phaser clears
      // .scene on destroy, which is the cheapest way to ask "is this still on screen?".
      if (!save.text.scene || !board.scene) return;
      if (!ok) {
        setButtonLabel(save, 'Save failed - tap to try again');
        return;
      }
      saved = true;
      setButtonLabel(save, 'Score saved');
      track('score_saved', { mode: this.mode?.name, kills: human.kills, durationMs });
      board.setText('Loading leaderboard...');
      // The fastest WINS, not the highest scores - beating the CPU quickly is the thing
      // worth racing, and a long grind to four kills says less than a short one.
      const top = await fetchTopScores(10, 'zonke', 'fastest');
      if (!board.scene) return;
      board.setText(
        top.length
          ? [
              'Fastest wins',
              ...top.map((r, i) => `${i + 1}. ${r.name}  -  ${formatClock(r.durationMs)}  (${r.score} kills)`),
            ].join('\n')
          : 'No wins saved yet - be the first!'
      );
    };

    const play = makeButton('Play again', 0xffd54f, () => this.restartGame());

    // Laid out as a measured top-down stack, the same way the difficulty picker is, so
    // nothing overlaps once wrapping and font-fitting have had their say.
    let gap = 16 * S;
    const stack = (): number => {
      // The leaderboard arrives later; hold its space now so it can't run off the bottom.
      board.setText('\n\n\n\n\n');
      let cy = 0;
      title.setY(cy);
      cy += title.height + gap;
      subtitle.setY(cy);
      cy += subtitle.height + gap * 0.5;
      stats.setY(cy);
      cy += stats.height + gap;
      [save, play].forEach(({ rect, text }) => {
        rect.setY(cy + btnH / 2);
        text.setY(cy + btnH / 2);
        cy += btnH + gap * 0.5;
      });
      cy += gap * 0.4;
      board.setY(cy);
      cy += board.height;
      board.setText('');
      return cy;
    };

    let contentH = stack();
    if (contentH > CANVAS_H * 0.94) {
      const shrink = Phaser.Math.Clamp((CANVAS_H * 0.94) / contentH, 0.5, 1);
      [title, subtitle, stats, board, save.text, play.text].forEach((t) =>
        t.setFontSize(Math.max(9, Math.round(parseInt(t.style.fontSize as string, 10) * shrink)))
      );
      btnH *= shrink;
      btnW *= shrink;
      gap *= shrink;
      [save, play].forEach(({ rect }) => rect.setSize(btnW, btnH));
      contentH = stack();
    }

    const startY = Math.max(8 * S, (CANVAS_H - contentH) / 2);
    [title, subtitle, stats, board].forEach((t) => t.setY(t.y + startY));
    [save, play].forEach(({ rect, text }) => {
      rect.setY(rect.y + startY);
      text.setY(text.y + startY);
    });

    // The name lands, then breathes - a static headline reads like an error dialog.
    this.tweens.add({ targets: title, scale: { from: 0.55, to: 1 }, ease: 'Back.Out', duration: 550 });
    this.tweens.add({
      targets: title,
      scale: { from: 1, to: 1.04 },
      duration: 900,
      delay: 600,
      yoyo: true,
      repeat: -1,
    });
  }

  /** Paper falling over the win screen. Muted when it was the CPU that won. */
  private launchConfetti(depth: number, celebratory: boolean): void {
    const colors = celebratory
      ? [0xffd54f, 0x4caf50, 0x2196f3, 0xff5252, 0xffffff, SPLIT_COLOR_HEX]
      : [0x666666, 0x888888, 0xaaaaaa];
    for (let i = 0; i < 44; i++) {
      const x = Phaser.Math.Between(0, CANVAS_W);
      const w = Phaser.Math.Between(6, 13) * S;
      const piece = this.add
        .rectangle(x, -20 * S, w, w * Phaser.Math.FloatBetween(0.35, 0.7), Phaser.Utils.Array.GetRandom(colors))
        .setDepth(depth)
        .setAngle(Phaser.Math.Between(0, 360));
      this.tweens.add({
        targets: piece,
        y: CANVAS_H + 40 * S,
        x: x + Phaser.Math.Between(-90, 90) * S,
        angle: piece.angle + Phaser.Math.Between(180, 720),
        duration: Phaser.Math.Between(2400, 4600),
        delay: Phaser.Math.Between(0, 2600),
        repeat: -1,
      });
    }
  }

  private restartGame(): void {
    if (!this.gameOver) return;
    this.scene.restart({ mode: this.mode });
  }

  /**
   * The board's own layout is derived from the canvas size, so there is no cheap way to
   * relayout in place - a resize (rotating the phone, resizing the browser window) restarts
   * the round instead, keeping the chosen difficulty. Small size changes (mobile toolbars
   * showing/hiding as the page scrolls) are ignored so those don't reset an in-progress game.
   */
  private onScaleResize(gameSize: { width: number; height: number }): void {
    const dw = Math.abs(gameSize.width - this.laidOutW);
    const dh = Math.abs(gameSize.height - this.laidOutH);
    if (dw < 60 && dh < 60) return;
    // Dragging a DevTools device frame (or an OS window edge) fires many resize events in
    // quick succession - debounce so a settling drag collapses into one restart against the
    // final size, instead of restarting mid-drag against whatever size happened to be
    // current when the very first event arrived.
    this.resizeTimer?.remove();
    this.resizeTimer = this.time.delayedCall(250, () => {
      this.scene.restart({ mode: this.mode });
    });
  }

  private redrawAll(): void {
    this.players.forEach((p, i) => {
      this.killTexts[i].setText(`Kills: ${p.kills}`);
    });

    this.cellTextPool.forEach((row) => row.forEach((sub) => sub.forEach((t) => t.setText(''))));
    this.miniFigureGfx.forEach((row) => row.forEach((g) => g.clear()));
    this.bulletGfx.clear();

    // A bullet is one dash per letter, laid down from the shooter's own side of the board.
    this.rowBullets.forEach((row, slot) =>
      row.forEach((steps, sub) => {
        if (steps > 0) this.drawBulletTrack(slot, sub as 0 | 1, steps);
      })
    );

    // A row that has been shot gets its figure crossed out in red on the side that lost it.
    this.players.forEach((p, i) =>
      p.deadRows.forEach((dead, slot) => {
        if (!dead) return;
        const x = FIGURE_X[i];
        const y = LOG_TOP + slot * ROW_H + ROW_H / 2;
        const r = 13 * FIGURE_SCALE;
        this.bulletGfx.lineStyle(3, 0xff5252, 0.95);
        this.bulletGfx.lineBetween(x - r, y - r, x + r, y + r);
        this.bulletGfx.lineBetween(x + r, y - r, x - r, y + r);
      })
    );

    // One figure per row, in the margin level with that row, on that player's side. Each
    // row's figure is built only by the balls that landed in it.
    if (USE_3D_ACTORS) return; // the overlay draws the figures; the rest of the board is unchanged
    this.rowFigureParts.forEach((row, slot) =>
      row.forEach((count, sub) => {
        if (count === 0) return;
        this.drawMiniFigure(
          this.miniFigureGfx[slot][sub],
          FIGURE_X[sub],
          LOG_TOP + slot * ROW_H + ROW_H / 2,
          FIGURE_PARTS.map((_part, i) => i < count),
          sub as 0 | 1,
          FIGURE_SCALE
        );
      })
    );
  }

  /**
   * One dash per letter the bullet has reached, running from the shooter's own side towards
   * the opponent: player 1 lays them down from A onwards, the CPU back from H.
   */
  private drawBulletTrack(slot: number, sub: 0 | 1, steps: number): void {
    const g = this.bulletGfx;
    const y = LOG_TOP + slot * ROW_H + sub * SUB_H + SUB_H / 2;
    const color = sub === 0 ? P1_COLOR_HEX : P2_COLOR_HEX;
    const dash = CELL_W * 0.42;

    g.lineStyle(3, color, 0.95);
    for (let i = 0; i < steps; i++) {
      const col = sub === 0 ? i : ROWS.length - 1 - i;
      const cx = GRID_LEFT + col * CELL_W + CELL_W / 2;
      g.lineBetween(cx - dash / 2, y, cx + dash / 2, y);
    }
  }

  private drawMiniFigure(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    drawnParts: boolean[],
    sub: 0 | 1,
    scale = 1
  ): void {
    g.clear();
    const color = sub === 0 ? P1_COLOR_HEX : P2_COLOR_HEX;
    // Player 2's figure is a mirror image of player 1's (gun arm points the other way).
    const m = (sub === 0 ? 1 : -1) * scale;
    const v = scale; // vertical scale
    // Limbs scale as filled quads, not hairlines - a flat 2px stroke stayed spindly next to
    // a head/torso that grow with FIGURE_SCALE, which is a lot of why this looked thin.
    const lineW = Math.max(1.5, 2.4 * v);
    g.lineStyle(lineW, color, 1);
    g.fillStyle(color, 1);

    const has = (part: (typeof FIGURE_PARTS)[number]) => drawnParts[FIGURE_PARTS.indexOf(part)];

    // A filled torso block instead of a bare spine line - reads as a body at small sizes
    // where a single-pixel line all but disappears.
    if (has('spine')) {
      g.fillRoundedRect(x - 2.6 * v, y - 7 * v, 5.2 * v, 15 * v, 1.6 * v);
    }
    if (has('head')) {
      g.fillCircle(x, y - 13 * v, 5.2 * v);
    }
    if (has('leftArm')) {
      g.lineBetween(x - 1.6 * v, y - 5 * v, x - 9 * m, y + 4 * v);
    }
    if (has('rightArm')) {
      g.lineBetween(x + 1.6 * v, y - 5 * v, x + 10 * m, y - 5 * v);
    }
    if (has('leftLeg')) {
      g.lineBetween(x - 1.6 * v, y + 8 * v, x - 8 * m, y + 19 * v);
    }
    if (has('rightLeg')) {
      g.lineBetween(x + 1.6 * v, y + 8 * v, x + 8 * m, y + 19 * v);
    }
    if (has('gun')) {
      // A recognisable pistol silhouette - barrel plus grip - held at the gun hand and
      // pointed the direction this player actually shoots, not two floating boxes. Drawn
      // in a neutral gunmetal fill with a dark outline rather than the body's own colour -
      // solid-on-solid, it read as a bent arm rather than a held object.
      const hx = x + 10 * m;
      const hy = y - 5 * v;
      const barrelW = 13 * m;
      const barrelH = 3.4 * v;
      const gripW = 3 * m;
      const gripH = 6.4 * v;
      g.fillStyle(0xe4e4e4, 1);
      g.fillRect(hx, hy - barrelH / 2, barrelW, barrelH);
      g.fillRect(hx - 1 * m, hy - 0.4 * v, gripW, gripH);
      g.lineStyle(Math.max(1, 1.1 * v), 0x1a1a1a, 0.9);
      g.strokeRect(hx, hy - barrelH / 2, barrelW, barrelH);
      g.strokeRect(hx - 1 * m, hy - 0.4 * v, gripW, gripH);
    }
  }
}
