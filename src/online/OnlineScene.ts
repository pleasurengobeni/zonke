// The board for an online match.
//
// The rules and the physics are the shared engine's (src/zonke/Match.ts); this scene only
// draws it and takes the input. Both players run their own copy of that engine from the
// same seed and feed it the same shots in the same order, so the two boards stay identical
// without any board state ever crossing the network - see the note on Rng in Match.ts.
//
// The layout deliberately reuses the local game's design numbers, so an online board looks
// like the board people already know.
import Phaser from 'phaser';
import { BOARD_W, MODES, Match, seededRng, type Ball } from '../zonke/Match';
import { BOARD_ROWS, FIGURE_PARTS, ROWS as LETTERS } from '../zonke/GameState';
import type { MatchStart } from './net';

const DESIGN_W = 1500;
const DESIGN_H = 1160;
const DESIGN_GRID_W = 1056;
const BOARD_SHRINK = 0.92;
const P1 = '#4caf50';
const P2 = '#2196f3';
const P1_HEX = 0x4caf50;
const P2_HEX = 0x2196f3;

export interface OnlineSceneData {
  match: MatchStart;
  youName: string;
  onShoot(power: number): void;
  onLeave(): void;
}

export class OnlineScene extends Phaser.Scene {
  private engine!: Match;
  private opts!: OnlineSceneData;

  private s = 1;
  private gridLeft = 0;
  private cellW = 0;
  private rowH = 0;
  private logTop = 0;
  private tableBottom = 0;
  private figureX: [number, number] = [0, 0];
  private figureScale = 1;

  private boardGfx!: Phaser.GameObjects.Graphics;
  private actorGfx!: Phaser.GameObjects.Graphics;
  private clockText!: Phaser.GameObjects.Text;
  private turnText!: Phaser.GameObjects.Text;
  private messageText!: Phaser.GameObjects.Text;
  private nameTexts: [Phaser.GameObjects.Text, Phaser.GameObjects.Text] = [null as never, null as never];
  private endPanel: Phaser.GameObjects.GameObject[] = [];

  private charging = false;
  private chargeStart = 0;

  constructor() {
    super('OnlineScene');
  }

  init(data: OnlineSceneData): void {
    this.opts = data;
  }

  create(): void {
    this.computeLayout(this.scale.width, this.scale.height);

    const you = this.opts.youName;
    const them = this.opts.match.opponent.name;
    // Index 0 is the challenger on BOTH screens, so the engines agree on who is who.
    const names: [string, string] = this.opts.match.youIndex === 0 ? [you, them] : [them, you];

    this.engine = new Match(MODES[1], names[0], {
      onMessage: (text) => this.messageText.setText(text),
      onTurn: () => this.refreshTurn(),
      onBoardChanged: () => this.refreshNames(),
      onGameOver: (info) => this.showResult(info.winnerIndex, info.reason, info.kills, info.durationMs),
    }, {
      rng: seededRng(this.opts.match.seed),
      opponentName: names[1],
      cpu: false, // the other side is a person, and their shots arrive over the wire
      splitWindowTurns: 6, // both browsers count turns the same way; clocks they do not
    });

    this.boardGfx = this.add.graphics();
    this.actorGfx = this.add.graphics();
    this.drawBoardChrome();

    this.clockText = this.add
      .text(this.centreX(), 8 * this.s, 'Time  0:00', { fontSize: this.fs(26), color: '#e0e0e0', fontStyle: 'bold' })
      .setOrigin(0.5, 0);
    this.nameTexts = [
      this.add.text(this.figureX[0], 6 * this.s, names[0], { fontSize: this.fs(24), color: P1 }).setOrigin(0.5, 0),
      this.add.text(this.figureX[1], 6 * this.s, names[1], { fontSize: this.fs(24), color: P2 }).setOrigin(0.5, 0),
    ];
    const turnY = this.tableBottom + 68 * this.s;
    this.turnText = this.add.text(this.centreX(), turnY, '', { fontSize: this.fs(24), color: P1 }).setOrigin(0.5, 0);
    this.messageText = this.add
      .text(this.centreX(), turnY + 32 * this.s, 'Hold to charge, release to launch', {
        fontSize: this.fs(20),
        color: '#cccccc',
        align: 'center',
        wordWrap: { width: this.scale.width * 0.92 },
      })
      .setOrigin(0.5, 0);

    this.input.on('pointerdown', () => this.startCharge());
    this.input.on('pointerup', () => this.release());
    this.input.on('pointerupoutside', () => this.release());
    this.input.keyboard?.on('keydown-SPACE', () => this.startCharge());
    this.input.keyboard?.on('keyup-SPACE', () => this.release());

    this.refreshTurn();
    this.refreshNames();
  }

