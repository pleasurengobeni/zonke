// Everything the game does should end up in the events table, in enough detail to be
// analysed later - and cheaply enough that a match does not flood the API. This plays a
// real match in a browser and then reads back what the server actually stored.
import { chromium } from 'playwright';

const BASE = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

const since = new Date(Date.now() - 2000).toISOString();
// A unique player per run: the events table is durable, and a fixed name would make every
// run count the previous one's shots as well.
const PLAYER = `Telemetry${Date.now().toString().slice(-6)}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
page.on('pageerror', (e) => fail(`page error: ${e}`));

let requests = 0;
page.on('request', (r) => { if (/\/api\/events/.test(r.url())) requests += 1; });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
if (await page.$('#name-gate')) {
  await page.fill('#name-gate .ng-input', PLAYER);
  await page.click('#name-gate .ng-btn');
}
await page.waitForTimeout(300);
await page.keyboard.press('3'); // Hard, so the difficulty on every event is distinctive
await page.waitForTimeout(600);

// Twelve shots of real play.
const shots = await page.evaluate(async () => {
  const s = window.zonkeGame.scene.getScene('ZonkeScene');
  let taken = 0;
  for (let i = 0; i < 12; i++) {
    for (let w = 0; w < 200 && !(s.ready && s.activeIndex === 0); w++) await new Promise((r) => setTimeout(r, 50));
    if (s.gameOver) break;
    s.launchWithPower(0.2 + Math.random() * 1.2);
    taken += 1;
    for (let w = 0; w < 300 && !s.ready; w++) await new Promise((r) => setTimeout(r, 50));
  }
  return taken;
});
// Let the buffer flush.
await page.waitForTimeout(5000);

const events = await (await fetch(`${API}/stats/events?limit=500&since=${encodeURIComponent(since)}`)).json();
const mine = events.filter((e) => e.event_type === 'shot' || e.event_type === 'landing');
const byType = {};
events.forEach((e) => { byType[e.event_type] = (byType[e.event_type] ?? 0) + 1; });
console.log(`  ${shots} shots played; stored: ${Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(' ')}`);
console.log(`  requests to /api/events*: ${requests} (batched)`);

if (!byType.shot) fail('no shot events were recorded');
if (!byType.landing) fail('no landing events were recorded');
if (byType.shot < shots) fail(`played ${shots} shots but only ${byType.shot} were recorded`);
// What matters is that the events are batched at all: one request per event would both
// flood the API and trip its 60-per-minute limiter in the middle of a match.
const stored = Object.values(byType).reduce((a, b) => a + b, 0);
console.log(`  ${stored} events in ${requests} requests (${(stored / requests).toFixed(1)} per request)`);
if (requests >= stored) fail(`${requests} requests for ${stored} events - nothing is being batched`);
if (requests > 30) fail(`${requests} requests for one match would risk the per-IP rate limit`);

const sample = mine.find((e) => e.event_type === 'landing');
const payload = sample ? JSON.parse(sample.payload) : null;
console.log(`  a landing looks like: ${JSON.stringify(payload)}`);
if (!payload) fail('landing events carry no payload');
else {
  for (const field of ['by', 'difficulty', 'rows', 'kills', 'score', 'turn']) {
    if (!(field in payload)) fail(`landing events do not record "${field}"`);
  }
  if (payload.difficulty !== 'Hard') fail(`the difficulty was recorded as ${payload.difficulty}, not Hard`);
}
const shotSample = mine.find((e) => e.event_type === 'shot');
const shotPayload = shotSample ? JSON.parse(shotSample.payload) : null;
console.log(`  a shot looks like: ${JSON.stringify(shotPayload)}`);
if (shotPayload && typeof shotPayload.power !== 'number') fail('shot events do not record the power used');

// --- the ZONKE rate, computed from those same shots --------------------------------
const rep = await (await fetch(`${API}/players/rep?name=${PLAYER}`)).json();
console.log(`  rep says: ${rep.zonke.hits} of ${rep.zonke.shots} shots = ${rep.zonke.rate === null ? 'n/a' : (rep.zonke.rate * 100).toFixed(1) + '%'}`);
if (rep.zonke.shots !== shots) fail(`played ${shots} shots, rep counted ${rep.zonke.shots}`);
if (rep.zonke.rate === null) fail('no ZONKE rate after a match was played');
if (rep.zonke.rate < 0 || rep.zonke.rate > 1) fail(`the rate is not a proportion: ${rep.zonke.rate}`);
const hard = rep.zonke.byDifficulty.find((d) => d.difficulty === 'Hard');
if (!hard) fail('the rate is not broken down by difficulty');
else console.log(`  Hard: ${hard.hits}/${hard.shots}`);

// A player nobody has ever seen must read as "no data", never as 0%.
const unknown = await (await fetch(`${API}/players/rep?name=NeverPlayed${Date.now()}`)).json();
if (unknown.zonke.rate !== null) fail(`an unknown player reports a rate of ${unknown.zonke.rate} instead of null`);
console.log('  a player with no shots reports no rate, rather than 0%');

// --- and it reaches the screen ------------------------------------------------------
await page.keyboard.press('R');
await page.waitForTimeout(600);
const onScreen = await page.evaluate(async () => {
  const s = window.zonkeGame.scene.getScene('ZonkeScene');
  s.mode = null;
  s.showLeaderboard();
  await new Promise((r) => setTimeout(r, 2500));
  return s.children.list.filter((o) => o.type === 'Text' && o.text).map((t) => t.text).find((t) => /Your ZONKE rate/.test(t));
});
console.log(`  on the leaderboard: "${onScreen}"`);
if (!onScreen || !/\d/.test(onScreen)) fail('the player never sees their own ZONKE rate');

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
