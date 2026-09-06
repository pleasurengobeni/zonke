import Phaser from 'phaser';
import {
  ROWS,
  EDGE_ROWS,
  FIGURE_PARTS,
  createPlayer,
  applyLaunch,
  checkWin,
  type PlayerState,
  type LaunchResult,
  type Row,
  type TurnResultKind,
} from '../zonke/GameState';

// The ball is shot up the board and friction bleeds its momentum away until it stops -
// wherever it comes to rest IS the result. It never falls back down; the only thing that
// turns it around is the wall above the ZONKE row.
const FRICTION = 0.21; // speed scrubbed off every 16ms frame
const STOP_SPEED = 0.35; // below this the ball has come to rest
const WALL_BOUNCE = 0.85; // energy kept bouncing off a wall (sides, and the one above ZONKE)
const LAUNCH_TILT = 0.6; // max launch angle off vertical (radians), giving the sideways spread
const CHARGE_MS = 1900; // hold time to fill the power bar from nothing to maximum
const POWER_MAX = 1.55; // 1.0 reaches row 10; past that is the ZONKE band, then the wall
const BALL_R = 8;

// Measured from the physics above: the hold window that actually comes to rest inside the
// ZONKE band. Past the top of it the ball hits the wall hard enough to be thrown back out.
const ZONKE_POWER_MIN = 0.99;
const ZONKE_POWER_MAX = 1.268;

const P1_COLOR = '#4caf50';
const P2_COLOR = '#2196f3';
const P1_COLOR_HEX = 0x4caf50;
const P2_COLOR_HEX = 0x2196f3;
const KILL_COLOR = '#ff5252';
const NEUTRAL_COLOR = '#888888';

const CELL_W = 60;
const GRID_LEFT = 400 - (ROWS.length * CELL_W) / 2; // centered at x=400
const HEADER_TOP = 95;
const HEADER_H = 60;
const ROW_H = 48; // full round row height (P1 + P2 sub-lines)
const SUB_H = ROW_H / 2;
const MAX_VISIBLE_ROWS = 10;
const LOG_TOP = HEADER_TOP + HEADER_H;
const TABLE_BOTTOM = LOG_TOP + MAX_VISIBLE_ROWS * ROW_H;
const TOP_WALL_Y = HEADER_TOP + BALL_R; // the line above ZONKE - the only thing that bounces it back

// Power maps straight onto height: 0 barely clears row 1, 1.0 puts the apex in the ZONKE
// band, and anything past that drives the ball into the top line.
const APEX_FLOOR_Y = LOG_TOP + (MAX_VISIBLE_ROWS - 1) * ROW_H + ROW_H / 2; // centre of row 1
const APEX_SPAN = APEX_FLOOR_Y - (LOG_TOP - 5); // travel from row 1 to just inside the ZONKE band

interface TurnEntry {
  result: LaunchResult;
  kind: TurnResultKind;
  figureSnapshot: boolean[]; // which parts are drawn for that player as of this turn
}

interface RoundEntry {
  p1?: TurnEntry;
  p2?: TurnEntry;
}

export class ZonkeScene extends Phaser.Scene {
  private players!: [PlayerState, PlayerState];
  private activeIndex = 0;
  private roundLog: RoundEntry[] = [];

  private killTexts: [Phaser.GameObjects.Text, Phaser.GameObjects.Text] = [
    null as any,
    null as any,
  ];
  // Pool of cell texts: [rowSlot][0=p1/1=p2][columnIndex]
  private cellTextPool: Phaser.GameObjects.Text[][][] = [];
  // Pool of per-row mini figures: [rowSlot][0=p1/1=p2]
  private miniFigureGfx: Phaser.GameObjects.Graphics[][] = [];

  private turnText!: Phaser.GameObjects.Text;
  private messageText!: Phaser.GameObjects.Text;
  private columnHighlight!: Phaser.GameObjects.Rectangle;
  private powerGauge!: Phaser.GameObjects.Graphics;
  private gameOverText!: Phaser.GameObjects.Text;
  private ball!: Phaser.GameObjects.Arc;
  private ballRestY = 0;
  private ballX = 0;
  private ballY = 0;

  private ready = false; // waiting for the player to launch
  private charging = false; // SPACE is held down, power is building
  private chargeStart = 0;
  private power = 0;
  private flying = false; // ball is in the air, outcome not decided yet
  private ballVx = 0;
  private ballVy = 0;
  private hitWall = false; // over-powered: bounced off the wall above ZONKE
  private gameOver = false;