  /** Whether it is this player's turn to shoot. */
  private get myTurn(): boolean {
    return this.engine.activeIndex === this.opts.match.youIndex;
  }

  private startCharge(): void {
    if (this.charging || !this.myTurn || !this.engine.canShoot) return;
    this.charging = true;
    this.chargeStart = this.time.now;
    this.messageText.setText('Charging - release to launch');
  }

  /**
   * The shot is sent, not fired. Both engines apply it when the server echoes it back, so
   * they consume their shared random stream in exactly the same order - firing locally
   * first and echoing later would put this board one step ahead of the opponent's.
   */
  private release(): void {
    if (!this.charging) return;
    this.charging = false;
    const held = this.time.now - this.chargeStart;
    const power = this.engine.powerForHold(held);
    this.opts.onShoot(power);
    this.messageText.setText('Shot away...');
  }

  /** A shot from either player, as relayed by the server. */
  applyShot(power: number): void {
    this.engine.fireShot(power);
  }

  opponentLeft(): void {
    this.messageText.setText('Your opponent left the match.');
    this.showEndPanel('Opponent left', 'They disconnected, so the match is over.');
  }

  update(_time: number, delta: number): void {
    this.engine.update(delta);
    this.clockText.setText(`Time  ${this.formatClock(this.engine.durationMs)}`);
    this.drawActors();
  }

  // ---- drawing ---------------------------------------------------------------------

  private fs(n: number): string {
    return `${Math.max(1, Math.round(n * this.s))}px`;
  }

  private centreX(): number {
    return this.scale.width / 2;
  }

  private computeLayout(width: number, height: number): void {
    this.s = height / DESIGN_H;
    this.cellW = (width * (DESIGN_GRID_W / DESIGN_W)) / LETTERS.length;
    this.gridLeft = width / 2 - (LETTERS.length * this.cellW) / 2;
    this.rowH = 88 * this.s * BOARD_SHRINK;
    this.logTop = 46 * this.s + 110 * this.s * BOARD_SHRINK;
    this.tableBottom = this.logTop + BOARD_ROWS * this.rowH;
    const gridRight = this.gridLeft + LETTERS.length * this.cellW;
    this.figureX = [this.gridLeft / 2, (gridRight + width) / 2];
    const margin = Math.min(this.gridLeft, width - gridRight);
    this.figureScale = Math.min(2.2 * this.s * BOARD_SHRINK, (margin / 2 - 6 * this.s) / 21);
  }

