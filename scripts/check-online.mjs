// Two browsers, one waiting room, one match.
//
// The thing this has to prove is that the two boards agree: they never exchange board
// state, only the power of each shot, so if the engines drift the players are playing
// different games without knowing. Every few shots it compares a digest of the entire
// match state from both browsers.
//
// Needs the dev server and the API (`npm run dev` in both). The dev server must proxy
// /api/ws through to the API - see vite.config.ts.
import { chromium } from 'playwright';

const BASE = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch();
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

async function join(name) {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  page.on('pageerror', (e) => fail(`${name} page error: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) fail(`${name} console: ${m.text()}`); });
  await page.goto(`${BASE}?online=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  if (await page.$('#name-gate')) {
    await page.fill('#name-gate .ng-input', name);
    await page.click('#name-gate .ng-btn');
  }
  await page.waitForSelector('.lobby-card', { timeout: 5000 });
  return page;
}

const alice = await join('Alice');
const bob = await join('Bob');
await alice.waitForTimeout(600);

// --- the room shows who is in it, and everyone in it is challengeable --------------
const roomText = await alice.textContent('.lobby-card');
console.log(`  Alice's room: "${roomText.replace(/\s+/g, ' ').slice(0, 90)}..."`);
if (!/Bob/.test(roomText)) fail('Alice cannot see Bob in the room');
const challengeable = await alice.evaluate(() =>
  [...document.querySelectorAll('.lobby li')].map((li) => ({
    who: li.querySelector('.who')?.firstChild?.textContent,
    status: li.querySelector('.st')?.textContent,
    canChallenge: !li.querySelector('button')?.disabled,
  }))
);
console.log(`  listed: ${JSON.stringify(challengeable)}`);
if (!challengeable.some((p) => p.who === 'Bob' && p.canChallenge)) fail('Bob is in the room but cannot be challenged');

// --- challenging, and the other side being asked ----------------------------------
await alice.click('.lobby li button');
await bob.waitForSelector('.lobby-prompt', { timeout: 5000 });
const promptText = await bob.textContent('.lobby-prompt .box');
console.log(`  Bob is asked: "${promptText.replace(/\s+/g, ' ').slice(0, 60)}..."`);
if (!/Alice challenges you/.test(promptText)) fail('the challenge prompt names the wrong player');
const aliceStatus = await alice.textContent('.lobby .status-line');
if (!/waiting for an answer/i.test(aliceStatus)) fail(`challenger status reads "${aliceStatus}"`);

// --- accepting puts both into the same match --------------------------------------
await bob.click('.lobby-prompt .row button');
await alice.waitForFunction(() => !document.querySelector('.lobby-card'), { timeout: 5000 });
await bob.waitForFunction(() => !document.querySelector('.lobby-card'), { timeout: 5000 });
await alice.waitForTimeout(800);

const seeds = await Promise.all([alice, bob].map((p) =>
  p.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('OnlineScene');
    return { seed: s.opts.match.seed, youIndex: s.opts.match.youIndex, opponent: s.opts.match.opponent.name };
  })
));
console.log(`  match: Alice index ${seeds[0].youIndex} vs ${seeds[0].opponent}, Bob index ${seeds[1].youIndex} vs ${seeds[1].opponent}`);
if (seeds[0].seed !== seeds[1].seed) fail('the two boards were seeded differently');
if (seeds[0].youIndex === seeds[1].youIndex) fail('both players think they are the same player');

// --- only the player whose turn it is can shoot, and the boards stay identical -----
const digest = (page) => page.evaluate(() => window.zonkeGame.scene.getScene('OnlineScene').engine.stateDigest());
const turnOf = (page) => page.evaluate(() => {
  const s = window.zonkeGame.scene.getScene('OnlineScene');
  return { mine: s.engine.activeIndex === s.opts.match.youIndex, ready: s.engine.canShoot };
});

/** Takes one shot from whichever browser is on turn, then waits for both to settle. */
async function playShot(n) {
  const turns = await Promise.all([turnOf(alice), turnOf(bob)]);
  const shooter = turns[0].mine ? alice : bob;
  const watcher = turns[0].mine ? bob : alice;
  if (turns[0].mine === turns[1].mine) fail('both browsers think it is the same player to shoot');

  // The idle browser must not be able to fire.
  const refused = await watcher.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('OnlineScene');
    s.startCharge();
    const charging = s.charging;
    s.charging = false;
    return charging;
  });
  if (refused) fail('the player who is not on turn was allowed to charge a shot');

  await shooter.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('OnlineScene');
    s.startCharge();
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 500));
    s.release();
  });
  // Wait for both engines to come back to rest.
  for (const page of [alice, bob]) {
    await page.waitForFunction(() => {
      const s = window.zonkeGame.scene.getScene('OnlineScene');
      return s.engine.canShoot || s.engine.phase === 'over';
    }, { timeout: 15000 });
  }
  await alice.waitForTimeout(150);
  const [da, db] = await Promise.all([digest(alice), digest(bob)]);
  if (da !== db) {
    fail(`the boards diverged after shot ${n}`);
    console.log(`    Alice: ${da.slice(0, 220)}`);
    console.log(`    Bob:   ${db.slice(0, 220)}`);
    return false;
  }
  return true;
}

let shots = 0;
for (let i = 1; i <= 8; i++) {
  const over = await alice.evaluate(() => window.zonkeGame.scene.getScene('OnlineScene').engine.phase === 'over');
  if (over) break;
  if (!(await playShot(i))) break;
  shots++;
}
console.log(`  ${shots} shots exchanged, both boards identical throughout`);
if (shots < 6) fail(`only ${shots} shots completed`);

// --- leaving tells the other player -----------------------------------------------
await alice.close();
await bob.waitForFunction(() => {
  const s = window.zonkeGame.scene.getScene('OnlineScene');
  return s && /left the match/i.test(s.messageText.text);
}, { timeout: 8000 }).catch(() => fail('Bob was never told that Alice left'));
console.log('  Alice disconnected -> Bob was told');

await bob.close();
await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