  constructor() {
    super('ZonkeScene');
  }

  create(): void {
    this.players = [createPlayer('Player 1'), createPlayer('Player 2')];
    this.activeIndex = 0;
    this.roundLog = [];
    this.gameOver = false;

    this.add
      .text(400, 12, 'ZONKE', { fontSize: '26px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5, 0);

    this.add.text(85, 40, 'Player 1', { fontSize: '15px', color: P1_COLOR }).setOrigin(0.5, 0);
    this.add.text(715, 40, 'Player 2', { fontSize: '15px', color: P2_COLOR }).setOrigin(0.5, 0);

    this.killTexts = [
      this.add.text(85, 58, 'Kills: 0', { fontSize: '12px', color: '#ffd54f' }).setOrigin(0.5, 0),
      this.add.text(715, 58, 'Kills: 0', { fontSize: '12px', color: '#ffd54f' }).setOrigin(0.5, 0),
    ];

    this.drawHeader();
    this.createCellPool();

    this.ballRestY = TABLE_BOTTOM + 30;
    this.ball = this.add.circle(0, 0, 8, 0xffd54f);
    this.positionBallAtRest();

    const turnY = this.ballRestY + 30;
    this.turnText = this.add
      .text(400, turnY, "Player 1's turn", { fontSize: '20px', color: P1_COLOR })
      .setOrigin(0.5, 0);

    this.messageText = this.add
      .text(400, turnY + 30, 'Hold SPACE to charge, release to launch', {
        fontSize: '14px',
        color: '#cccccc',
      })
      .setOrigin(0.5, 0);

    this.gameOverText = this.add
      .text(400, turnY + 65, '', { fontSize: '18px', color: '#ffeb3b', fontStyle: 'bold' })
      .setOrigin(0.5, 0);

    this.add
      .text(
        400,
        turnY + 100,
        'More power = further up. Stop in the ZONKE band for the jackpot - overshoot and the wall throws you back.',
        { fontSize: '11px', color: '#888888' }
      )
      .setOrigin(0.5, 0);

    this.powerGauge = this.add.graphics();
    this.columnHighlight = this.add
      .rectangle(0, HEADER_TOP, CELL_W, TABLE_BOTTOM - HEADER_TOP, 0xffffff, 0.12)
      .setOrigin(0.5, 0)
      .setVisible(false);

    this.input.keyboard!.on('keydown-SPACE', this.onChargeStart, this);
    this.input.keyboard!.on('keyup-SPACE', this.onRelease, this);
    this.input.keyboard!.on('keydown-R', this.restartGame, this);

    this.redrawAll();
    this.armBall();
  }

  private drawHeader(): void {
    const g = this.add.graphics();
    g.lineStyle(2, 0xffffff, 1);

    const tableWidth = ROWS.length * CELL_W;

    // Outer border around the whole table (header + all round rows).
    g.strokeRect(GRID_LEFT, HEADER_TOP, tableWidth, TABLE_BOTTOM - HEADER_TOP);
    g.lineBetween(GRID_LEFT, LOG_TOP, GRID_LEFT + tableWidth, LOG_TOP);

    // Row dividers for each round row (thicker) + sub-line divider (thinner, dashed feel via alpha).
    for (let r = 0; r < MAX_VISIBLE_ROWS; r++) {
      const y = LOG_TOP + r * ROW_H;
      if (r > 0) {
        g.lineStyle(2, 0xffffff, 1);
        g.lineBetween(GRID_LEFT, y, GRID_LEFT + tableWidth, y);
      }
      g.lineStyle(1, 0xffffff, 0.35);
      g.lineBetween(GRID_LEFT, y + SUB_H, GRID_LEFT + tableWidth, y + SUB_H);

      // Row position label: bottom row = 1, counting upward to MAX_VISIBLE_ROWS at the top.
      const rowNumber = MAX_VISIBLE_ROWS - r;
      this.add
        .text(GRID_LEFT - 14, y + ROW_H / 2, String(rowNumber), {
          fontSize: '13px',
          color: '#777777',
        })
        .setOrigin(1, 0.5);
    }

    // The header row IS the ZONKE row - "ZONKE" sits on its own line on top, bigger and clear
    // of the column letters/numbers stacked below it, so nothing overlaps.
    this.add
      .text(GRID_LEFT + tableWidth / 2, HEADER_TOP + 4, 'ZONKE', {
        fontSize: '26px',
        color: '#ffd54f',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0);

    ROWS.forEach((row, i) => {
      const cx = GRID_LEFT + i * CELL_W + CELL_W / 2;
      const isEdge = EDGE_ROWS.includes(row);
      this.add
        .text(cx, HEADER_TOP + 36, row, {
          fontSize: '18px',
          color: isEdge ? KILL_COLOR : '#ffffff',
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
        const y = rowY + sub * SUB_H + 4;
        const subTexts: Phaser.GameObjects.Text[] = [];
        ROWS.forEach((_row, i) => {
          const cx = GRID_LEFT + i * CELL_W + CELL_W / 2;
          const t = this.add
            .text(cx, y, '', { fontSize: '16px', color: NEUTRAL_COLOR })
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
    this.ballVx = 0;
    this.ballVy = 0;
    this.hitWall = false;
    this.positionBallAtRest();
    this.columnHighlight.setVisible(false);
    this.drawPowerGauge();
  }

  /** Where a given power brings the ball to rest - this IS the row/ZONKE mapping. */
  private restingYFor(power: number): number {
    return APEX_FLOOR_Y - power * APEX_SPAN;
  }

  private onChargeStart(): void {
    if (this.gameOver || this.flying || this.charging || !this.ready) return;
    this.charging = true;
    this.power = 0;
    this.chargeStart = this.time.now;
    this.messageText.setText('Charging - release to launch');
  }

  private onRelease(): void {
    if (!this.charging) return;
    this.charging = false;
    this.ready = false;
    this.flying = true;
    this.hitWall = false;

    // Power buys distance. Friction then eats exactly that much momentum, so the ball
    // coasts to a stop at the height the gauge promised - it does not fall back.
    const target = Math.max(this.ballRestY - this.restingYFor(this.power), 1);
    // Stepping in whole frames loses about half a frame of travel, so aim slightly past the
    // target - that keeps the ball stopping exactly where the gauge promised it would.
    const distance = target + Math.sqrt(2 * FRICTION * target) / 2;
    const tilt = Phaser.Math.FloatBetween(-LAUNCH_TILT, LAUNCH_TILT);
    const speed = Math.sqrt((2 * FRICTION * distance) / Math.cos(tilt));
    this.ballVx = speed * Math.sin(tilt);
    this.ballVy = -speed * Math.cos(tilt);

    this.columnHighlight.setVisible(true);
    this.columnHighlight.setFillStyle(this.activeIndex === 0 ? P1_COLOR_HEX : P2_COLOR_HEX, 0.15);
    this.drawPowerGauge();
  }

  update(_time: number, delta: number): void {
    if (this.gameOver) return;

    if (this.charging) {
      const held = this.time.now - this.chargeStart;
      this.power = Math.min(POWER_MAX, (held / CHARGE_MS) * POWER_MAX);
      this.drawPowerGauge();
      return;
    }

    if (!this.flying) return;

    // Integrate in fixed 16ms steps so the same power always travels the same distance.
    const steps = Math.min(4, Math.max(1, Math.round(delta / 16.667)));
    for (let i = 0; i < steps && this.flying; i++) {
      this.stepBall();
    }

    this.ball.setPosition(this.ballX, this.ballY);
    this.highlightColumnUnderBall();
  }

  /** One 16ms tick: friction bleeds momentum, walls turn the ball around. */
  private stepBall(): void {
    const speed = Math.hypot(this.ballVx, this.ballVy);
    const slowed = speed - FRICTION;
    if (speed < STOP_SPEED || slowed <= 0) {
      this.settle();
      return;
    }

    // Friction acts against the direction of travel, so the ball keeps its heading.
    const scale = slowed / speed;
    this.ballVx *= scale;
    this.ballVy *= scale;
    this.ballX += this.ballVx;
    this.ballY += this.ballVy;

    const left = GRID_LEFT + BALL_R;
    const right = GRID_LEFT + ROWS.length * CELL_W - BALL_R;
    if (this.ballX < left) {
      this.ballX = left;
      this.ballVx = Math.abs(this.ballVx) * WALL_BOUNCE;
    } else if (this.ballX > right) {
      this.ballX = right;
      this.ballVx = -Math.abs(this.ballVx) * WALL_BOUNCE;
    }

    // The wall above ZONKE is the one thing that sends it back. Whatever momentum it still
    // had going up now carries it back down, so the harder you overshot, the lower you land.
    if (this.ballY < TOP_WALL_Y) {
      this.ballY = TOP_WALL_Y;
      this.ballVy = Math.abs(this.ballVy) * WALL_BOUNCE;
      this.hitWall = true;
    }

    if (this.ballY > this.ballRestY) {
      this.ballY = this.ballRestY;
      this.ballVy = -Math.abs(this.ballVy) * WALL_BOUNCE;
    }
  }

  private highlightColumnUnderBall(): void {
    const cx = GRID_LEFT + this.columnUnderBall() * CELL_W + CELL_W / 2;
    this.columnHighlight.setPosition(cx, HEADER_TOP);
  }

  private columnUnderBall(): number {
    return Phaser.Math.Clamp(Math.floor((this.ballX - GRID_LEFT) / CELL_W), 0, ROWS.length - 1);
  }

  /** The ball has stopped. Whatever cell it is sitting in is the result. */
  private settle(): void {
    this.flying = false;
    this.ballVx = 0;
    this.ballVy = 0;
    this.ball.setPosition(this.ballX, this.ballY);
    this.columnHighlight.setVisible(false);

    // Coming to rest above row 10 means it stopped in the ZONKE band - the jackpot.
    const jackpot = this.ballY < LOG_TOP;
    const result: LaunchResult = jackpot ? 'ZONKE' : (ROWS[this.columnUnderBall()] as Row);
    const knockedBack = this.hitWall && !jackpot;

    this.time.delayedCall(450, () => {
      this.resolveLaunch(this.activeIndex as 0 | 1, result, knockedBack);
    });
  }

  /** Vertical power bar running alongside the rows, so the height it buys is readable. */
  private drawPowerGauge(): void {
    const g = this.powerGauge;
    g.clear();

    const x = GRID_LEFT - 34;
    const w = 10;
    const top = TOP_WALL_Y; // the ball can never come to rest above the wall
    const bottom = APEX_FLOOR_Y;

    g.fillStyle(0x000000, 0.35);
    g.fillRect(x, top, w, bottom - top);

    // The ZONKE band - the stretch of the bar that wins the jackpot.
    g.fillStyle(0xffd54f, 0.25);
    g.fillRect(x, top, w, LOG_TOP - top);

    if (this.power > 0) {
      const over = this.power > ZONKE_POWER_MAX;
      const fillTop = Phaser.Math.Clamp(this.restingYFor(this.power), top, bottom);
      const color = over ? 0xff5252 : this.power >= ZONKE_POWER_MIN ? 0xffd54f : 0x4caf50;
      g.fillStyle(color, 0.95);
      g.fillRect(x, fillTop, w, bottom - fillTop);

      // Past the jackpot window the bar is pegged, so show the overshoot growing outward
      // instead - that is how much the wall is about to throw the ball back down.
      if (over) {
        const spill = ((this.power - ZONKE_POWER_MAX) / (POWER_MAX - ZONKE_POWER_MAX)) * 14;
        g.fillStyle(0xff5252, 0.85);
        g.fillRect(x - spill - 2, top, spill, 6);
      }
    }

    g.lineStyle(1, 0xffffff, 0.4);
    g.strokeRect(x, top, w, bottom - top);
    g.lineStyle(1, 0xffd54f, 0.9);
    g.lineBetween(x - 3, LOG_TOP, x + w + 3, LOG_TOP);
  }

  private resolveLaunch(
    activeIndexAtLaunch: 0 | 1,
    result: LaunchResult,
    overCharged = false
  ): void {
    const active = this.players[activeIndexAtLaunch];
    const opponent = this.players[1 - activeIndexAtLaunch];

    const outcome = applyLaunch(active, opponent, result);
    this.pushRoundEntry(activeIndexAtLaunch, {
      result,
      kind: outcome.kind,
      figureSnapshot: [...active.drawnParts],
    });
    this.messageText.setText(
      overCharged
        ? `Too much power - the wall threw it back. ${outcome.message}`
        : outcome.message
    );

    this.redrawAll();

    const win = checkWin(this.players[0], this.players[1]);
    if (win.gameOver) {
      this.gameOver = true;
      this.gameOverText.setText(`${win.reason ?? 'Game over'}  (press R to restart)`);
      this.turnText.setText('Game Over');
      return;
    }

    this.activeIndex = 1 - activeIndexAtLaunch;
    this.turnText.setText(`${this.players[this.activeIndex].name}'s turn`);
    this.turnText.setColor(this.activeIndex === 0 ? P1_COLOR : P2_COLOR);
    this.armBall();
  }

  private pushRoundEntry(playerIndex: 0 | 1, entry: TurnEntry): void {
    if (playerIndex === 0) {
      this.roundLog.push({ p1: entry });
    } else {
      const current = this.roundLog[this.roundLog.length - 1];
      if (current && !current.p2) {
        current.p2 = entry;
      } else {
        this.roundLog.push({ p2: entry });
      }
    }
  }

  private restartGame(): void {
    if (!this.gameOver) return;
    this.scene.restart();
  }

  private redrawAll(): void {
    this.players.forEach((p, i) => {
      this.killTexts[i].setText(`Kills: ${p.kills}`);
    });

    // Clear the whole cell pool + mini figures.
    this.cellTextPool.forEach((row) => row.forEach((sub) => sub.forEach((t) => t.setText(''))));
    this.miniFigureGfx.forEach((row) => row.forEach((g) => g.clear()));

    // Anchor the newest round to the bottom-most slot; older rounds fill upward.
    const visible = this.roundLog.slice(-MAX_VISIBLE_ROWS);
    const startSlot = MAX_VISIBLE_ROWS - visible.length;

    visible.forEach((round, i) => {
      const slot = startSlot + i;
      this.paintTurn(slot, 0, round.p1);
      this.paintTurn(slot, 1, round.p2);
    });
  }

  private paintTurn(slot: number, sub: 0 | 1, entry?: TurnEntry): void {
    if (!entry) return;
    const color = sub === 0 ? P1_COLOR : P2_COLOR;
    const rowTexts = this.cellTextPool[slot][sub];

    if (entry.result === 'ZONKE') {
      // Landing on ZONKE isn't tied to one column - it marks every cell in the player's own
      // row: '-' if it loaded bullets, '●' if it drew the next shape.
      const symbol = entry.kind === 'bullet-loaded' ? '-' : '\u25CF';
      rowTexts.forEach((t) => t.setText(symbol).setColor(color));
    } else {
      const idx = ROWS.indexOf(entry.result as Row);
      const t = rowTexts[idx];
      switch (entry.kind) {
        case 'bullet-loaded':
          t.setText('-').setColor(color);
          break;
        case 'kill':
        case 'instant-hit':
          t.setText('X').setColor(KILL_COLOR);
          break;
        case 'row-already-dead':
          t.setText('\u00B7').setColor(NEUTRAL_COLOR);
          break;
      }
    }

    // Draw this player's figure-so-far in the margin next to this row (P1 = left, P2 = right).
    const rowY = LOG_TOP + slot * ROW_H;
    const figX = sub === 0 ? 85 : 715;
    const figY = rowY + sub * SUB_H + SUB_H / 2;
    this.drawMiniFigure(this.miniFigureGfx[slot][sub], figX, figY, entry.figureSnapshot, sub);
  }

  private drawMiniFigure(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    drawnParts: boolean[],
    sub: 0 | 1
  ): void {
    g.clear();
    g.lineStyle(2, sub === 0 ? P1_COLOR_HEX : P2_COLOR_HEX, 1);
    // Player 2's figure is a mirror image of player 1's (gun arm points the other way).
    const m = sub === 0 ? 1 : -1;

    const has = (part: (typeof FIGURE_PARTS)[number]) => drawnParts[FIGURE_PARTS.indexOf(part)];

    if (has('head')) {
      g.strokeCircle(x, y - 12, 5);
    }
    if (has('spine')) {
      g.lineBetween(x, y - 7, x, y + 8);
    }
    if (has('leftArm')) {
      g.lineBetween(x, y - 3, x - 9 * m, y + 5);
    }
    if (has('rightArm')) {
      g.lineBetween(x, y - 3, x + 10 * m, y - 5);
    }
    if (has('leftLeg')) {
      g.lineBetween(x, y + 8, x - 8 * m, y + 18);
    }
    if (has('rightLeg')) {
      g.lineBetween(x, y + 8, x + 10 * m, y + 16);
    }
    if (has('gun')) {
      g.strokeRect(x + 10 * m - (m < 0 ? 5 : 0), y - 8, 5, 3);
      g.strokeRect(x + 13 * m - (m < 0 ? 3 : 0), y - 6, 3, 4);
    }
  }
}
