// Everything the 3D game says in words, as DOM over the canvas.
//
// Text stays out of the 3D scene on purpose: a tilted plane makes small type harder to
// read, and this game is half scoreboard - the clock, the kills and the turn message are
// read constantly. DOM also gets crisp text, real buttons and a working keyboard for free.
import { submitScore, fetchTopScores } from '../analytics';
import { swallowPointerEvents } from '../domOverlay';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const STYLE = `
.hud { position: fixed; inset: 0; pointer-events: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; }
.hud-top { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: flex-start; justify-content: space-between; padding: 10px 14px 22px; gap: 10px; box-sizing: border-box; background: linear-gradient(to bottom, rgba(12,14,17,0.9) 45%, rgba(12,14,17,0)); }
.hud-name { font-size: 15px; font-weight: 700; line-height: 1.5; }
.hud-name small { display: block; font-size: 12px; font-weight: 400; color: #ffd54f; }
.hud-p1 { color: #4caf50; text-align: left; }
.hud-p2 { color: #2196f3; text-align: right; }
.hud-clock { font-size: 19px; font-weight: 700; letter-spacing: 1px; text-align: center; }
.hud-split { font-size: 12px; color: #00e676; font-weight: 700; min-height: 15px; }
.hud-bottom { position: absolute; left: 0; right: 0; bottom: 0; padding: 26px 16px 18px; text-align: center; box-sizing: border-box; background: linear-gradient(to top, rgba(12,14,17,0.92) 55%, rgba(12,14,17,0)); }
.hud-turn { font-size: 16px; font-weight: 700; }
.hud-msg { font-size: 13px; color: #cfd3d8; margin-top: 5px; line-height: 1.45; min-height: 34px; }
.hud-hint { font-size: 11px; color: #7b8189; margin-top: 4px; }
.hud-panel { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; background: rgba(12,14,17,0.82); pointer-events: auto; }
.hud-card { width: min(420px, 100%); box-sizing: border-box; background: #1c2025; border: 1px solid #2f353c; border-radius: 14px; padding: 22px 20px; text-align: center; }
.hud-card h1 { margin: 0 0 4px; font-size: 26px; color: #ffd54f; letter-spacing: 2px; }
.hud-card p { margin: 6px 0 16px; font-size: 13px; color: #aeb4bb; line-height: 1.5; }
.hud-btn { display: block; width: 100%; box-sizing: border-box; margin: 8px 0 0; padding: 13px; font: inherit; font-size: 15px; font-weight: 700; border: 1px solid #3a424b; border-radius: 9px; background: #262c33; color: #fff; cursor: pointer; }
.hud-btn:hover { background: #2f3740; }
.hud-btn.primary { background: #ffd54f; border-color: #ffd54f; color: #14161a; }
.hud-btn.green { background: #2e7d46; border-color: #2e7d46; }
.hud-win { font-size: clamp(30px, 11vw, 74px); font-weight: 800; letter-spacing: 2px; margin: 0 0 6px; line-height: 1.05; }
.hud-stats { font-size: 16px; font-weight: 700; margin: 10px 0 2px; }
.hud-board { font-size: 12px; color: #cfd3d8; white-space: pre-line; margin-top: 12px; line-height: 1.6; }
`;

/** The ten quickest wins, as a block of text both panels can drop straight in. */
export async function fastestWinsBoard(limit = 10): Promise<string> {
  const top = await fetchTopScores(limit, 'zonke', 'fastest');
  if (top.length === 0) return 'No wins saved yet - be the first!';
  return [
    `Fastest wins (top ${limit})`,
    ...top.map((r, i) => `${i + 1}. ${r.name}  -  ${formatClock(r.durationMs)}  (${r.score} kills)`),
  ].join('\n');
}

export interface HudCallbacks {
  onPickMode(index: number): void;
  onPlayAgain(): void;
  onSaveScore(): Promise<{ ok: boolean; kills: number; durationMs: number; name: string }>;
}

export class Hud {
  private readonly root = el('div', 'hud');
  private readonly p1 = el('div', 'hud-name hud-p1');
  private readonly p2 = el('div', 'hud-name hud-p2');
  private readonly clock = el('div', 'hud-clock', 'Time  0:00');
  private readonly splitNote = el('div', 'hud-split');
  private readonly turn = el('div', 'hud-turn');
  private readonly message = el('div', 'hud-msg');
  private panel: HTMLElement | null = null;

  constructor(private readonly callbacks: HudCallbacks) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const top = el('div', 'hud-top');
    const middle = el('div', '');
    middle.append(this.clock, this.splitNote);
    top.append(this.p1, middle, this.p2);

