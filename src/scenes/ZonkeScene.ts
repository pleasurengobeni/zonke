import Phaser from 'phaser';
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
const FRICTION = 0.21; // speed scrubbed off every 16ms frame
const STOP_SPEED = 0.35; // below this the ball has come to rest
const WALL_BOUNCE = 0.85; // energy kept bouncing off a wall (sides, and the one above ZONKE)
const BOUNCE_SPREAD = 1.0; // how wide the wall can kick the ball off (radians either side)
const POWER_MAX = 1.55; // 1.0 reaches row 10; past that is the ZONKE band, then the wall
const BALL_R = 8;


interface Mode {
  name: string;
  wallY: number; // the wall sits lower in harder modes, leaving a thinner ZONKE band
  chargeMs: number; // a faster bar makes that band a shorter moment in real time
  jitter: number; // random power the shot picks up on release
  cpuAim: number; // how often the CPU actually goes for the jackpot
  cpuError: number; // how far its aim drifts when it does
}

// Two levers make ZONKE harder: the wall drops so there is less room to stop in above row
// 10, and the bar charges faster so that room passes sooner. Measured windows are roughly
// 365ms of a 1900ms charge on Easy, 156ms of 1300ms on Moderate, 65ms of 1000ms on Hard.
const MODES: Mode[] = [
  { name: 'Easy', wallY: 103, chargeMs: 1900, jitter: 0, cpuAim: 0.1, cpuError: 0.6 },
  { name: 'Moderate', wallY: 125, chargeMs: 1300, jitter: 0.04, cpuAim: 0.45, cpuError: 0.18 },
  { name: 'Hard', wallY: 138, chargeMs: 1000, jitter: 0.08, cpuAim: 0.75, cpuError: 0.06 },
];

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

// Power maps straight onto height: 0 barely clears row 1, 1.0 puts the apex in the ZONKE
// band, and anything past that drives the ball into the top line.
const APEX_FLOOR_Y = LOG_TOP + (MAX_VISIBLE_ROWS - 1) * ROW_H + ROW_H / 2; // centre of row 1
const APEX_SPAN = APEX_FLOOR_Y - (LOG_TOP - 5); // travel from row 1 to just inside the ZONKE band



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
  private mode: Mode | null = null; // null while the difficulty is still being chosen
  private modeUi: Phaser.GameObjects.GameObject[] = [];
  private bulletGfx!: Phaser.GameObjects.Graphics;

  constructor() {
    super('ZonkeScene');
  }

  init(data: { mode?: Mode }): void {
    this.mode = data?.mode ?? null;
  }

  create(): void {
    this.players = [createPlayer('Player 1'), createPlayer('CPU')];
    this.activeIndex = 0;
    this.resetBoard();
    this.gameOver = false;

    this.add
      .text(400, 12, 'ZONKE', { fontSize: '26px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5, 0);

    this.add.text(85, 40, 'Player 1', { fontSize: '15px', color: P1_COLOR }).setOrigin(0.5, 0);
    this.add.text(715, 40, 'CPU', { fontSize: '15px', color: P2_COLOR }).setOrigin(0.5, 0);

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
        'Land on a row to draw its figure. Once it holds a gun, each landing steps its bullet one letter - past H it hits.',
        { fontSize: '11px', color: '#888888' }
      )
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

    this.redrawAll();

    if (this.mode) {
      this.armBall();
    } else {
      this.showModePicker();
    }
  }

  private showModePicker(): void {
    const panel = this.add.rectangle(400, 415, 460, 210, 0x000000, 0.82).setOrigin(0.5);
    const title = this.add
      .text(400, 335, 'Choose difficulty', { fontSize: '22px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5, 0);
    const lines = MODES.map((m, i) =>
      this.add
        .text(400, 380 + i * 34, `${i + 1}   ${m.name}`, { fontSize: '18px', color: '#ffd54f' })
        .setOrigin(0.5, 0)
    );
    const hint = this.add
      .text(400, 490, 'Harder modes charge faster and the CPU aims better', {
        fontSize: '12px',
        color: '#aaaaaa',
      })
      .setOrigin(0.5, 0);
    this.modeUi = [panel, title, hint, ...lines];
    this.turnText.setText('');
    this.messageText.setText('');
  }

  private chooseMode(index: number): void {
    if (this.mode) return;
    this.mode = MODES[index];
    this.modeUi.forEach((o) => o.destroy());
    this.modeUi = [];
    this.turnText.setText("Player 1's turn");
    this.messageText.setText('Hold SPACE to charge, release to launch');
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
      const isLast = i === ROWS.length - 1;
      this.add
        .text(cx, HEADER_TOP + 36, row, {
          fontSize: '18px',
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
    const high = (APEX_FLOOR_Y - this.mode.wallY) / APEX_SPAN;
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
    if (this.gameOver || !this.mode) return;

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
    const wall = this.mode!.wallY;
    if (this.ballY < wall) {
      this.ballY = wall;
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

    this.time.delayedCall(450, () => {
      this.resolveLaunch(this.activeIndex as 0 | 1, result, slot, knockedBack);
    });
  }

  private resolveLaunch(
    activeIndexAtLaunch: 0 | 1,
    result: LaunchResult,
    slot: number,
    overCharged = false
  ): void {
    const active = this.players[activeIndexAtLaunch];
    const opponent = this.players[1 - activeIndexAtLaunch];

    const outcome = this.applyToBoard(activeIndexAtLaunch, result, slot, active, opponent);
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

  private resetBoard(): void {
    this.rowBullets = Array.from({ length: MAX_VISIBLE_ROWS }, () => [0, 0]);
    this.rowFigureParts = Array.from({ length: MAX_VISIBLE_ROWS }, () => [0, 0]);
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
    const live = slots.filter((row) => !opponent.deadRows[row]);

    if (live.length === 0) {
      return {
        kind: 'row-already-dead',
        result,
        message: `Row ${rowLabel(slot)} on ${opponent.name} is already down - no effect.`,
      };
    }

    let drew = 0;
    let last: TurnOutcome | null = null;

    live.forEach((row) => {
      if (this.rowFigureParts[row][playerIndex] < FIGURE_PARTS.length) {
        this.rowFigureParts[row][playerIndex] += 1;
        drew += 1;
        return;
      }
      const outcome = advanceBullet(active, opponent, row, this.rowBullets[row][playerIndex]);
      this.rowBullets[row][playerIndex] = Math.min(
        BULLET_STEPS,
        this.rowBullets[row][playerIndex] + 1
      );
      last = outcome;
    });

    if (last) {
      const fired = last as TurnOutcome;
      return drew > 0
        ? { ...fired, message: `${fired.message} (+${drew} row(s) drew a part)` }
        : fired;
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
          : `${active.name} landed on row ${rowLabel(slot)} - drew ${part}`,
    };
  }

  private restartGame(): void {
    if (!this.gameOver) return;
    this.scene.restart({ mode: this.mode });
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

    // A row that has been shot shows the hit on the far side from whoever fired.
    this.players.forEach((p, i) =>
      p.deadRows.forEach((dead, slot) => {
        if (!dead) return;
        const shooterSub = (1 - i) as 0 | 1;
        const endCol = shooterSub === 0 ? ROWS.length - 1 : 0;
        this.cellTextPool[slot][i][endCol].setText('X').setColor(KILL_COLOR);
      })
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
