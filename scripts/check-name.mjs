// The player's name is remembered between visits, and can be changed.
//
// The case that matters is a RETURN visit, not a reload: the browser context is closed
// entirely and reopened from the same storage state, which is what "coming back tomorrow"
// actually looks like. A fresh browser with no storage must still be asked.
import { chromium } from 'playwright';

const BASE = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const STATE = `${process.env.SHOT_DIR ?? '/tmp'}/zonke-storage.json`;
const browser = await chromium.launch();
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

const boardName = (page) =>
  page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    return { player: s.players[0].name, label: s.nameText.text };
  });

// --- first visit: asked, and the answer is kept -----------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1000, height: 820 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#name-gate', { timeout: 5000 }).catch(() => fail('a first-time visitor was not asked for a name'));
  const button = await page.textContent('#name-gate .ng-btn');
  if (button !== 'Play') fail(`first visit button reads "${button}"`);
  await page.fill('#name-gate .ng-input', 'Ntsako');
  await page.click('#name-gate .ng-btn');
  await page.waitForTimeout(400);
  const stored = await page.evaluate(() => localStorage.getItem('zonke.playerName'));
  console.log(`  first visit: asked, stored "${stored}"`);
  if (stored !== 'Ntsako') fail(`the name was not persisted (got ${stored})`);
  await context.storageState({ path: STATE });
  await context.close();
}

// --- coming back later: not asked again -------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1000, height: 820 }, storageState: STATE });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const gate = await page.$('#name-gate');
  if (gate) fail('a returning player was asked for their name again');
  await page.keyboard.press('1');
  await page.waitForTimeout(500);
  const shown = await boardName(page);
  console.log(`  return visit: not asked, board says "${shown.label}"`);
  if (shown.player !== 'Ntsako') fail(`the board calls them ${shown.player}`);
  await context.close();
}

// --- changing it from the menu, and the change sticking ---------------------------
{
  const context = await browser.newContext({ viewport: { width: 1000, height: 820 }, storageState: STATE });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  const link = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const t = s.children.list.find((o) => o.type === 'Text' && /Playing as/.test(o.text ?? ''));
    if (!t) return null;
    t.emit('pointerdown', {}, 0, 0, { stopPropagation() {} });
    return t.text;
  });
  console.log(`  menu shows: "${link}"`);
  if (!link || !/Playing as Ntsako/.test(link)) fail('the menu does not offer to change the name');

  await page.waitForSelector('#name-gate', { timeout: 5000 }).catch(() => fail('the change prompt never opened'));
  const prefilled = await page.inputValue('#name-gate .ng-input');
  const btn = await page.textContent('#name-gate .ng-btn');
  console.log(`  change prompt: prefilled "${prefilled}", button "${btn}"`);
  if (prefilled !== 'Ntsako') fail('the change prompt was not prefilled with the current name');
  if (btn !== 'Save') fail(`the change prompt button reads "${btn}"`);

  await page.fill('#name-gate .ng-input', 'Kulani');
  await page.click('#name-gate .ng-btn');
  await page.waitForTimeout(600);

  // Answering the prompt must not start a game behind it: the click lands over the menu,
  // and a match beginning by itself because you renamed yourself would be baffling.
  const afterSave = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    return {
      mode: s.mode ? s.mode.name : null,
      menuUp: s.children.list.some((o) => o.type === 'Text' && /Choose difficulty/.test(o.text ?? '')),
      label: s.children.list.find((o) => o.type === 'Text' && /Playing as/.test(o.text ?? ''))?.text ?? null,
    };
  });
  console.log(`  after saving: mode=${afterSave.mode} menu still up=${afterSave.menuUp} label="${afterSave.label}"`);
  if (afterSave.mode !== null) fail(`renaming started a ${afterSave.mode} game on its own`);
  if (!afterSave.menuUp) fail('the menu disappeared when the name was saved');
  if (afterSave.label && !/Kulani/.test(afterSave.label)) fail('the menu still shows the old name');

  await page.keyboard.press('1');
  await page.waitForTimeout(500);
  const after = await boardName(page);
  console.log(`  after change: board says "${after.label}"`);
  if (after.player !== 'Kulani') fail(`the board still calls them ${after.player}`);
  await context.storageState({ path: STATE });
  await context.close();
}

// --- the new name is what comes back next time ------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1000, height: 820 }, storageState: STATE });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  if (await page.$('#name-gate')) fail('asked again after changing the name');
  await page.keyboard.press('1');
  await page.waitForTimeout(400);
  const shown = await boardName(page);
  console.log(`  next visit: "${shown.player}"`);
  if (shown.player !== 'Kulani') fail(`the changed name did not persist (got ${shown.player})`);
  await context.close();
}

// --- a different browser is still asked -------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1000, height: 820 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const asked = await page.waitForSelector('#name-gate', { timeout: 5000 }).then(() => true).catch(() => false);
  console.log(`  a fresh browser is asked: ${asked}`);
  if (!asked) fail('a browser with no stored name was not asked for one');
  await context.close();
}

// --- changing it inside the waiting room, where the server knows you by name --------
{
  const watcher = await browser.newContext({ viewport: { width: 900, height: 820 } });
  const watcherPage = await watcher.newPage();
  await watcherPage.goto(`${BASE}?online=1`, { waitUntil: 'domcontentloaded' });
  await watcherPage.waitForTimeout(300);
  if (await watcherPage.$('#name-gate')) {
    await watcherPage.fill('#name-gate .ng-input', 'Watcher');
    await watcherPage.click('#name-gate .ng-btn');
  }
  await watcherPage.waitForSelector('.lobby-card');

  const context = await browser.newContext({ viewport: { width: 900, height: 820 }, storageState: STATE });
  const page = await context.newPage();
  await page.goto(`${BASE}?online=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lobby-card');
  await watcherPage.waitForFunction(() => /Kulani/.test(document.querySelector('.lobby-card')?.textContent ?? ''), { timeout: 5000 })
    .catch(() => fail('the other player never appeared in the room'));

  // Clicked through the DOM rather than by hit-testing: the room re-renders itself on
  // every lobby broadcast, so the element under the cursor keeps being replaced.
  const hasLink = await page.evaluate(() => {
    const link = document.querySelector('.lobby .you .change');
    if (!link) return false;
    link.click();
    return true;
  });
  if (!hasLink) fail('the waiting room has no change-name link');
  await page.waitForSelector('#name-gate', { timeout: 5000 }).catch(() => fail('the room does not offer to change the name'));
  await page.fill('#name-gate .ng-input', 'Renamed');
  await page.click('#name-gate .ng-btn');

  // The server knows players by the name they joined under, so this rejoins the room.
  await page.waitForFunction(() => /You are Renamed/.test(document.querySelector('.lobby-card')?.textContent ?? ''), { timeout: 8000 })
    .catch(() => fail('the room still shows the old name'));
  await watcherPage.waitForFunction(() => {
    const text = document.querySelector('.lobby-card')?.textContent ?? '';
    return /Renamed/.test(text) && !/Kulani/.test(text);
  }, { timeout: 8000 }).catch(() => fail('the other player was never shown the new name'));
  const room = await watcherPage.textContent('.lobby-card');
  console.log(`  lobby rename: the other player now sees "${room.replace(/\s+/g, ' ').match(/Renamed[^-]*/)?.[0]?.trim()}"`);

  await context.close();
  await watcher.close();
}

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
