// The waiting room's rules, driven over real WebSockets against a running API.
// Run from api/: `node check-lobby.mjs` (expects the API on :4000).
import WebSocket from 'ws';

const URL = process.env.LOBBY_URL ?? 'ws://127.0.0.1:4000/ws';
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

/** A test client that records everything the server sends it. */
function client(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' }));
    inbox.push(msg);
    waiters.forEach((w, i) => { if (w.match(msg)) { w.resolve(msg); waiters.splice(i, 1); } });
  });
  return {
    ws,
    inbox,
    open: () => new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    /** Waits for a message the predicate likes, or times out. */
    expect: (match, label = 'message') =>
      new Promise((resolve, reject) => {
        const found = inbox.find(match);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      }),
    close: () => ws.close(),
  };
}

const alice = client('Alice');
const bob = client('Bob');
await Promise.all([alice.open(), bob.open()]);

// --- entering the room makes you visible and available ---------------------------
alice.send({ t: 'hello', name: 'Alice' });
await alice.expect((m) => m.t === 'welcome', 'welcome');
bob.send({ t: 'hello', name: 'Bob' });
await bob.expect((m) => m.t === 'welcome', 'welcome');

const aliceSeesBob = await alice.expect((m) => m.t === 'lobby' && m.players.some((p) => p.name === 'Bob'), 'Bob in the lobby');
const bobsView = await bob.expect((m) => m.t === 'lobby', 'lobby');
console.log(`  Alice sees: ${aliceSeesBob.players.map((p) => `${p.name}(${p.status})`).join(', ')}`);
if (!aliceSeesBob.players.every((p) => p.status === 'waiting')) fail('a new arrival should be waiting, and challengeable');
if (bobsView.you.status !== 'waiting') fail(`Bob joined as ${bobsView.you.status}, expected waiting`);
if (bobsView.players.some((p) => p.id === bobsView.you.id)) fail('a player should not see themselves in the list');

// --- a challenge reaches the other person and marks them both --------------------
const bobId = aliceSeesBob.players.find((p) => p.name === 'Bob').id;
alice.send({ t: 'challenge', to: bobId });
const challenged = await bob.expect((m) => m.t === 'challenged', 'a challenge');
if (challenged.from.name !== 'Alice') fail(`challenge came from ${challenged.from.name}`);
const duringChallenge = await bob.expect((m) => m.t === 'lobby' && m.you.status === 'challenged', "Bob's status");
console.log(`  after the challenge: Bob is ${duringChallenge.you.status}, Alice is ${duringChallenge.players.find((p) => p.name === 'Alice').status}`);
if (duringChallenge.players.find((p) => p.name === 'Alice').status !== 'challenging') fail('the challenger should show as challenging');

// --- a third player cannot muscle in on someone who is busy ----------------------
const carol = client('Carol');
await carol.open();
carol.send({ t: 'hello', name: 'Carol' });
await carol.expect((m) => m.t === 'welcome');
const carolView = await carol.expect((m) => m.t === 'lobby' && m.players.length >= 2, 'lobby with both');
carol.send({ t: 'challenge', to: carolView.players.find((p) => p.name === 'Bob').id });
const refused = await carol.expect((m) => m.t === 'error', 'a refusal');
console.log(`  Carol challenging a busy player: "${refused.message}"`);

// --- accepting starts a match, with the same seed on both sides ------------------
bob.send({ t: 'accept' });
const aliceMatch = await alice.expect((m) => m.t === 'match', "Alice's match");
const bobMatch = await bob.expect((m) => m.t === 'match', "Bob's match");
console.log(`  match ${aliceMatch.matchId}: seed ${aliceMatch.seed}, Alice is ${aliceMatch.youIndex}, Bob is ${bobMatch.youIndex}`);
if (aliceMatch.seed !== bobMatch.seed) fail('the two players were given different seeds');
if (aliceMatch.matchId !== bobMatch.matchId) fail('the two players are in different matches');
if (aliceMatch.youIndex === bobMatch.youIndex) fail('both players were given the same index');
if (aliceMatch.opponent.name !== 'Bob' || bobMatch.opponent.name !== 'Alice') fail('wrong opponent names');

// --- turn order is enforced, and every shot reaches both players -----------------
bob.send({ t: 'shot', power: 0.5 }); // not Bob's turn - Alice challenged, so Alice starts
const outOfTurn = await bob.expect((m) => m.t === 'error' && /turn/i.test(m.message), 'an out-of-turn refusal');
console.log(`  out of turn: "${outOfTurn.message}"`);

alice.send({ t: 'shot', power: 0.87 });
const echoA = await alice.expect((m) => m.t === 'shot', "Alice's echo");
const echoB = await bob.expect((m) => m.t === 'shot', "Bob's copy");
if (echoA.power !== 0.87 || echoB.power !== 0.87) fail('the shot power changed in transit');
if (echoA.by !== 0 || echoB.by !== 0) fail('the shot was attributed to the wrong player');
console.log(`  shot relayed to both: by=${echoA.by} power=${echoA.power}`);

bob.send({ t: 'shot', power: 1.2 });
const second = await bob.expect((m) => m.t === 'shot' && m.by === 1, "Bob's shot");
if (second.power !== 1.2) fail('second shot mangled');
console.log('  turn passed to the other player and their shot went through');

// --- leaving tells the opponent and frees them up --------------------------------
alice.close();
const left = await bob.expect((m) => m.t === 'opponentLeft', 'notice that Alice left');
const afterLeave = await bob.expect((m) => m.t === 'lobby' && m.you.status === 'waiting', 'Bob back in the room');
console.log(`  Alice disconnected -> Bob told (${left.t}) and returned to ${afterLeave.you.status}`);

bob.close();
carol.close();
await new Promise((r) => setTimeout(r, 200));
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
