import Phaser from 'phaser';
import { ROWS } from '../zonke/GameState';
import { track, submitScore, fetchTopScores, type TopScore } from '../analytics';
import { ensurePlayerName } from '../player';

// Same tuned physics as the main game (see ZonkeScene.ts for how these were arrived at -
// friction/bounce/ball-size all scale with S, the same way, for the same reasons). Kept as
// a second copy rather than a shared import: the two scenes' board/score models diverge
// enough (figures+bullets+two players vs solo landing-is-the-score) that sharing the whole
// module would mean threading a lot of "which mode am I" branches through one file instead
// of two simple ones.
const DESIGN_W = 1500;
const DESIGN_H = 1160;
const DESIGN_GRID_W = 1056;
const MAX_VISIBLE_ROWS = 10;
const POWER_MAX = 1.55;
const WALL_BOUNCE = 0.85;
const BOUNCE_SPREAD = 0.15;
const ZONKE_BAND = 55; // Moderate-equivalent - Time Attack has one fixed difficulty
const CHARGE_MS = 1300;

const ROUND_MS = 60_000;
const NORMAL_POINTS = 1;
const BONUS_POINTS = 2;
const ZONKE_POINTS = 20;

let S = 1;
let CANVAS_W = DESIGN_W;
let CANVAS_H = DESIGN_H;
let CENTER_X = CANVAS_W / 2;
let CELL_W = 132;
let GRID_LEFT = CENTER_X - (ROWS.length * CELL_W) / 2;
let GRID_RIGHT = GRID_LEFT + ROWS.length * CELL_W;
let HEADER_TOP = 10;
let HEADER_H = 110;
let ROW_H = 88;
let LOG_TOP = HEADER_TOP + HEADER_H;
let TABLE_BOTTOM = LOG_TOP + MAX_VISIBLE_ROWS * ROW_H;
let APEX_FLOOR_Y = LOG_TOP + (MAX_VISIBLE_ROWS - 1) * ROW_H + ROW_H / 2;
let APEX_SPAN = APEX_FLOOR_Y - (LOG_TOP - 5);
let BALL_R = 12;
let FRICTION = 0.3;
let STOP_SPEED = 0.35;

function fs(n: number): string {
  return `${Math.max(1, Math.round(n * S))}px`;
}

function computeLayout(width: number, height: number): void {
  CANVAS_W = width;
  CANVAS_H = height;
  S = height / DESIGN_H;
  CENTER_X = CANVAS_W / 2;
  CELL_W = (CANVAS_W * (DESIGN_GRID_W / DESIGN_W)) / ROWS.length;
  GRID_LEFT = CENTER_X - (ROWS.length * CELL_W) / 2;
  GRID_RIGHT = GRID_LEFT + ROWS.length * CELL_W;
  HEADER_TOP = 10 * S;
  HEADER_H = 110 * S;
  ROW_H = 88 * S;
  LOG_TOP = HEADER_TOP + HEADER_H;
  TABLE_BOTTOM = LOG_TOP + MAX_VISIBLE_ROWS * ROW_H;
  APEX_FLOOR_Y = LOG_TOP + (MAX_VISIBLE_ROWS - 1) * ROW_H + ROW_H / 2;
  APEX_SPAN = APEX_FLOOR_Y - (LOG_TOP - 5 * S);
  BALL_R = Math.min(12 * S, CELL_W * 0.4);
  FRICTION = 0.3 * S;
  STOP_SPEED = 0.35 * S;
}

export class TimeAttackScene extends Phaser.Scene {
  private score = 0;
  private roundStartAt = 0;
  private roundOver = false;

  private ball!: Phaser.GameObjects.Arc;
  private ballX = 0;
  private ballY = 0;
  private ballVx = 0;
  private ballVy = 0;
  private ballRestY = 0;
  private flying = false;
  private charging = false;
  private ready = false;
  private chargeStart = 0;
  private power = 0;

  private bonusRow: number | null = null;
  private lifelineRow: number | null = null;
  private lifelineMultiplier = 2;
  private bonusHighlight!: Phaser.GameObjects.Rectangle;
  private lifelineHighlight!: Phaser.GameObjects.Rectangle;
  private lifelineLabel!: Phaser.GameObjects.Text;

