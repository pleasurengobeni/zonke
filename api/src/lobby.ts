// The waiting room and the matches that come out of it.
//
// Everyone connected to the lobby is visible to everyone else and can be challenged -
// entering the room IS making yourself available. A challenge goes to one person, who
// accepts or declines; accepting puts the pair into a match and takes them both off the
// list.
//
// The server does not simulate the game. Both browsers run the same engine from the same
// seed (see src/zonke/Match.ts), so the only thing that has to cross the network is the
// power of each shot. What this server owns is what only a referee can: who is in the
// room, who may challenge whom, and whose turn it is.
import type { IncomingMessage, Server } from 'node:http';
import { randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { db } from './db.js';

type Status = 'waiting' | 'challenging' | 'challenged' | 'playing';

interface Player {
  id: string;
  name: string;
  socket: WebSocket;
  status: Status;
  /** Who this player has challenged, or been challenged by. */
  pending: string | null;
  matchId: string | null;
  ip: string;
  alive: boolean;
}

interface GameMatch {
  id: string;
  seed: number;
  players: [string, string]; // index 0 shoots first
  turn: 0 | 1;
  startedAt: number;
  /** What each side says the result was, by index. Recorded once they agree. */
  reported: [Result | null, Result | null];
  recorded: boolean;
}

interface Result {
  winnerIndex: 0 | 1;
  kills: [number, number];
}

const MAX_NAME = 24;
const MAX_MESSAGE_BYTES = 2048;
const MAX_PER_IP = 4;
const HEARTBEAT_MS = 30_000;

const players = new Map<string, Player>();
const matches = new Map<string, GameMatch>();

function send(player: Player, message: unknown): void {
  if (player.socket.readyState === WebSocket.OPEN) {
    player.socket.send(JSON.stringify(message));
  }
}

/** The room as everyone else sees it: who is here and whether they can be challenged. */
function lobbyView(viewer: Player): unknown {
  return {
    t: 'lobby',
    you: { id: viewer.id, name: viewer.name, status: viewer.status },
    players: [...players.values()]
      .filter((p) => p.id !== viewer.id)
      .map((p) => ({ id: p.id, name: p.name, status: p.status })),
  };
}

function broadcastLobby(): void {
  players.forEach((p) => send(p, lobbyView(p)));
}

function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return stripped.length > 0 && stripped.length <= maxLen ? stripped : null;
}

/** Puts a player back on the market, clearing whatever they were caught up in. */
function resetToWaiting(player: Player): void {
  player.status = 'waiting';
  player.pending = null;
  player.matchId = null;
}

function endMatch(match: GameMatch, quitterId: string | null): void {
  matches.delete(match.id);
  match.players.forEach((id) => {
    const player = players.get(id);
    if (!player) return;
    resetToWaiting(player);
    if (quitterId && id !== quitterId) send(player, { t: 'opponentLeft' });
  });
}

function handleChallenge(from: Player, targetId: string): void {
  const target = players.get(targetId);
  if (!target) return send(from, { t: 'error', message: 'That player has left the room.' });
  if (from.status !== 'waiting' || target.status !== 'waiting') {
    return send(from, { t: 'error', message: 'That player is busy right now.' });
  }
  from.status = 'challenging';
  from.pending = target.id;
  target.status = 'challenged';
  target.pending = from.id;
  send(target, { t: 'challenged', from: { id: from.id, name: from.name } });
  broadcastLobby();
}

function handleAccept(target: Player): void {
  const challenger = target.pending ? players.get(target.pending) : null;
  if (!challenger || target.status !== 'challenged' || challenger.status !== 'challenging') {
    resetToWaiting(target);
    broadcastLobby();
    return send(target, { t: 'error', message: 'That challenge is no longer open.' });
  }

  // The challenger shoots first - they asked for the game.
  const match: GameMatch = {
    id: `m${randomInt(1e9)}`,
    seed: randomInt(1, 2 ** 31 - 1),
    players: [challenger.id, target.id],
    turn: 0,
    startedAt: Date.now(),
    reported: [null, null],
    recorded: false,
  };
  matches.set(match.id, match);

  [challenger, target].forEach((player, index) => {
    player.status = 'playing';
    player.pending = null;
    player.matchId = match.id;
    const opponent = index === 0 ? target : challenger;
    send(player, {
      t: 'match',
      matchId: match.id,
      seed: match.seed,
      // Both engines are built the same way round: index 0 is the challenger, on both
      // screens, so "player 0" means the same person to both of them.
      youIndex: index,
      opponent: { id: opponent.id, name: opponent.name },
    });
  });
  broadcastLobby();
}

function handleDecline(target: Player): void {
  const challenger = target.pending ? players.get(target.pending) : null;
  resetToWaiting(target);
  if (challenger) {
    resetToWaiting(challenger);
    send(challenger, { t: 'declined', by: { id: target.id, name: target.name } });
  }
  broadcastLobby();
}

function handleCancel(challenger: Player): void {
  const target = challenger.pending ? players.get(challenger.pending) : null;
  resetToWaiting(challenger);
  if (target && target.status === 'challenged') {
    resetToWaiting(target);
    send(target, { t: 'cancelled', by: { id: challenger.id, name: challenger.name } });
  }
  broadcastLobby();
}

