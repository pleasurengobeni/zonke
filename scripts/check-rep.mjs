// The info button in the waiting room, and the record behind it.
//
// Online results are not something the server can see for itself - it relays shots, it
// does not simulate the game - so both clients report the outcome and it is written only
// when they agree. That rule is the interesting part, and it is asserted here alongside
// the button itself.
import WebSocket from 'ws';
import { chromium } from 'playwright';

const BASE = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const WS = process.env.LOBBY_URL ?? 'ws://127.0.0.1:4000/ws';
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

function client(name) {
  const ws = new WebSocket(WS);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' }));
    inbox.push(msg);
    waiters.forEach((w, i) => { if (w.match(msg)) { w.resolve(msg); waiters.splice(i, 1); } });
  });
  return {
    open: () => new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    expect: (match, label) => new Promise((resolve, reject) => {
      const found = inbox.find(match);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 4000);
      waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    }),
    close: () => ws.close(),
  };
}

/** Runs a match between two throwaway names and reports the given results. */
async function playMatch(nameA, nameB, reportA, reportB) {
  const a = client(nameA);
  const b = client(nameB);
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'hello', name: nameA });
  await a.expect((m) => m.t === 'welcome');
  b.send({ t: 'hello', name: nameB });
  await b.expect((m) => m.t === 'welcome');
  const lobby = await a.expect((m) => m.t === 'lobby' && m.players.some((p) => p.name === nameB), 'lobby');
  a.send({ t: 'challenge', to: lobby.players.find((p) => p.name === nameB).id });
  await b.expect((m) => m.t === 'challenged');
  b.send({ t: 'accept' });
  await Promise.all([a.expect((m) => m.t === 'match'), b.expect((m) => m.t === 'match')]);
  if (reportA) a.send({ t: 'result', ...reportA });
  if (reportB) b.send({ t: 'result', ...reportB });
  await new Promise((r) => setTimeout(r, 400));
  a.close();
  b.close();
  await new Promise((r) => setTimeout(r, 200));
}

const stamp = Date.now().toString().slice(-6);
const winner = `Win${stamp}`;
const loser = `Lose${stamp}`;
const dodgy = `Dodgy${stamp}`;

// --- both agree: recorded ----------------------------------------------------------
await playMatch(winner, loser, { winnerIndex: 0, kills: [4, 2] }, { winnerIndex: 0, kills: [4, 2] });
const rep = await (await fetch(`${API}/players/rep?name=${winner}`)).json();
console.log(`  ${winner}: online ${rep.online.won}W ${rep.online.lost}L of ${rep.online.played}`);
if (rep.online.won !== 1 || rep.online.played !== 1) fail(`agreed result was not recorded: ${JSON.stringify(rep.online)}`);
const loserRep = await (await fetch(`${API}/players/rep?name=${loser}`)).json();
if (loserRep.online.lost !== 1) fail(`the loser's record is wrong: ${JSON.stringify(loserRep.online)}`);

// --- they disagree: recorded as nothing ---------------------------------------------
await playMatch(dodgy, `Other${stamp}`, { winnerIndex: 0, kills: [5, 0] }, { winnerIndex: 1, kills: [0, 5] });
const dodgyRep = await (await fetch(`${API}/players/rep?name=${dodgy}`)).json();
console.log(`  ${dodgy} (both claimed the win): ${dodgyRep.online.played} matches recorded`);
if (dodgyRep.online.played !== 0) fail('a disputed result was recorded anyway');

// --- one side reporting alone proves nothing ----------------------------------------
const lone = `Lone${stamp}`;
await playMatch(lone, `Foil${stamp}`, { winnerIndex: 0, kills: [6, 0] }, null);
const loneRep = await (await fetch(`${API}/players/rep?name=${lone}`)).json();
console.log(`  ${lone} (only their own word): ${loneRep.online.played} matches recorded`);
if (loneRep.online.played !== 0) fail('one client could record a win on its own say-so');

// --- the button, in the room ---------------------------------------------------------
const browser = await chromium.launch();
const watcher = await browser.newContext({ viewport: { width: 900, height: 860 } });
const page = await watcher.newPage();
page.on('pageerror', (e) => fail(`page error: ${e}`));
await page.goto(`${BASE}?online=1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
if (await page.$('#name-gate')) {
  await page.fill('#name-gate .ng-input', 'Looker');
  await page.click('#name-gate .ng-btn');
}
await page.waitForSelector('.lobby-card');

// Put the player with a record into the room so there is someone to look up.
const ghost = client(winner);
await ghost.open();
ghost.send({ t: 'hello', name: winner });
await page.waitForFunction((n) => document.querySelector('.lobby-card')?.textContent?.includes(n), winner, { timeout: 6000 })
  .catch(() => fail('the player never appeared in the room'));

const hasInfo = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.lobby li')].find((li) => li.querySelector('.info'));
  if (!row) return null;
  const buttons = [...row.querySelectorAll('button')].map((b) => b.className || 'plain');
  row.querySelector('.info').click();
  return buttons;
});
console.log(`  row buttons, left to right: ${hasInfo ? hasInfo.join(', ') : 'NONE'}`);
if (!hasInfo) fail('no info button beside the name');
else if (hasInfo[hasInfo.length - 1] !== 'info') fail(`the info button is not the last thing on the row: ${hasInfo.join(', ')}`);

await page.waitForFunction(() => /online/i.test(document.querySelector('.lobby .rep')?.textContent ?? ''), { timeout: 6000 })
  .catch(() => fail('the record never loaded'));
const repText = await page.textContent('.lobby .rep');
console.log(`  record shown: "${repText.replace(/\s+/g, ' ').trim()}"`);
if (!/1W 0L of 1/.test(repText)) fail(`the record does not show the match that was played: ${repText}`);

// Clicking again puts it away.
await page.evaluate(() => document.querySelector('.lobby .info').click());
await page.waitForTimeout(300);
if (await page.$('.lobby .rep')) fail('the record does not close again');

ghost.close();
await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