    const bottom = el('div', 'hud-bottom');
    bottom.append(this.turn, this.message, el('div', 'hud-hint', 'Hold anywhere to charge, release to launch'));

    this.root.append(top, bottom);
    document.body.appendChild(this.root);
  }

  setPlayers(p1Name: string, p1Kills: number, p2Kills: number): void {
    this.p1.innerHTML = '';
    this.p1.append(p1Name, Object.assign(el('small', ''), { textContent: `Kills ${p1Kills}` }));
    this.p2.innerHTML = '';
    this.p2.append('CPU', Object.assign(el('small', ''), { textContent: `Kills ${p2Kills}` }));
  }

  setClock(ms: number): void {
    this.clock.textContent = `Time  ${formatClock(ms)}`;
  }

  setSplitCountdown(secondsLeft: number): void {
    this.splitNote.textContent = secondsLeft > 0 ? `GREEN SPLIT ROW - ${secondsLeft}s` : '';
  }

  setTurn(text: string, colour: string): void {
    this.turn.textContent = text;
    this.turn.style.color = colour;
  }

  setMessage(text: string): void {
    this.message.textContent = text;
  }

  private openPanel(build: (card: HTMLElement) => void): HTMLElement {
    this.closePanel();
    const panel = el('div', 'hud-panel');
    swallowPointerEvents(panel);
    const card = el('div', 'hud-card');
    build(card);
    panel.appendChild(card);
    document.body.appendChild(panel);
    this.panel = panel;
    return card;
  }

  closePanel(): void {
    this.panel?.remove();
    this.panel = null;
  }

  showModePicker(modeNames: string[]): void {
    this.openPanel((card) => {
      card.append(
        Object.assign(el('h1', ''), { textContent: 'ZONKE 3D' }),
        Object.assign(el('p', ''), {
          textContent:
            'Land on a row to build its figure. Once it holds a gun, each landing steps its bullet a letter - past H it fires. Gold row doubles a landing, orange is a lifeline for whoever is behind, and once a game a green row may open for 15 seconds: land on it and your ball splits into 2-5.',
        })
      );
      modeNames.forEach((name, i) => {
        const btn = el('button', i === 0 ? 'hud-btn primary' : 'hud-btn', `${i + 1}   ${name}`);
        btn.addEventListener('click', () => this.callbacks.onPickMode(i));
        card.appendChild(btn);
      });
      // The time to beat, shown before the match rather than only after it.
      const board = el('div', 'hud-board', 'Loading fastest wins...');
      card.appendChild(board);
      void fastestWinsBoard().then((text) => {
        if (board.isConnected) board.textContent = text;
      });
    });
  }

  showWin(winnerName: string, playerWon: boolean, reason: string, kills: [number, number], durationMs: number): void {
    this.openPanel((card) => {
      const title = el('div', 'hud-win', `${winnerName.toUpperCase()} WINS!`);
      title.style.color = playerWon ? '#ffd54f' : '#ff8a65';
      const stats = el('div', 'hud-stats', `Kills  ${kills[0]} - ${kills[1]}      Time  ${formatClock(durationMs)}`);
      const board = el('div', 'hud-board');
      // Only a win can go on a fastest-wins board, so a loss is not offered the button.
      const save = playerWon
        ? el('button', 'hud-btn green', `Save my score - ${kills[0]} kills in ${formatClock(durationMs)}`)
        : null;
      const again = el('button', 'hud-btn', 'Play again');
      if (!save) void fastestWinsBoard().then((text) => { if (board.isConnected) board.textContent = text; });

      let saving = false;
      save?.addEventListener('click', async () => {
        if (saving) return;
        saving = true;
        save.textContent = 'Saving...';
        const result = await this.callbacks.onSaveScore();
        if (!result.ok) {
          save.textContent = 'Save failed - tap to try again';
          saving = false;
          return;
        }
        save.textContent = 'Score saved';
        save.disabled = true;
        board.textContent = 'Loading leaderboard...';
        board.textContent = await fastestWinsBoard();
      });
      again.addEventListener('click', () => this.callbacks.onPlayAgain());

      card.append(title, Object.assign(el('p', ''), { textContent: reason }), stats);
      if (save) card.append(save);
      card.append(again, board);
    });
  }
}

/** Submits a finished Zonke match to the shared leaderboard. */
export async function saveZonkeScore(
  name: string,
  kills: number,
  durationMs: number,
  won: boolean
): Promise<boolean> {
  return submitScore({
    name,
    score: kills,
    durationMs: Math.max(1000, Math.round(durationMs)),
    mode: 'zonke',
    won,
  });
}