  private drawBoardChrome(): void {
    const g = this.boardGfx;
    const width = LETTERS.length * this.cellW;
    const top = 46 * this.s;
    g.lineStyle(2, 0xffffff, 1);
    g.strokeRect(this.gridLeft, top, width, this.tableBottom - top);
    g.lineBetween(this.gridLeft, this.logTop, this.gridLeft + width, this.logTop);
    for (let r = 1; r < BOARD_ROWS; r++) {
      const y = this.logTop + r * this.rowH;
      g.lineBetween(this.gridLeft, y, this.gridLeft + width, y);
    }
    for (let r = 0; r < BOARD_ROWS; r++) {
      this.add
        .text(this.gridLeft - 20 * this.s, this.logTop + r * this.rowH + this.rowH / 2, String(BOARD_ROWS - r), {
          fontSize: this.fs(20),
          color: '#777777',
        })
        .setOrigin(1, 0.5);
    }
    this.add
      .text(this.gridLeft + width / 2, top + 8 * this.s, 'ZONKE', {
        fontSize: this.fs(42),
        color: '#ffd54f',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0);
    LETTERS.forEach((letter, i) => {
      this.add
        .text(this.gridLeft + i * this.cellW + this.cellW / 2, top + 64 * this.s, letter, {
          fontSize: this.fs(30),
          color: i === LETTERS.length - 1 ? '#ff5252' : '#ffffff',
          fontStyle: 'bold',
        })
        .setOrigin(0.5, 0);
    });
  }

  /** Board coordinates to pixels - the engine's x runs across BOARD_W row-units. */
  private px(x: number): number {
    return this.gridLeft + (x / BOARD_W) * LETTERS.length * this.cellW;
  }

  private py(y: number): number {
    return this.logTop + y * this.rowH;
  }

  private drawActors(): void {
    const g = this.actorGfx;
    g.clear();
    const width = LETTERS.length * this.cellW;

    // The three special rows, as washes behind everything else.
    const wash = (row: number | null, colour: number, alpha: number): void => {
      if (row === null) return;
      g.fillStyle(colour, alpha);
      g.fillRect(this.gridLeft, this.py(row), width, this.rowH);
    };
    const pulse = 0.12 + 0.12 * Math.sin(this.time.now / 320);
    wash(this.engine.bonusRow, 0xffd54f, pulse);
    wash(this.engine.lifelineRow, 0xff9800, pulse);
    wash(this.engine.splitRow, 0x00e676, pulse + 0.1);

    // Bullet dashes, laid from each player's own side.
    this.engine.rowBullets.forEach((row, slot) =>
      row.forEach((steps, side) => {
        if (steps === 0) return;
        const y = this.py(slot) + (side === 0 ? this.rowH * 0.25 : this.rowH * 0.75);
        g.lineStyle(3, side === 0 ? P1_HEX : P2_HEX, 0.95);
        for (let i = 0; i < steps; i++) {
          const col = side === 0 ? i : LETTERS.length - 1 - i;
          const cx = this.gridLeft + col * this.cellW + this.cellW / 2;
          g.lineBetween(cx - this.cellW * 0.21, y, cx + this.cellW * 0.21, y);
        }
      })
    );

    // Figures, one per row per side, and a cross over any row that has been taken.
    this.engine.rowFigureParts.forEach((row, slot) =>
      row.forEach((count, side) => {
        const y = this.py(slot) + this.rowH / 2;
        if (count > 0) this.drawFigure(g, this.figureX[side], y, count, side as 0 | 1);
        if (this.engine.players[side].deadRows[slot]) {
          const r = 13 * this.figureScale;
          g.lineStyle(3, 0xff5252, 0.95);
          g.lineBetween(this.figureX[side] - r, y - r, this.figureX[side] + r, y + r);
          g.lineBetween(this.figureX[side] + r, y - r, this.figureX[side] - r, y + r);
        }
      })
    );

    this.engine.balls.forEach((ball: Ball) => {
      const r = Math.min(0.148 * this.rowH, this.cellW * 0.4);
      g.fillStyle(ball.fromSplit ? 0x00e676 : 0xffd54f, 1);
      g.fillCircle(this.px(ball.x), this.py(ball.y), ball.fromSplit ? r * 0.78 : r);
    });
  }

  /** The same figure the local game draws, from the same design offsets. */
  private drawFigure(g: Phaser.GameObjects.Graphics, x: number, y: number, count: number, side: 0 | 1): void {
    const v = this.figureScale;
    const m = (side === 0 ? 1 : -1) * v;
    const colour = side === 0 ? P1_HEX : P2_HEX;
    const has = (part: (typeof FIGURE_PARTS)[number]): boolean => FIGURE_PARTS.indexOf(part) < count;
    g.lineStyle(Math.max(1.5, 2.4 * v), colour, 1);
    g.fillStyle(colour, 1);
    if (has('spine')) g.fillRoundedRect(x - 2.6 * v, y - 7 * v, 5.2 * v, 15 * v, 1.6 * v);
    if (has('head')) g.fillCircle(x, y - 13 * v, 5.2 * v);
    if (has('leftArm')) g.lineBetween(x - 1.6 * v, y - 5 * v, x - 9 * m, y + 4 * v);
    if (has('rightArm')) g.lineBetween(x + 1.6 * v, y - 5 * v, x + 10 * m, y - 5 * v);
    if (has('leftLeg')) g.lineBetween(x - 1.6 * v, y + 8 * v, x - 8 * m, y + 19 * v);
    if (has('rightLeg')) g.lineBetween(x + 1.6 * v, y + 8 * v, x + 8 * m, y + 19 * v);
    if (has('gun')) {
      const hx = x + 10 * m;
      const hy = y - 5 * v;
      g.fillStyle(0xe4e4e4, 1);
      g.fillRect(hx, hy - 1.7 * v, 13 * m, 3.4 * v);
      g.fillRect(hx - 1 * m, hy - 0.4 * v, 3 * m, 6.4 * v);
      g.fillStyle(colour, 1);
    }
  }

  private refreshTurn(): void {
    const mine = this.myTurn;
    const name = this.engine.players[this.engine.activeIndex].name;
    this.turnText.setText(mine ? 'Your turn' : `${name}'s turn`);
    this.turnText.setColor(this.engine.activeIndex === 0 ? P1 : P2);
    if (!mine) this.messageText.setText(`Waiting for ${name}...`);
  }

  private refreshNames(): void {
    this.nameTexts.forEach((text, i) => {
      const player = this.engine.players[i];
      text.setText(`${player.name}  ${player.kills}`);
    });
  }

  private formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  private showResult(winnerIndex: 0 | 1, reason: string, kills: [number, number], durationMs: number): void {
    const won = winnerIndex === this.opts.match.youIndex;
    const winner = this.engine.players[winnerIndex].name;
    this.showEndPanel(
      `${winner.toUpperCase()} WINS!`,
      `${reason}   Kills ${kills[0]} - ${kills[1]}   Time ${this.formatClock(durationMs)}`,
      won
    );
  }

  private showEndPanel(title: string, subtitle: string, won = false): void {
    if (this.endPanel.length) return;
    const w = this.scale.width;
    const h = this.scale.height;
    const veil = this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.86).setDepth(20).setInteractive();
    const heading = this.add
      .text(w / 2, h * 0.34, title, {
        fontSize: this.fs(64),
        color: won ? '#ffd54f' : '#ff8a65',
        fontStyle: 'bold',
        align: 'center',
        wordWrap: { width: w * 0.9 },
      })
      .setOrigin(0.5)
      .setDepth(21);
    const sub = this.add
      .text(w / 2, h * 0.47, subtitle, {
        fontSize: this.fs(20),
        color: '#dddddd',
        align: 'center',
        wordWrap: { width: w * 0.9 },
      })
      .setOrigin(0.5)
      .setDepth(21);
    const btn = this.add
      .rectangle(w / 2, h * 0.6, Math.min(360 * this.s, w * 0.8), 52 * this.s, 0xffd54f, 0.18)
      .setStrokeStyle(1, 0xffd54f, 0.85)
      .setDepth(21)
      .setInteractive({ useHandCursor: true });
    const btnText = this.add
      .text(w / 2, h * 0.6, 'Back to the waiting room', { fontSize: this.fs(22), color: '#ffffff' })
      .setOrigin(0.5)
      .setDepth(22);
    btn.on('pointerdown', (_p: unknown, _x: unknown, _y: unknown, event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      this.opts.onLeave();
    });
    this.endPanel = [veil, heading, sub, btn, btnText];
  }
}
