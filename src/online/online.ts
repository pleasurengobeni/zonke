// Ties the three pieces together: the socket, the waiting room, and a board for whatever
// match comes out of it. Everything stateful lives in one of those three - this file only
// routes events between them.
import type Phaser from 'phaser';
import { Net, fetchRep, type LobbyPlayer, type MatchStart } from './net';
import { LobbyUi } from './lobbyUi';
import { OnlineScene } from './OnlineScene';
import { ensurePlayerName, changePlayerName } from '../player';
import { track } from '../analytics';

export class OnlineGame {
  private readonly net: Net;
  private readonly ui: LobbyUi;
  private scene: OnlineScene | null = null;
  private name = '';
  private connected = false;

  constructor(private readonly game: Phaser.Game) {
    this.ui = new LobbyUi({
      // The server knows players by the name they joined under, so a change means leaving
      // the room and coming back in as the new one.
      onChangeName: () => {
        void changePlayerName().then((name) => {
          if (name === this.name) return;
          this.name = name;
          this.ui.setStatus('Rejoining as ' + name + '...');
          this.net.close();
          this.connected = true;
          this.net.connect(name);
        });
      },
      onRep: (name) => fetchRep(name),
      onChallenge: (id) => {
        this.net.challenge(id);
        this.ui.setStatus('Challenge sent - waiting for an answer.');
      },
      onAccept: () => this.net.accept(),
      onDecline: () => this.net.decline(),
      onCancel: () => {
        this.net.cancel();
        this.ui.setStatus('Challenge withdrawn.');
      },
      onLeave: () => this.backToLocalGame(),
    });

    this.net = new Net({
      onLobby: (you, players) => this.onLobby(you, players),
      onChallenged: (from) => this.ui.showChallenge(from),
      onDeclined: (by) => this.ui.setStatus(`${by.name} declined.`),
      onCancelled: (by) => {
        this.ui.closePrompt();
        this.ui.setStatus(`${by.name} withdrew.`);
      },
      onMatch: (match) => this.startMatch(match),
      onShot: (_by, power) => this.scene?.applyShot(power),
      onOpponentLeft: () => this.scene?.opponentLeft(),
      onError: (message) => this.ui.setStatus(message),
      onClose: () => {
        this.connected = false;
        this.ui.setStatus('Disconnected from the lobby. Reload to come back.');
      },
    });
  }

  /** An expired session leaves the room, so nobody is left waiting on someone who left. */
  private handleExpiry = (): void => {
    if (!this.connected) return;
    this.net.leaveMatch();
    this.net.close();
    this.connected = false;
    this.ui.setStatus('Session ended - you left the room.');
  };

  /** Opens the waiting room. Being in here IS being available to be challenged. */
  async open(): Promise<void> {
    // Opening twice would leave a ghost of this player sitting in the room on the first
    // socket - which is exactly what happened when a click reached the menu underneath.
    if (this.connected) {
      this.ui.show();
      return;
    }
    this.name = await ensurePlayerName();
    // The local game must not keep running behind the room: its menu is still live to
    // Phaser's input, and a tap meant for the lobby would land on it as well.
    if (this.game.scene.getScene('ZonkeScene')?.scene.isActive()) this.game.scene.stop('ZonkeScene');
    this.connected = true;
    track('online_lobby_joined');
    window.addEventListener('zonke:session-expired', this.handleExpiry);
    this.ui.show();
    this.ui.setStatus('Connecting...');
    this.net.connect(this.name);
  }

  private onLobby(you: LobbyPlayer, players: LobbyPlayer[]): void {
    this.ui.render(you, players);
    if (you.status === 'waiting') {
      this.ui.setStatus(
        players.some((p) => p.status === 'waiting')
          ? 'Pick someone and challenge them.'
          : 'You are in the room. Anyone who joins can challenge you.'
      );
    }
  }

  private startMatch(match: MatchStart): void {
    this.ui.hide();
    track('online_match_started', { youIndex: match.youIndex });

    // The scene is added once and reused, since a player may well play several matches.
    if (this.game.scene.getScene('OnlineScene')) this.game.scene.remove('OnlineScene');
    this.game.scene.add('OnlineScene', OnlineScene, false);
    this.game.scene.start('OnlineScene', {
      match,
      youName: this.name,
      onShoot: (power: number) => this.net.shoot(power),
      onLeave: () => this.leaveMatch(),
      // Both players report the outcome; the server records it only if they agree, and
      // that record is what the info button in the room shows.
      onResult: (winnerIndex: 0 | 1, kills: [number, number]) => this.net.reportResult(winnerIndex, kills),
    });
    this.scene = this.game.scene.getScene('OnlineScene') as OnlineScene;
  }

  private leaveMatch(): void {
    this.net.leaveMatch();
    if (this.game.scene.getScene('OnlineScene')) this.game.scene.stop('OnlineScene');
    this.scene = null;
    this.ui.show();
    this.ui.setStatus('Back in the room.');
  }

  /** Leaves the room entirely and hands the screen back to the single-player game. */
  private backToLocalGame(): void {
    this.net.close();
    this.connected = false;
    this.ui.hide();
    if (this.game.scene.getScene('OnlineScene')) this.game.scene.stop('OnlineScene');
    this.game.scene.start('ZonkeScene');
  }
}

let current: OnlineGame | null = null;

/** Entry point used by the mode picker and by ?online=1. */
export function startOnline(game: Phaser.Game): void {
  current = current ?? new OnlineGame(game);
  void current.open();
}
