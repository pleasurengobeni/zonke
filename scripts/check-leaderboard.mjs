// The leaderboard shows the top ten PLAYERS, not the top ten runs.
//
// One person having a good week used to fill every row, which tells nobody anything. This
// seeds several players (one of them repeatedly), then asserts the board lists each player
// once, in the right order, and that it is reachable from the menu.
import { chromium } from 'playwright';

const BASE = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

/** A player with several runs, the best of which is `bestMs`. */
async function seed(name, bestMs, difficulty) {
  for (const ms of [bestMs + 40_000, bestMs, bestMs + 90_000]) {
    await fetch(`${API}/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score: 4, durationMs: ms, mode: 'zonke', won: true, difficulty }),
    });
  }
}

const stamp = Date.now().toString().slice(-5);
const players = [[`Aa${stamp}`, 11_000], [`Bb${stamp}`, 12_000], [`Cc${stamp}`, 13_000]];
for (const [name, ms] of players) await seed(name, ms, 'Easy');
// The same people, much slower, on Hard - so the two boards cannot be confused.
for (const [name, ms] of players) await seed(name, ms + 300_000, 'Hard');

// --- a difficulty board contains only that difficulty ------------------------------
for (const difficulty of ['Easy', 'Hard']) {
  const board = await (await fetch(`${API}/scores/top?mode=zonke&sort=fastest&perPlayer=1&difficulty=${difficulty}&limit=10`)).json();
  const wrong = board.filter((r) => r.difficulty !== difficulty);
  console.log(`  ${difficulty}: ${board.length} players, best ${Math.round(board[0].durationMs / 1000)}s`);
  if (wrong.length) fail(`the ${difficulty} board contains ${wrong.map((r) => r.difficulty).join(', ')}`);
}
const easyBest = (await (await fetch(`${API}/scores/top?mode=zonke&sort=fastest&perPlayer=1&difficulty=Easy&limit=1`)).json())[0];
const hardBest = (await (await fetch(`${API}/scores/top?mode=zonke&sort=fastest&perPlayer=1&difficulty=Hard&limit=1`)).json())[0];
if (hardBest.durationMs <= easyBest.durationMs) fail('the Hard board looks like the Easy one - are they actually separate?');

// --- the API returns one row per player, best first --------------------------------
const rows = await (await fetch(`${API}/scores/top?mode=zonke&sort=fastest&perPlayer=1&difficulty=Easy&limit=10`)).json();
const names = rows.map((r) => r.name);
console.log(`  board: ${rows.map((r) => `${r.name}(${Math.round(r.durationMs / 1000)}s)`).join(', ')}`);
if (new Set(names).size !== names.length) fail(`a player appears more than once: ${names.join(', ')}`);
const times = rows.map((r) => r.durationMs);
if (times.some((t, i) => i > 0 && t < times[i - 1])) fail(`not sorted by time: ${times}`);
for (const [name, best] of players) {
  const row = rows.find((r) => r.name === name);
  if (row && row.durationMs !== best) fail(`${name} is listed with ${row.durationMs}ms, not their best ${best}ms`);
}
if (rows.length > 10) fail(`asked for 10, got ${rows.length}`);

// --- and the menu can show it -------------------------------------------------------
const browser = await chromium.launch();
// Checked on a phone as well as a desktop: two ten-row lists is a lot of vertical space,
// and a board that runs off the bottom of the screen is not a board anyone can read.
for (const [label, width, height] of [['desktop', 1000, 900], ['phone', 390, 844]]) {
const page = await browser.newPage({ viewport: { width, height } });
console.log(`  --- ${label} ${width}x${height}`);
page.on('pageerror', (e) => fail(`page error: ${e}`));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);
if (await page.$('#name-gate')) {
  await page.fill('#name-gate .ng-input', 'Looker');
  await page.click('#name-gate .ng-btn');
}
await page.waitForTimeout(600);
await page.keyboard.press('6');
await page.waitForTimeout(2500);

const texts = () => page.evaluate(() => {
  const s = window.zonkeGame.scene.getScene('ZonkeScene');
  return s.children.list.filter((o) => o.type === 'Text' && o.text).map((t) => t.text);
});
const openTab = (name) => page.evaluate((name) => {
  const s = window.zonkeGame.scene.getScene('ZonkeScene');
  const label = s.children.list.find((o) => o.type === 'Text' && o.text === name && o.depth === 2);
  if (!label) return false;
  const box = s.children.list.find((o) => o.type === 'Rectangle' && o.input && Math.abs(o.x - label.x) < 2);
  if (!box) return false;
  box.emit('pointerdown', {}, 0, 0, { stopPropagation() {} });
  return true;
}, name);

const board = await texts();
if (!board.some((t) => /LEADERBOARD/.test(t))) fail('no leaderboard panel opened from the menu');
for (const tab of ['Easy', 'Moderate', 'Hard', 'Challenge', 'Time Attack']) {
  if (!board.includes(tab)) fail(`no "${tab}" tab on the leaderboard`);
}
if (!board.some((t) => t === 'Back')) fail('no way back out of the leaderboard');

// The board that is open must be the one the tab says.
const easyList = (await texts()).find((t) => /^1\. /.test(t));
console.log(`  Easy tab: ${easyList ? easyList.split('\n')[0] : 'EMPTY'}`);
if (easyList) {
  const listed = easyList.split('\n').map((line) => line.replace(/^\d+\. /, '').split('  -  ')[0]).filter(Boolean);
  if (new Set(listed).size !== listed.length) fail(`a player is listed twice on screen: ${listed.join(', ')}`);
  if (listed.length > 10) fail(`the panel lists ${listed.length} players`);
  console.log(`  ${listed.length} distinct players on the Easy board`);
}

if (!(await openTab('Hard'))) fail('the Hard tab could not be opened');
await page.waitForTimeout(1500);
const hardList = (await texts()).find((t) => /^1\. /.test(t));
console.log(`  Hard tab: ${hardList ? hardList.split('\n')[0] : 'EMPTY'}`);
if (hardList && easyList && hardList === easyList) fail('the Hard tab shows the same board as Easy');

if (!(await openTab('Challenge'))) fail('the Challenge tab could not be opened');
await page.waitForTimeout(1500);
const challenge = (await texts()).find((t) => /W \d+L|No online matches/.test(t));
console.log(`  Challenge tab: ${challenge ? challenge.split('\n')[0] : 'EMPTY'}`);
if (!challenge) fail('the Challenge tab shows neither standings nor an empty message');

// Nothing may run off the screen.
const overflow = await page.evaluate(() => {
  const s = window.zonkeGame.scene.getScene('ZonkeScene');
  const h = s.scale.height;
  const w = s.scale.width;
  return s.children.list
    .filter((o) => o.type === 'Text' && o.text && /LEADERBOARD|Fastest wins|Time Attack points|Back/.test(o.text))
    .map((t) => ({
      text: t.text.split('\n')[0],
      top: Math.round(t.y - t.displayHeight * t.originY),
      bottom: Math.round(t.y + t.displayHeight * (1 - t.originY)),
      left: Math.round(t.x - t.displayWidth * t.originX),
      right: Math.round(t.x + t.displayWidth * (1 - t.originX)),
      w,
      h,
    }))
    .filter((t) => t.top < 0 || t.bottom > t.h || t.left < 0 || t.right > t.w);
});
if (overflow.length) {
  overflow.forEach((o) => fail(`"${o.text}" runs off screen (${o.top}..${o.bottom} of ${o.h} tall)`));
} else {
  console.log('  everything fits on screen');
}

await page.close();
}

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
