// The waiting room, as DOM over the game.
//
// Entering the room is the same act as making yourself available: everyone in here is
// listed to everyone else, and anyone who is free can be challenged. A player's own status
// is always on screen, because "am I waiting, or am I challenging someone?" is the only
// question this screen has to answer.
import { swallowPointerEvents } from '../domOverlay';
import type { LobbyPlayer, OnlineDifficulty, PlayerRep } from './net';

const STYLE = `
.lobby { position: fixed; inset: 0; z-index: 12; display: flex; align-items: center; justify-content: center;
  background: rgba(14,16,19,0.94); padding: 16px; box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; }
.lobby-card { width: min(440px, 100%); max-height: 88vh; overflow-y: auto; box-sizing: border-box;
  background: #1c2025; border: 1px solid #2f353c; border-radius: 14px; padding: 20px; }
.lobby h1 { margin: 0 0 2px; font-size: 20px; color: #ffd54f; letter-spacing: 1px; }
.lobby .you { font-size: 12px; color: #9aa1a9; margin-bottom: 14px; }
.lobby .you b { color: #4caf50; }
.lobby .you .change { color: #ffd54f; text-decoration: underline; cursor: pointer; margin-left: 6px; }
.lobby .status-line { font-size: 13px; color: #ffd54f; margin: 10px 0; min-height: 18px; }
.lobby .levels { margin: 8px 0 12px; }
.lobby .levels span { font-size: 12px; color: #ffb74d; line-height: 1.5; }
.lobby ul { list-style: none; margin: 0; padding: 0; }
.lobby li { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 12px; border: 1px solid #2f353c; border-radius: 9px; margin-bottom: 8px; background: #22272d; }
.lobby li .who { font-size: 14px; }
.lobby li .st { font-size: 11px; color: #8d949c; display: block; margin-top: 2px; }
.lobby button, .lobby-prompt button { font: inherit; font-size: 13px; font-weight: 700; border: 0; border-radius: 7px;
  padding: 9px 14px; background: #ffd54f; color: #14161a; cursor: pointer; white-space: nowrap; }
.lobby button:disabled, .lobby-prompt button:disabled { background: #343a41; color: #7b8189; cursor: default; }
.lobby button.ghost, .lobby-prompt button.ghost { background: #2c333a; color: #dfe3e8; }
.lobby .empty { color: #8d949c; font-size: 13px; padding: 14px 2px; }
.lobby .info { background: #2c333a; color: #cfd3d8; border: 1px solid #3a424b; border-radius: 50%;
  width: 28px; height: 28px; min-width: 28px; padding: 0; font-size: 13px; font-weight: 700; line-height: 1; }
.lobby .info:hover { background: #39424b; color: #fff; }
.lobby .rep { margin-top: 8px; padding: 10px 12px; border: 1px solid #3a424b; border-radius: 8px;
  background: #191d22; font-size: 12px; color: #cfd3d8; line-height: 1.7; }
.lobby .rep b { color: #ffd54f; }
.lobby .rep .none { color: #8d949c; }
.lobby .foot { margin-top: 14px; display: flex; gap: 8px; }
.lobby .foot button { flex: 1; }
.lobby-prompt { position: fixed; inset: 0; z-index: 13; display: flex; align-items: center; justify-content: center;
  background: rgba(10,12,15,0.9); padding: 16px; }
.lobby-prompt .box { width: min(360px, 100%); background: #1c2025; border: 1px solid #3a424b;
  border-radius: 12px; padding: 20px; text-align: center; box-sizing: border-box; }
.lobby-prompt h2 { margin: 0 0 6px; font-size: 17px; }
.lobby-prompt p { margin: 0 0 16px; font-size: 13px; color: #aeb4bb; }
.lobby-prompt .row { display: flex; gap: 8px; }
.lobby-prompt .row button { flex: 1; }
`;

