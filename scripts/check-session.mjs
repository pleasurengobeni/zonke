// A session is one visit, and a tab left open is not a player.
//
// Two bugs are pinned down here. The session id used to live in localStorage, so it never
// changed and every "session" spanned the browser's whole history - the average time on
// site was measured in days. And nothing ever ended a visit, so an abandoned tab kept
// counting. Now: a per-visit id, and a prompt with a countdown that closes the visit if
// nobody answers.
import { chromium } from 'playwright';

const BASE = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

const browser = await chromium.launch();

// --- the two identities are not the same thing -------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  if (await page.$('#name-gate')) {
    await page.fill('#name-gate .ng-input', 'Sessions');
    await page.click('#name-gate .ng-btn');
  }
  await page.waitForTimeout(500);
  const first = await page.evaluate(() => ({
    visitor: localStorage.getItem('zonke.visitorId'),
    session: sessionStorage.getItem('zonke.sessionId'),
  }));
  console.log(`  visit 1: visitor ${first.visitor?.slice(0, 8)} session ${first.session?.slice(0, 8)}`);
  if (!first.visitor || !first.session) fail('missing one of the two ids');
  if (first.visitor === first.session) fail('the visitor id and the session id are the same value');

  // A reload is the same visit.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const reloaded = await page.evaluate(() => ({
    visitor: localStorage.getItem('zonke.visitorId'),
    session: sessionStorage.getItem('zonke.sessionId'),
  }));
  if (reloaded.session !== first.session) fail('a reload started a new session');
  if (reloaded.visitor !== first.visitor) fail('a reload changed the visitor id');
  console.log('  a reload keeps the same visit');

  // Coming back later is the same person, a different visit.
  const state = await context.storageState();
  await context.close();
  const later = await browser.newContext({
    viewport: { width: 900, height: 800 },
    storageState: { cookies: [], origins: state.origins.map((o) => ({ ...o, localStorage: o.localStorage })) },
  });
  const page2 = await later.newPage();
  await page2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(700);
  const second = await page2.evaluate(() => ({
    visitor: localStorage.getItem('zonke.visitorId'),
    session: sessionStorage.getItem('zonke.sessionId'),
  }));
  console.log(`  visit 2: visitor ${second.visitor?.slice(0, 8)} session ${second.session?.slice(0, 8)}`);
  if (second.visitor !== first.visitor) fail('a returning visitor was treated as a new person');
  if (second.session === first.session) fail('a second visit reused the first session id');
  console.log('  same person, new visit - which is what makes the duration mean anything');
  await later.close();
}

// --- the prompt, its countdown, and what happens if nobody answers -------------------
{
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => fail(`page error: ${e}`));
  // Two seconds idle, four seconds to answer - the real values are minutes.
  await page.goto(`${BASE}?idleMs=2000&graceMs=12000`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  if (await page.$('#name-gate')) {
    await page.fill('#name-gate .ng-input', 'Idler');
    await page.click('#name-gate .ng-btn');
  }
  const sessionBefore = await page.evaluate(() => sessionStorage.getItem('zonke.sessionId'));

  // Activity keeps it away.
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(100 + i * 10, 200);
    await page.waitForTimeout(500);
  }
  if (await page.$('.idle')) fail('the prompt appeared while the player was active');
  console.log('  no prompt while there is activity');

  // Then stop touching anything. The watcher checks on a tick, so wait for the prompt
  // rather than assuming how long it takes to notice.
  const prompt = await page.waitForSelector('.idle .count', { timeout: 20000 }).catch(() => null);
  if (!prompt) fail('no prompt after going idle');
  else {
    const text = await page.textContent('.idle .box');
    console.log(`  prompt: "${text.replace(/\\s+/g, ' ').slice(0, 60)}"`);
    if (!/still there/i.test(text)) fail('the prompt does not ask whether anyone is there');
    const counts = [];
    for (let i = 0; i < 3; i++) {
      counts.push(await page.textContent('.idle .count'));
      await page.waitForTimeout(1000);
    }
    console.log(`  countdown: ${counts.join(' -> ')}`);
    if (new Set(counts).size < 2) fail(`the countdown does not count down: ${counts.join(', ')}`);
  }

  // Nobody answers.
  await page.waitForFunction(() => /session ended/i.test(document.querySelector('.idle .box')?.textContent ?? ''), { timeout: 20000 })
    .catch(() => fail('the countdown never ran out'));
  const ended = await page.textContent('.idle .box').catch(() => '');
  console.log(`  after the countdown: "${ended.replace(/\\s+/g, ' ').slice(0, 50)}"`);
  if (!/session ended/i.test(ended)) fail('the session was never declared over');

  // Starting again is a NEW visit, not a continuation of the time spent away.
  await page.click('.idle button');
  await page.waitForTimeout(500);
  const sessionAfter = await page.evaluate(() => sessionStorage.getItem('zonke.sessionId'));
  if (sessionAfter === sessionBefore) fail('resuming reused the expired session id');
  else console.log('  starting again begins a new visit');

  // And the server was told.
  await page.waitForTimeout(2000);
  const events = await (await fetch(`${API}/stats/events?limit=30&type=session_expired`)).json();
  if (!events.length) fail('no session_expired event reached the server');
  else console.log(`  server recorded session_expired (${events.length} total)`);
  await context.close();
}

// --- answering keeps the visit alive -------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${BASE}?idleMs=2000&graceMs=20000`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  if (await page.$('#name-gate')) {
    await page.fill('#name-gate .ng-input', 'Stayer');
    await page.click('#name-gate .ng-btn');
  }
  const before = await page.evaluate(() => sessionStorage.getItem('zonke.sessionId'));
  await page.waitForSelector('.idle button', { timeout: 20000 }).catch(() => fail('no prompt to answer'));
  await page.click('.idle button');
  await page.waitForTimeout(600);
  if (await page.$('.idle')) fail('answering did not dismiss the prompt');
  const after = await page.evaluate(() => sessionStorage.getItem('zonke.sessionId'));
  if (after !== before) fail('answering "I am here" started a new session anyway');
  console.log('  answering keeps the same visit going');
  await context.close();
}

await browser.close();
console.log(failed ? '\\nFAILED' : '\\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