/**
 * A shot is the only thing that moves a match along. The server checks that it came from
 * the player whose turn it is, then echoes it to BOTH of them - including the shooter, so
 * that both engines apply it at the same point in their own sequence and cannot drift.
 */
function handleShot(player: Player, power: unknown): void {
  const match = player.matchId ? matches.get(player.matchId) : null;
  if (!match) return send(player, { t: 'error', message: 'You are not in a match.' });
  const index = match.players.indexOf(player.id) as 0 | 1;
  if (index !== match.turn) return send(player, { t: 'error', message: 'Not your turn.' });
  const value = typeof power === 'number' ? power : Number(power);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    return send(player, { t: 'error', message: 'Bad shot.' });
  }

  match.turn = (1 - match.turn) as 0 | 1;
  match.players.forEach((id) => {
    const p = players.get(id);
    if (p) send(p, { t: 'shot', by: index, power: value });
  });
}

/**
 * Records a finished match, once. The server does not simulate the game, so it cannot see
 * who won - both clients report it, and the result is only written when the two of them
 * agree. A pair who disagree (or a client making things up on its own) records nothing,
 * which is the right way round: a missing result is better than a false one.
 */
function handleResult(player: Player, message: Record<string, unknown>): void {
  const match = player.matchId ? matches.get(player.matchId) : null;
  if (!match || match.recorded) return;
  const index = match.players.indexOf(player.id) as 0 | 1;
  if (index < 0) return;

  const winnerIndex = message.winnerIndex === 0 || message.winnerIndex === 1 ? message.winnerIndex : null;
  const kills = Array.isArray(message.kills) ? message.kills.map(Number) : null;
  if (winnerIndex === null || !kills || kills.length !== 2 || kills.some((k) => !Number.isFinite(k))) return;

  match.reported[index] = { winnerIndex, kills: [kills[0], kills[1]] };
  const [a, b] = match.reported;
  if (!a || !b) return;
  if (a.winnerIndex !== b.winnerIndex) return; // they disagree - record nothing

  const winner = players.get(match.players[a.winnerIndex]);
  const loser = players.get(match.players[1 - a.winnerIndex]);
  if (!winner || !loser) return;

  match.recorded = true;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO online_results
         (match_id, winner_name, loser_name, winner_kills, loser_kills, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      match.id,
      winner.name,
      loser.name,
      a.kills[a.winnerIndex],
      a.kills[1 - a.winnerIndex],
      Date.now() - match.startedAt
    );
  } catch {
    // A record that fails to save must not take the lobby down with it.
  }
}

export function attachLobby(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const ip = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? request.socket.remoteAddress ?? 'unknown';
    if ([...players.values()].filter((p) => p.ip === ip).length >= MAX_PER_IP) {
      socket.send(JSON.stringify({ t: 'error', message: 'Too many connections from this network.' }));
      socket.close();
      return;
    }

    const id = `p${randomInt(1e9)}`;
    let player: Player | null = null;

    socket.on('message', (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }

      // Nothing but `hello` is accepted before the player has a name.
      if (!player) {
        if (message.t !== 'hello') return;
        const name = cleanString(message.name, MAX_NAME);
        if (!name) {
          socket.send(JSON.stringify({ t: 'error', message: 'A name is required.' }));
          return;
        }
        player = { id, name, socket, status: 'waiting', pending: null, matchId: null, ip, alive: true };
        players.set(id, player);
        send(player, { t: 'welcome', you: { id, name } });
        broadcastLobby();
        return;
      }

      switch (message.t) {
        case 'challenge':
          handleChallenge(player, String(message.to));
          break;
        case 'accept':
          handleAccept(player);
          break;
        case 'decline':
          handleDecline(player);
          break;
        case 'cancel':
          handleCancel(player);
          break;
        case 'shot':
          handleShot(player, message.power);
          break;
        case 'result':
          handleResult(player, message);
          break;
        case 'leaveMatch': {
          const match = player.matchId ? matches.get(player.matchId) : null;
          if (match) endMatch(match, player.id);
          broadcastLobby();
          break;
        }
        case 'pong':
          player.alive = true;
          break;
        default:
          break;
      }
    });

    socket.on('close', () => {
      if (!player) return;
      const match = player.matchId ? matches.get(player.matchId) : null;
      if (match) endMatch(match, player.id);
      if (player.pending) {
        const other = players.get(player.pending);
        if (other) {
          resetToWaiting(other);
          send(other, { t: 'cancelled', by: { id: player.id, name: player.name } });
        }
      }
      players.delete(player.id);
      broadcastLobby();
    });
  });

  // Drops sockets that have stopped answering, so the room does not fill with ghosts.
  const heartbeat = setInterval(() => {
    players.forEach((player) => {
      if (!player.alive) {
        player.socket.terminate();
        return;
      }
      player.alive = false;
      send(player, { t: 'ping' });
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return wss;
}

/** For the stats page: how busy the room is right now. */
export function lobbyStats(): { online: number; waiting: number; playing: number; matches: number } {
  const all = [...players.values()];
  return {
    online: all.length,
    waiting: all.filter((p) => p.status === 'waiting').length,
    playing: all.filter((p) => p.status === 'playing').length,
    matches: matches.size,
  };
}