export interface LobbyCallbacks {
  onChangeName(): void;
  /** Looks up one player's record, for the info button beside their name. */
  onRep(name: string): Promise<PlayerRep | null>;
  onChallenge(id: string): void;
  onAccept(): void;
  onDecline(): void;
  onCancel(): void;
  onLeave(): void;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A player's record as a few plain lines - what they have done, not a score. */
function repLines(rep: PlayerRep): Node[] {
  const line = (label: string, value: string, dim = false): HTMLElement => {
    const div = document.createElement('div');
    if (dim) div.className = 'none';
    div.append(`${label} `);
    const b = document.createElement('b');
    b.textContent = value;
    div.append(b);
    return div;
  };

  const out: Node[] = [];
  const { played, won, lost } = rep.online;
  out.push(
    played === 0
      ? line('Online:', 'no matches yet', true)
      : line('Online:', `${won}W ${lost}L of ${played}  (${Math.round((won / played) * 100)}% won)`)
  );
  if (rep.cpu.wins === 0) {
    out.push(line('Vs CPU:', 'no saved wins', true));
  } else {
    // Broken out by difficulty: "three wins" means something different on Easy and Hard.
    const byDifficulty = (rep.cpu.byDifficulty ?? []).filter((d) => d.wins > 0);
    out.push(
      byDifficulty.length
        ? line('Vs CPU:', byDifficulty.map((d) => `${d.difficulty} ${d.wins}x (best ${clock(d.fastestMs)})`).join(', '))
        : line('Vs CPU:', `${rep.cpu.wins} win${rep.cpu.wins === 1 ? '' : 's'}, fastest ${clock(rep.cpu.fastestMs ?? 0)}`)
    );
  }
  out.push(
    rep.timeAttack.best !== null
      ? line('Time Attack:', `${rep.timeAttack.best} points`)
      : line('Time Attack:', 'never played', true)
  );

  // How often they actually land the jackpot, over every shot they have ever taken.
  const z = rep.zonke;
  if (!z || z.rate === null) {
    out.push(line('ZONKE rate:', 'no shots recorded yet', true));
  } else {
    out.push(line('ZONKE rate:', `${(z.rate * 100).toFixed(1)}% - ${z.hits} of ${z.shots} shots`));
    const perDifficulty = (z.byDifficulty ?? []).filter((d) => d.shots >= 5);
    if (perDifficulty.length) {
      out.push(
        line('  by mode:', perDifficulty.map((d) => `${d.difficulty} ${(d.rate * 100).toFixed(0)}%`).join(', '))
      );
    }
  }
  return out;
}

const STATUS_TEXT: Record<LobbyPlayer['status'], string> = {
  waiting: 'waiting - can be challenged',
  challenging: 'challenging someone',
  challenged: 'deciding on a challenge',
  playing: 'in a match',
};

export class LobbyUi {
  private readonly root = document.createElement('div');
  private readonly list = document.createElement('ul');
  private readonly statusLine = document.createElement('div');
  private readonly youLine = document.createElement('div');
  private prompt: HTMLElement | null = null;
  private visible = false;
  private levels!: HTMLElement;
  /** Every challenge is played at Hard - see the server for why. */
  readonly difficulty: OnlineDifficulty = 'Hard';

  constructor(private readonly callbacks: LobbyCallbacks) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root.className = 'lobby';
    swallowPointerEvents(this.root);
    const card = document.createElement('div');
    card.className = 'lobby-card';

    const title = document.createElement('h1');
    title.textContent = 'WAITING ROOM';
    this.youLine.className = 'you';
    this.statusLine.className = 'status-line';

    // Challenges are played at Hard - not a choice, but worth saying out loud.
    const levels = document.createElement('div');
    levels.className = 'levels';
    const levelLabel = document.createElement('span');
    levelLabel.textContent = 'Challenges are played at HARD - same board, same rows, no easy ZONKE.';
    levels.appendChild(levelLabel);
    this.levels = levels;

    const foot = document.createElement('div');
    foot.className = 'foot';
    const leave = document.createElement('button');
    leave.className = 'ghost';
    leave.textContent = 'Back to the CPU game';
    leave.addEventListener('click', () => this.callbacks.onLeave());
    foot.appendChild(leave);

    card.append(title, this.youLine, this.statusLine, this.levels, this.list, foot);
    this.root.appendChild(card);
  }

  show(): void {
    if (this.visible) return;
    document.body.appendChild(this.root);
    this.visible = true;
  }

  hide(): void {
    if (!this.visible) return;
    this.root.remove();
    this.visible = false;
    this.closePrompt();
  }

