// Nothing reaches the leaderboard unless the player asks for it.
//
// This exists because a round of Time Attack used to submit itself the moment the clock
// ran out, putting runs on the board that nobody chose to put there. The rules asserted
// here: no POST to /api/scores without a click, in any mode; a lost Zonke match is not
// even offered the button; and a win saves exactly once, when the button is pressed.
//
// Needs the dev server (`npm run dev`) and the API on :4000.
import { chromium } from 'playwright';

const BASE = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch();
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

async function open(mode) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/scores/.test(r.url())) posts.push(r.postData()); });
  page.on('pageerror', (e) => fail('page error: ' + e));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  if (await page.$('#name-gate')) {
    await page.fill('#name-gate .ng-input', 'Saver');
    await page.click('#name-gate .ng-btn');
  }
  await page.waitForTimeout(300);
  await page.keyboard.press(mode);
  await page.waitForTimeout(700);
  return { page, posts };
}

/** Clicks a button in a Phaser panel by the text on it. */
const clickButton = (page, match) =>
  page.evaluate((match) => {
    const scenes = window.zonkeGame.scene.getScenes(true);
    for (const s of scenes) {
      const label = s.children.list.find((o) => o.type === 'Text' && o.text && o.text.includes(match));
      if (!label) continue;
      const rect = s.children.list.find(
        (o) => o.type === 'Rectangle' && o.input && Math.abs(o.y + (o.originY === 0 ? o.height / 2 : 0) - label.y) < 4
      );
      if (rect) { rect.emit('pointerdown', {}, 0, 0, { stopPropagation() {} }); return true; }
    }
    return false;
  }, match);

// --- Zonke: a LOSS is never saved and never offered --------------------------------
{
  console.log('\n=== Zonke, CPU wins');
  const { page, posts } = await open('1');
  await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    s.players[1].kills = 3;
    s.players[0].kills = 1;
    s.players.forEach((p) => p.deadRows.fill(true));
    s.launchWithPower(0.5);
  });
  await page.waitForTimeout(4000);
  const panel = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    return s.children.list.filter((o) => o.type === 'Text' && o.depth >= 20 && o.text).map((t) => t.text.split('\n')[0]);
  });
  console.log(`  posts=${posts.length} buttons=${JSON.stringify(panel.filter((t) => /Save|Play again/.test(t)))}`);
  if (posts.length) fail(`a lost match saved itself: ${posts[0]}`);
  if (panel.some((t) => /Save my score/.test(t))) fail('a lost match still offers the save button');
  if (!panel.some((t) => /Play again/.test(t))) fail('no Play again button on a loss');
  if (!panel.some((t) => /Fastest wins|No wins saved/.test(t))) fail('a loss should still see the times to beat');
  await page.close();
}

// --- Zonke: a WIN saves only when the button is pressed ----------------------------
{
  console.log('\n=== Zonke, player wins');
  const { page, posts } = await open('1');
  await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    s.players[0].kills = 3;
    s.players[1].kills = 1;
    s.players.forEach((p) => p.deadRows.fill(true));
    s.launchWithPower(0.5);
  });
  await page.waitForTimeout(4000);
  if (posts.length) fail(`a won match saved itself before any click: ${posts[0]}`);
  const clicked = await clickButton(page, 'Save my score');
  if (!clicked) fail('could not find the save button on a win');
  await page.waitForTimeout(2500);
  console.log(`  posts after clicking save = ${posts.length}`);
  if (posts.length !== 1) fail(`expected exactly 1 save, saw ${posts.length}`);
  else {
    const body = JSON.parse(posts[0]);
    if (body.won !== true) fail(`a win was recorded with won=${body.won}`);
    if (body.mode !== 'zonke') fail(`wrong mode: ${body.mode}`);
    console.log(`  saved: ${posts[0]}`);
  }
  await page.close();
}

// --- Time Attack: the round does not submit itself --------------------------------
{
  console.log('\n=== Time Attack');
  const { page, posts } = await open('4');
  await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('TimeAttackScene');
    s.score = 12;
    s.roundStartAt = s.time.now - 59500;
  });
  await page.waitForTimeout(4000);
  console.log(`  posts before any click = ${posts.length}`);
  if (posts.length) fail(`the round saved itself: ${posts[0]}`);
  const clicked = await clickButton(page, 'Save my score');
  if (!clicked) fail('no save button on the Time Attack results');
  await page.waitForTimeout(2500);
  if (posts.length !== 1) fail(`expected exactly 1 save after clicking, saw ${posts.length}`);
  else console.log(`  saved: ${posts[0]}`);
  const label = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('TimeAttackScene');
    return s.children.list.filter((o) => o.type === 'Text' && o.text).map((t) => t.text).find((t) => /Saved as|Save failed/.test(t));
  });
  if (!/^Saved as /.test(label ?? '')) fail(`save button did not confirm: ${label}`);
  await page.close();
}

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