  private scoreText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private messageText!: Phaser.GameObjects.Text;

  constructor() {
    super('TimeAttackScene');
  }

  create(): void {
    computeLayout(this.scale.width, this.scale.height);
    track('time_attack_started');

    this.score = 0;
    this.roundOver = false;
    this.roundStartAt = this.time.now;

    // No separate "TIME ATTACK" title - the board's own ZONKE header already identifies
    // it, and duplicating one above the other just collides (that mistake was already
    // fixed once in ZonkeScene; same fix applies here). Score/Clock go in the side
    // margins instead, which are otherwise completely empty in this solo mode - there
    // are no opponent figures to share the space with.
    const marginX = [GRID_LEFT / 2, (GRID_RIGHT + CANVAS_W) / 2];
    this.scoreText = this.add
      .text(marginX[0], HEADER_TOP, 'Score\n0', { fontSize: fs(22), color: '#ffd54f', fontStyle: 'bold', align: 'center' })
      .setOrigin(0.5, 0);
    this.clockText = this.add
      .text(marginX[1], HEADER_TOP, '1:00', { fontSize: fs(26), color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5, 0);

    this.drawBoard();

    this.bonusHighlight = this.add
      .rectangle(0, 0, ROWS.length * CELL_W, ROW_H, 0xffd54f, 1)
      .setOrigin(0.5);
    this.tweens.add({ targets: this.bonusHighlight, alpha: { from: 0.08, to: 0.3 }, duration: 650, yoyo: true, repeat: -1 });
    this.lifelineHighlight = this.add
      .rectangle(0, 0, ROWS.length * CELL_W, ROW_H, 0xff9800, 1)
      .setOrigin(0.5);
    this.tweens.add({ targets: this.lifelineHighlight, alpha: { from: 0.1, to: 0.34 }, duration: 500, yoyo: true, repeat: -1 });
    this.lifelineLabel = this.add
      .text(0, 0, '', { fontSize: fs(22), color: '#ffb74d', fontStyle: 'bold' })
      .setOrigin(0.5)
      .setDepth(1);
    this.pickBonusRow();
    this.pickLifelineRow();

    this.ballRestY = TABLE_BOTTOM + 26 * S;
    this.ball = this.add.circle(0, 0, BALL_R, 0xffd54f);
    this.positionBallAtRest();

    this.messageText = this.add
      .text(CENTER_X, this.ballRestY + 30 * S, 'Hold to charge, release to launch - land anywhere to score', {
        fontSize: fs(17),
        color: '#cccccc',
      })
      .setOrigin(0.5, 0);

    this.input.on('pointerdown', () => this.onChargeStart());
    this.input.on('pointerup', () => this.onRelease());
    this.input.on('pointerupoutside', () => this.onRelease());
    this.input.keyboard!.on('keydown-SPACE', () => this.onChargeStart(), this);
    this.input.keyboard!.on('keyup-SPACE', () => this.onRelease(), this);
    this.input.keyboard!.on('keydown-R', () => {
      if (this.roundOver) this.scene.restart();
    }, this);

    this.ready = true;
  }

  private drawBoard(): void {
    const g = this.add.graphics();
    g.lineStyle(2, 0xffffff, 1);
    const tableWidth = ROWS.length * CELL_W;
    g.strokeRect(GRID_LEFT, HEADER_TOP, tableWidth, TABLE_BOTTOM - HEADER_TOP);
    g.lineBetween(GRID_LEFT, LOG_TOP, GRID_LEFT + tableWidth, LOG_TOP);
    for (let r = 0; r < MAX_VISIBLE_ROWS; r++) {
      const y = LOG_TOP + r * ROW_H;
      if (r > 0) {
        g.lineStyle(2, 0xffffff, 1);
        g.lineBetween(GRID_LEFT, y, GRID_LEFT + tableWidth, y);
      }
      const rowNumber = MAX_VISIBLE_ROWS - r;
      this.add
        .text(GRID_LEFT - 16 * S, y + ROW_H / 2, String(rowNumber), { fontSize: fs(18), color: '#777777' })
        .setOrigin(1, 0.5);
    }
    this.add
      .text(GRID_LEFT + tableWidth / 2, HEADER_TOP + 6 * S, 'ZONKE', {
        fontSize: fs(30),
        color: '#ffd54f',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0);
  }

  private pickBonusRow(): void {
    let next: number;
    do { next = Phaser.Math.Between(0, MAX_VISIBLE_ROWS - 1); } while (next === this.bonusRow || next === this.lifelineRow);
    this.bonusRow = next;
    this.bonusHighlight.setPosition(GRID_LEFT + (ROWS.length * CELL_W) / 2, LOG_TOP + next * ROW_H + ROW_H / 2);
  }

  private pickLifelineRow(): void {
    let next: number;
    do { next = Phaser.Math.Between(0, MAX_VISIBLE_ROWS - 1); } while (next === this.bonusRow || next === this.lifelineRow);
    this.lifelineRow = next;
    this.lifelineMultiplier = Phaser.Math.Between(2, 3);
    const x = GRID_LEFT + (ROWS.length * CELL_W) / 2;
    const y = LOG_TOP + next * ROW_H + ROW_H / 2;
    this.lifelineHighlight.setPosition(x, y);
    this.lifelineLabel.setText(`${this.lifelineMultiplier}x`).setPosition(x, y);
  }

  private positionBallAtRest(): void {
    this.ballX = GRID_LEFT + (ROWS.length * CELL_W) / 2;
    this.ballY = this.ballRestY;
    this.ball.setPosition(this.ballX, this.ballY);
  }

  private restingYFor(power: number): number {
    return APEX_FLOOR_Y - power * APEX_SPAN;
  }

  private wallY(): number {
    return Math.max(LOG_TOP - ZONKE_BAND * S, HEADER_TOP + BALL_R);
  }

  private onChargeStart(): void {
    if (this.roundOver || this.flying || this.charging || !this.ready) return;
    this.charging = true;
    this.power = 0;
    this.chargeStart = this.time.now;
  }

  private onRelease(): void {
    if (!this.charging) return;
    this.charging = false;
    this.ready = false;
    this.flying = true;
    const target = Math.max(this.ballRestY - this.restingYFor(this.power), 1);
    const distance = target + Math.sqrt(2 * FRICTION * target) / 2;
    this.ballVx = 0;
    this.ballVy = -Math.sqrt(2 * FRICTION * distance);
  }

  update(_time: number, delta: number): void {
    if (!this.roundOver) {
      const elapsed = this.time.now - this.roundStartAt;
      const remaining = Math.max(0, ROUND_MS - elapsed);
      const secs = Math.floor(remaining / 1000);
      this.clockText.setText(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
      if (remaining <= 0) {
        this.endRound();
        return;
      }
    }

    if (this.charging) {
      const held = this.time.now - this.chargeStart;
      this.power = Math.min(POWER_MAX, (held / CHARGE_MS) * POWER_MAX);
      return;
    }
    if (!this.flying) return;

    const steps = Math.min(4, Math.max(1, Math.round(delta / 16.667)));
    for (let i = 0; i < steps && this.flying; i++) this.stepBall();
    this.ball.setPosition(this.ballX, this.ballY);
  }

  private stepBall(): void {
    const speed = Math.hypot(this.ballVx, this.ballVy);
    const slowed = speed - FRICTION;
    if (speed < STOP_SPEED || slowed <= 0) {
      this.settle();
      return;
    }
    const scale = slowed / speed;
    this.ballVx *= scale;
    this.ballVy *= scale;
    this.ballX += this.ballVx;
    this.ballY += this.ballVy;

    const left = GRID_LEFT + BALL_R;
    const right = GRID_LEFT + ROWS.length * CELL_W - BALL_R;
    if (this.ballX < left) { this.ballX = left; this.ballVx = Math.abs(this.ballVx) * WALL_BOUNCE; }
    else if (this.ballX > right) { this.ballX = right; this.ballVx = -Math.abs(this.ballVx) * WALL_BOUNCE; }

    const wall = this.wallY();
    if (this.ballY < wall) {
      this.ballY = wall;
      const s2 = Math.hypot(this.ballVx, this.ballVy) * WALL_BOUNCE;
      const angle = Phaser.Math.FloatBetween(-BOUNCE_SPREAD, BOUNCE_SPREAD);
      this.ballVx = s2 * Math.sin(angle);
      this.ballVy = s2 * Math.cos(angle);
    }
    if (this.ballY > this.ballRestY) { this.ballY = this.ballRestY; this.ballVy = -Math.abs(this.ballVy) * WALL_BOUNCE; }
  }

  private rowSlotUnderBall(): number {
    return Phaser.Math.Clamp(Math.floor((this.ballY - LOG_TOP) / ROW_H), 0, MAX_VISIBLE_ROWS - 1);
  }

  private settle(): void {
    this.flying = false;
    this.ballVx = 0;
    this.ballVy = 0;
    this.ball.setPosition(this.ballX, this.ballY);

    const jackpot = this.ballY < LOG_TOP;
    let points = NORMAL_POINTS;
    let label = 'row';
    if (jackpot) {
      points = ZONKE_POINTS;
      label = 'ZONKE';
      this.pickBonusRow();
      this.pickLifelineRow();
    } else {
      const slot = this.rowSlotUnderBall();
      if (slot === this.bonusRow) {
        points = BONUS_POINTS;
        label = '2x row';
        this.pickBonusRow();
      } else if (slot === this.lifelineRow) {
        points = this.lifelineMultiplier;
        label = `${this.lifelineMultiplier}x row`;
        this.pickLifelineRow();
      }
    }

    if (!this.roundOver) {
      this.score += points;
      this.scoreText.setText(`Score\n${this.score}`);
      this.messageText.setText(`+${points} (${label})  -  Score: ${this.score}`);
      track('time_attack_landing', { points, label });
    }

    this.time.delayedCall(200, () => {
      if (this.roundOver) return;
      this.positionBallAtRest();
      this.ready = true;
    });
  }

  private endRound(): void {
    if (this.roundOver) return;
    this.roundOver = true;
    this.flying = false;
    this.charging = false;
    this.ready = false;
    this.clockText.setText('0:00');
    track('time_attack_finished', { score: this.score });
    this.showResults();
  }

  private async showResults(): Promise<void> {
    const midY = CANVAS_H / 2;
    const panelW = Math.min(560 * S, CANVAS_W * 0.9);
    this.add.rectangle(CENTER_X, midY, panelW, 400 * S, 0x000000, 0.9).setOrigin(0.5).setDepth(2);
    this.add
      .text(CENTER_X, midY - 170 * S, "Time's up!", { fontSize: fs(30), color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5, 0)
      .setDepth(2);
    this.add
      .text(CENTER_X, midY - 120 * S, `Score: ${this.score}`, { fontSize: fs(26), color: '#ffd54f', fontStyle: 'bold' })
      .setOrigin(0.5, 0)
      .setDepth(2);
    const loading = this.add
      .text(CENTER_X, midY - 70 * S, 'Loading leaderboard...', { fontSize: fs(16), color: '#aaaaaa' })
      .setOrigin(0.5, 0)
      .setDepth(2);

    // The session already knows who is playing (asked once, before the first game), so a
    // finished round goes straight onto the board instead of interrupting with a prompt.
    const name = await ensurePlayerName();
    const saved = await submitScore(
      name,
      this.score,
      Math.round(this.time.now - this.roundStartAt),
      'timeattack'
    );

    const top = await fetchTopScores(10, 'timeattack');
    if (!loading.scene) return; // restarted while the requests were in flight
    loading.destroy();
    this.add
      .text(CENTER_X, midY - 92 * S, saved ? `Saved as ${name}` : "Couldn't save your score", {
        fontSize: fs(15),
        color: saved ? '#4caf50' : '#ff8a65',
      })
      .setOrigin(0.5, 0)
      .setDepth(2);
    const listText = top.length
      ? top.map((r: TopScore, i: number) => `${i + 1}. ${r.name} - ${r.score}`).join('\n')
      : 'No scores yet - be the first!';
    this.add
      .text(CENTER_X, midY - 60 * S, listText, {
        fontSize: fs(17),
        color: '#ffffff',
        align: 'center',
        lineSpacing: 6 * S,
      })
      .setOrigin(0.5, 0)
      .setDepth(2);
    this.add
      .text(CENTER_X, midY + 160 * S, 'Tap, or press R, to play again', { fontSize: fs(15), color: '#888888' })
      .setOrigin(0.5, 0)
      .setDepth(2);

    this.input.once('pointerdown', () => this.scene.restart());
  }
}
