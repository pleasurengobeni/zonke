// The connection to the waiting room.
//
// Deliberately thin: it holds the socket, parses messages and hands them to a listener.
// All the rules live on the server (who may challenge whom, whose turn it is) and all the
// game lives in the engine - this is only the wire between them.

export interface LobbyPlayer {
  id: string;
  name: string;
  status: 'waiting' | 'challenging' | 'challenged' | 'playing';
}

/** A player's record, as shown behind the info button in the waiting room. */
export interface PlayerRep {
  name: string;
  online: { played: number; won: number; lost: number; lastWin: string | null };
  cpu: {
    wins: number;
    fastestMs: number | null;
    mostKills: number | null;
    /** Per difficulty, because beating Hard is not the same as beating Easy. */
    byDifficulty: { difficulty: string; wins: number; fastestMs: number }[];
  };
  timeAttack: { best: number | null };
  /** How often they land the jackpot - the number that says whether someone is good. */
  zonke: {
    shots: number;
    hits: number;
    rate: number | null;
    byDifficulty: { difficulty: string; shots: number; hits: number; rate: number }[];
  };
}

export async function fetchRep(name: string): Promise<PlayerRep | null> {
  try {
    const res = await fetch(`/api/players/rep?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return (await res.json()) as PlayerRep;
  } catch {
    return null;
  }
}

export type OnlineDifficulty = 'Easy' | 'Moderate' | 'Hard';

export interface MatchStart {
  matchId: string;
  seed: number;
  youIndex: 0 | 1;
  difficulty: OnlineDifficulty;
  opponent: { id: string; name: string };
}

export interface NetListener {
  onLobby?(you: LobbyPlayer, players: LobbyPlayer[]): void;
  onChallenged?(from: { id: string; name: string }, difficulty: OnlineDifficulty): void;
  onDeclined?(by: { name: string }): void;
  onCancelled?(by: { name: string }): void;
  onMatch?(match: MatchStart): void;
  onShot?(by: 0 | 1, power: number): void;
  onOpponentLeft?(): void;
  onError?(message: string): void;
  onClose?(): void;
}

function socketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // nginx proxies the whole of /api/ to the API container, so /api/ws lands on its /ws.
  return `${protocol}//${location.host}/api/ws`;
}

export class Net {
  private socket: WebSocket | null = null;

  constructor(private readonly listener: NetListener) {}

  connect(name: string): void {
    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    socket.addEventListener('open', () => this.send({ t: 'hello', name }));
    socket.addEventListener('close', () => this.listener.onClose?.());
    socket.addEventListener('error', () => this.listener.onError?.('Lost the connection to the lobby.'));
    socket.addEventListener('message', (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (message.t) {
        case 'ping':
          this.send({ t: 'pong' });
          break;
        case 'lobby':
          this.listener.onLobby?.(message.you as LobbyPlayer, message.players as LobbyPlayer[]);
          break;
        case 'challenged':
          this.listener.onChallenged?.(
            message.from as { id: string; name: string },
            (message.difficulty as OnlineDifficulty) ?? 'Moderate'
          );
          break;
        case 'declined':
          this.listener.onDeclined?.(message.by as { name: string });
          break;
        case 'cancelled':
          this.listener.onCancelled?.(message.by as { name: string });
          break;
        case 'match':
          this.listener.onMatch?.(message as unknown as MatchStart);
          break;
        case 'shot':
          this.listener.onShot?.(message.by as 0 | 1, message.power as number);
          break;
        case 'opponentLeft':
          this.listener.onOpponentLeft?.();
          break;
        case 'error':
          this.listener.onError?.(String(message.message));
          break;
        default:
          break;
      }
    });
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  challenge(id: string, difficulty: OnlineDifficulty): void {
    this.send({ t: 'challenge', to: id, difficulty });
  }

  accept(): void {
    this.send({ t: 'accept' });
  }

  decline(): void {
    this.send({ t: 'decline' });
  }

  cancel(): void {
    this.send({ t: 'cancel' });
  }

  shoot(power: number): void {
    this.send({ t: 'shot', power });
  }

  /** Both players report the outcome; the server records it only if they agree. */
  reportResult(winnerIndex: 0 | 1, kills: [number, number]): void {
    this.send({ t: 'result', winnerIndex, kills });
  }

  leaveMatch(): void {
    this.send({ t: 'leaveMatch' });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
