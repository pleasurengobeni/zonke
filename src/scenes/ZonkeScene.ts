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
const BOUNCE_SPREAD = 1.0; // how wide the wall can kick the ball off (radians either side)
const CHARGE_MS = 1900; // hold time to fill the power bar from nothing to maximum
const POWER_MAX = 1.55; // 1.0 reaches row 10; past that is the ZONKE band, then the wall
const BALL_R = 8;

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

/** A mark sitting in the cell a ball came to rest in. */
interface CellMark {
  result: LaunchResult;
  kind: TurnResultKind;
}

export class ZonkeScene extends Phaser.Scene {
  private players!: [PlayerState, PlayerState];
  private activeIndex = 0;
  // Everything a turn draws goes in the cell the ball landed in: [rowSlot][0=p1/1=p2][col]
  private boardMarks: (CellMark | undefined)[][][] = [];

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
    this.resetBoardMarks();
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
    // Straight up the board - the shot has no sideways component of its own.
    this.ballVx = 0;
    this.ballVy = -Math.sqrt(2 * FRICTION * distance);

    this.columnHighlight.setVisible(true);
    this.columnHighlight.setFillStyle(this.activeIndex === 0 ? P1_COLOR_HEX : P2_COLOR_HEX, 0.15);
  }

  update(_time: number, delta: number): void {
    if (this.gameOver) return;

    if (this.charging) {
      const held = this.time.now - this.chargeStart;
      // Deliberately no gauge: the player has to judge the hold by feel, which is what
      // keeps the ZONKE band hard to hit. The flight itself is the only feedback.
      this.power = Math.min(POWER_MAX, (held / CHARGE_MS) * POWER_MAX);
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
      // Coming off the wall is the only thing that sends the ball sideways: whatever
      // momentum it had left comes back down on a random angle.
      const speed = Math.hypot(this.ballVx, this.ballVy) * WALL_BOUNCE;
      const angle = Phaser.Math.FloatBetween(-BOUNCE_SPREAD, BOUNCE_SPREAD);
      this.ballVx = speed * Math.sin(angle);
      this.ballVy = speed * Math.cos(angle);
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

  /** Which board row the ball is sitting in; a ZONKE rests above row 10, so it pays out there. */
  private rowSlotUnderBall(): number {
    return Phaser.Math.Clamp(
      Math.floor((this.ballY - LOG_TOP) / ROW_H),
      0,
      MAX_VISIBLE_ROWS - 1
    );
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
    const slot = this.rowSlotUnderBall();
    const col = this.columnUnderBall();

    this.time.delayedCall(450, () => {
      this.resolveLaunch(this.activeIndex as 0 | 1, result, slot, col, knockedBack);
    });
  }

  private resolveLaunch(
    activeIndexAtLaunch: 0 | 1,
    result: LaunchResult,
    slot: number,
    col: number,
    overCharged = false
  ): void {
    const active = this.players[activeIndexAtLaunch];
    const opponent = this.players[1 - activeIndexAtLaunch];

    const outcome = applyLaunch(active, opponent, result);
    this.placeMark(activeIndexAtLaunch, slot, col, { result, kind: outcome.kind });
    // Landing here adds the next part to THIS row's figure, which starts from scratch.
    this.rowFigureParts[slot][activeIndexAtLaunch] = Math.min(
      FIGURE_PARTS.length,
      this.rowFigureParts[slot][activeIndexAtLaunch] + 1
    );
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

  private resetBoardMarks(): void {
    this.boardMarks = Array.from({ length: MAX_VISIBLE_ROWS }, () =>
      [0, 1].map(() => ROWS.map(() => undefined as CellMark | undefined))
    );
    this.rowFigureParts = Array.from({ length: MAX_VISIBLE_ROWS }, () => [0, 0]);
  }

  /** Records the mark in the cell the ball stopped in. A ZONKE pays out across the whole row. */
  private placeMark(playerIndex: 0 | 1, slot: number, col: number, mark: CellMark): void {
    const row = this.boardMarks[slot][playerIndex];
    if (mark.result === 'ZONKE') {
      row.forEach((_m, i) => {
        row[i] = mark;
      });
      return;
    }
    row[col] = mark;
  }

  private restartGame(): void {
    if (!this.gameOver) return;
    this.scene.restart();
  }

  private redrawAll(): void {
    this.players.forEach((p, i) => {
      this.killTexts[i].setText(`Kills: ${p.kills}`);
    });

    this.cellTextPool.forEach((row) => row.forEach((sub) => sub.forEach((t) => t.setText(''))));
    this.miniFigureGfx.forEach((row) => row.forEach((g) => g.clear()));

    // Every mark stays in the cell its ball landed in, so the board fills up as it is played.
    this.boardMarks.forEach((row, slot) =>
      row.forEach((sub, subIndex) =>
        sub.forEach((mark, col) => {
          if (mark) this.paintMark(slot, subIndex as 0 | 1, col, mark);
        })
      )
    );

    // One figure per row, in the margin level with that row, on that player's side. Each
    // row's figure is built only by the balls that landed in it.
    this.rowFigureParts.forEach((row, slot) =>
      row.forEach((count, sub) => {
        if (count === 0) return;
        const rowY = LOG_TOP + slot * ROW_H;
        this.drawMiniFigure(
          this.miniFigureGfx[slot][sub],
          sub === 0 ? 85 : 715,
          rowY + sub * SUB_H + SUB_H / 2,
          FIGURE_PARTS.map((_part, i) => i < count),
          sub as 0 | 1
        );
      })
    );
  }

  private paintMark(slot: number, sub: 0 | 1, col: number, mark: CellMark): void {
    const t = this.cellTextPool[slot][sub][col];
    const color = sub === 0 ? P1_COLOR : P2_COLOR;

    switch (mark.kind) {
      case 'part-drawn':
      case 'figure-completed':
        t.setText('\u25CF').setColor(color);
        break;
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

  private drawMiniFigure(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    drawnParts: boolean[],
    sub: 0 | 1,
    scale = 1
  ): void {
    g.clear();
    g.lineStyle(2, sub === 0 ? P1_COLOR_HEX : P2_COLOR_HEX, 1);
    // Player 2's figure is a mirror image of player 1's (gun arm points the other way).
    const m = (sub === 0 ? 1 : -1) * scale;
    const v = scale; // vertical scale

    const has = (part: (typeof FIGURE_PARTS)[number]) => drawnParts[FIGURE_PARTS.indexOf(part)];

    if (has('head')) {
      g.strokeCircle(x, y - 12 * v, 5 * v);
    }
    if (has('spine')) {
      g.lineBetween(x, y - 7 * v, x, y + 8 * v);
    }
    if (has('leftArm')) {
      g.lineBetween(x, y - 3 * v, x - 9 * m, y + 5 * v);
    }
    if (has('rightArm')) {
      g.lineBetween(x, y - 3 * v, x + 10 * m, y - 5 * v);
    }
    if (has('leftLeg')) {
      g.lineBetween(x, y + 8 * v, x - 8 * m, y + 18 * v);
    }
    if (has('rightLeg')) {
      g.lineBetween(x, y + 8 * v, x + 10 * m, y + 16 * v);
    }
    if (has('gun')) {
      g.strokeRect(x + 10 * m - (m < 0 ? 5 * v : 0), y - 8 * v, 5 * v, 3 * v);
      g.strokeRect(x + 13 * m - (m < 0 ? 3 * v : 0), y - 6 * v, 3 * v, 4 * v);
    }
  }
}
