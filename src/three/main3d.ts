// Boot for the 3D game: the session's name, a difficulty, then a Match driving a BoardView
// with a DOM HUD over it. The engine owns the rules and the physics, this file owns only
// the wiring - input in, frames out.
import { Match, MODES, type EngineMode, type GameOverInfo } from '../zonke/Match';
import { BoardView } from './BoardView';
import { Hud, saveZonkeScore } from './Hud';
import { ensurePlayerName, storedPlayerName } from '../player';
import { track } from '../analytics';

const P1_COLOR = '#4caf50';
const P2_COLOR = '#2196f3';

export async function start3D(): Promise<void> {
  const app = document.getElementById('app') ?? document.body;
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  app.appendChild(canvas);

  const playerName = storedPlayerName() ?? (await ensurePlayerName());

  let match: Match | null = null;
  let view: BoardView | null = null;
  let mode: EngineMode | null = null;

  const hud = new Hud({
    onPickMode: (index) => startMatch(MODES[index]),
    onPlayAgain: () => {
      if (mode) startMatch(mode);
    },
    onSaveScore: async () => {
      const m = match;
      if (!m) return { ok: false, kills: 0, durationMs: 0, name: playerName };
      const kills = m.players[0].kills;
      const durationMs = m.durationMs;
      const ok = await saveZonkeScore(playerName, kills, durationMs, lastResult?.winnerIndex === 0);
      if (ok) track('score_saved', { mode: m.mode.name, kills, durationMs, renderer: '3d' });
      return { ok, kills, durationMs, name: playerName };
    },
  });

  let lastResult: GameOverInfo | null = null;

  function startMatch(chosen: EngineMode): void {
    mode = chosen;
    lastResult = null;
    hud.closePanel();
    track('mode_selected', { mode: chosen.name, renderer: '3d' });

    match = new Match(chosen, playerName, {
      onMessage: (text) => hud.setMessage(text),
      onTurn: (active) => {
        const m = match!;
        hud.setTurn(`${m.players[active].name}'s turn`, active === 0 ? P1_COLOR : P2_COLOR);
        hud.setPlayers(playerName, m.players[0].kills, m.players[1].kills);
      },
      onSplit: (count, slot) => {
        view?.flashSplitRow(slot, performance.now());
        track('split_row_hit', { balls: count, mode: chosen.name, renderer: '3d' });
      },
      onBoardChanged: () => {
        view?.syncBoard();
        const m = match!;
        hud.setPlayers(playerName, m.players[0].kills, m.players[1].kills);
      },
      onSpecialRowsChanged: () => view?.syncSpecialRows(),
      onGameOver: (info) => {
        lastResult = info;
        const winnerName = info.winnerIndex === 0 ? playerName : 'CPU';
        view?.celebrate(info.winnerIndex === 0);
        hud.setTurn('', '#fff');
        hud.showWin(winnerName, info.winnerIndex === 0, info.reason, info.kills, info.durationMs);
        track('game_over', {
          mode: chosen.name,
          result: info.winnerIndex === 0 ? 'p1_win' : 'cpu_win',
          p1Kills: info.kills[0],
          cpuKills: info.kills[1],
          durationMs: Math.round(info.durationMs),
          renderer: '3d',
        });
      },
    });

    view?.dispose();
    view = new BoardView(canvas, match);
    fit();
    hud.setPlayers(playerName, 0, 0);
    hud.setTurn(`${playerName}'s turn`, P1_COLOR);
    hud.setMessage('Hold to charge, release to launch');
  }

  function fit(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    view?.resize(w, h);
  }

  // A resize only re-frames the camera here - unlike the 2D board, whose whole layout was
  // derived from pixel size, nothing about the match depends on the window, so rotating a
  // phone no longer has to restart the round.
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);

  const charge = (): void => match?.startCharge();
  const release = (): void => match?.release();
  canvas.addEventListener('pointerdown', charge);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) charge();
    if (!match && /^Digit[123]$/.test(e.code)) startMatch(MODES[Number(e.code.slice(5)) - 1]);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') release();
  });

  hud.showModePicker(MODES.map((m) => m.name));

  // Same dev-only handle as the Phaser build, for the browser-driven checks in scripts/.
  // Dropped from production by import.meta.env.DEV.
  if (import.meta.env.DEV) {
    (window as Window & { zonke3D?: unknown }).zonke3D = {
      get match() {
        return match;
      },
      get view() {
        return view;
      },
      startMatch,
      modes: MODES,
    };
  }

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = now - last;
    last = now;
    if (match && view) {
      match.update(dt);
      hud.setClock(match.durationMs);
      hud.setSplitCountdown(match.splitSecondsLeft);
      view.render(now);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