  setStatus(text: string): void {
    this.statusLine.textContent = text;
  }

  /** Redraws the room. Everyone here is listed; only the free ones can be challenged. */
  render(you: LobbyPlayer, players: LobbyPlayer[]): void {
    this.youLine.innerHTML = '';
    this.youLine.append('You are ');
    const name = document.createElement('b');
    name.textContent = you.name;
    this.youLine.append(name, ` - ${STATUS_TEXT[you.status]}`);
    // Only while free: changing a name means rejoining the room under the new one.
    if (you.status === 'waiting') {
      const change = document.createElement('span');
      change.className = 'change';
      change.textContent = 'change';
      change.addEventListener('click', () => this.callbacks.onChangeName());
      this.youLine.append(change);
    }

    this.list.innerHTML = '';
    if (players.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Nobody else is here yet. Anyone who joins will see you waiting.';
      this.list.appendChild(empty);
      return;
    }

    players.forEach((player) => {
      const row = document.createElement('li');
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = player.name;
      const st = document.createElement('span');
      st.className = 'st';
      st.textContent = STATUS_TEXT[player.status];
      who.appendChild(st);

      const button = document.createElement('button');
      if (you.status === 'challenging' && player.status === 'challenged') {
        button.textContent = 'Cancel';
        button.className = 'ghost';
        button.addEventListener('click', () => this.callbacks.onCancel());
      } else {
        button.textContent = 'Challenge';
        button.disabled = player.status !== 'waiting' || you.status !== 'waiting';
        button.addEventListener('click', () => this.callbacks.onChallenge(player.id));
        button.title = `Challenge ${player.name} at ${this.difficulty}`;
      }

      // Their record, on the far right - so you can see who you are taking on.
      const info = document.createElement('button');
      info.className = 'info';
      info.textContent = 'i';
      info.title = `${player.name}'s record`;
      info.setAttribute('aria-label', `${player.name}'s record`);
      info.addEventListener('click', () => this.toggleRep(row, player.name));

      row.append(who, button, info);
      this.list.appendChild(row);
    });
  }

  /**
   * Opens (or closes) one player's record under their row. Kept inline rather than in a
   * dialog: you are comparing people, so being able to open two at once is the point.
   */
  private async toggleRep(row: HTMLElement, name: string): Promise<void> {
    const existing = row.querySelector('.rep');
    if (existing) {
      existing.remove();
      row.style.display = 'flex';
      return;
    }
    const panel = document.createElement('div');
    panel.className = 'rep';
    panel.textContent = 'Looking up...';
    // The row is a flex line; a record underneath it needs the row to wrap around both.
    row.style.display = 'block';
    row.appendChild(panel);

    const rep = await this.callbacks.onRep(name);
    if (!panel.isConnected) return;
    panel.innerHTML = '';
    if (!rep) {
      panel.textContent = 'Could not load that record.';
      return;
    }
    panel.append(...repLines(rep));
  }

  /** The other half of a challenge: someone has picked you. */
  showChallenge(from: { name: string }, difficulty: OnlineDifficulty = 'Moderate'): void {
    this.closePrompt();
    const prompt = document.createElement('div');
    prompt.className = 'lobby-prompt';
    swallowPointerEvents(prompt);
    const box = document.createElement('div');
    box.className = 'box';
    const h2 = document.createElement('h2');
    h2.textContent = `${from.name} challenges you`;
    const p = document.createElement('p');
    p.textContent = `At ${difficulty}. First to a lead the remaining rows cannot close wins - they shoot first.`;
    const row = document.createElement('div');
    row.className = 'row';
    const accept = document.createElement('button');
    accept.textContent = 'Accept';
    accept.addEventListener('click', () => {
      this.closePrompt();
      this.callbacks.onAccept();
    });
    const decline = document.createElement('button');
    decline.className = 'ghost';
    decline.textContent = 'Decline';
    decline.addEventListener('click', () => {
      this.closePrompt();
      this.callbacks.onDecline();
    });
    row.append(accept, decline);
    box.append(h2, p, row);
    prompt.appendChild(box);
    document.body.appendChild(prompt);
    this.prompt = prompt;
  }

  closePrompt(): void {
    this.prompt?.remove();
    this.prompt = null;
  }
}
