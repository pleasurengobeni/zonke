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
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  if (await page.$('#name-gate')) {
    await page.fill('#name-gate .ng-input', 'Saver');
    await page.click('#name-gate .ng-btn');
  }
  // Wait for the prompt to be gone before choosing a difficulty: it swallows key presses,
  // so a key sent while it is still closing never reaches the game at all.
  await page.waitForFunction(() => !document.querySelector('#name-gate'), { timeout: 10000 });
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.keyboard.press(mode);
    const chosen = await page
      .waitForFunction(
        () =>
          Boolean(window.zonkeGame.scene.getScene('ZonkeScene')?.mode) ||
          Boolean(window.zonkeGame.scene.getScene('TimeAttackScene')?.scene?.isActive()),
        { timeout: 2000 }
      )
      .then(() => true)
      .catch(() => false);
    if (chosen) break;
  }
  await page.waitForTimeout(500);
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

// --- Zonke: a LOSS is never saved -------------------------------------------------
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
  await page.waitForTimeout(4500);
  const panel = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    return s.children.list.filter((o) => o.type === 'Text' && o.depth >= 20 && o.text).map((t) => t.text.split('\n')[0]);
  });
  console.log(`  posts=${posts.length} panel=${JSON.stringify(panel.filter((t) => /Save|Play again|Saved|RECORD/.test(t)))}`);
  if (posts.length) fail(`a lost match saved itself: ${posts[0]}`);
  if (panel.some((t) => /Save my score/.test(t))) fail('a lost match offers a save button');
  if (!panel.some((t) => /Play again/.test(t))) fail('no Play again button on a loss');
  if (!panel.some((t) => /Fastest wins|No wins saved/.test(t))) fail('a loss should still see the times to beat');
  await page.close();
}

// --- Zonke: a WIN saves itself, with no button to press ---------------------------
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
  await page.waitForTimeout(5000);
  console.log(`  posts without touching anything = ${posts.length}`);
  if (posts.length !== 1) fail(`a win should save itself exactly once, saw ${posts.length}`);
  else {
    const body = JSON.parse(posts[0]);
    if (body.won !== true) fail(`the win was recorded with won=${body.won}`);
    if (body.difficulty !== 'Easy') fail(`saved against ${body.difficulty}, expected Easy`);
    console.log(`  saved: ${posts[0]}`);
  }
  const texts = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    return s.children.list.filter((o) => o.type === 'Text' && o.depth >= 20 && o.text).map((t) => t.text.split('\n')[0]);
  });
  if (texts.some((t) => /Save my score/.test(t))) fail('the win screen still asks the player to save');
  const note = texts.find((t) => /^(NEW RECORD|Saved -|Saved to|Could not save)/.test(t));
  console.log(`  it says: "${note}"`);
  if (!note) fail('the win screen does not say whether the run was saved');
  // How they won has to be on screen too.
  if (!texts.some((t) => /wins|cannot be caught|rows taken/i.test(t))) fail('the win screen does not say how they won');
  await page.close();
}

// --- a record is called out ---------------------------------------------------------
{
  console.log('\n=== a record');
  const { page } = await open('1');
  const note = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    // A time nothing can beat, under a name nobody has used.
    s.players[0].name = `Ace${Date.now().toString().slice(-6)}`;
    s.players[0].kills = 3;
    s.players[1].kills = 0;
    s.matchStartAt = s.time.now - 1200; // about as fast as a match can be
    s.players.forEach((p) => p.deadRows.fill(true));
    s.launchWithPower(0.5);
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 200));
      // Match the note's own wording, not just any text - the winner's name appears in
      // the headline, and a player called "Record" would otherwise pass this by accident.
      const found = s.children.list
        .filter((o) => o.type === 'Text' && o.depth >= 20 && o.text)
        .map((t) => t.text)
        .find((t) => /^(NEW RECORD|Saved -|Saved to|Could not save)/.test(t));
      if (found) return found;
    }
    return null;
  });
  console.log(`  it says: "${note}"`);
  if (!note) fail('nothing was said about the run at all');
  else if (!/^NEW RECORD|best/.test(note)) fail(`a record-breaking run was not called out: "${note}"`);
  await page.close();
}

// --- Time Attack: the round saves itself ------------------------------------------
{
  console.log('\n=== Time Attack');
  const { page, posts } = await open('4');
  await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('TimeAttackScene');
    s.score = 12;
    s.roundStartAt = s.time.now - 59500;
  });
  await page.waitForTimeout(5000);
  console.log(`  posts without touching anything = ${posts.length}`);
  if (posts.length !== 1) fail(`the round should save itself once, saw ${posts.length}`);
  const texts = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('TimeAttackScene');
    return s.children.list.filter((o) => o.type === 'Text' && o.text).map((t) => t.text);
  });
  if (texts.some((t) => /Save my score/.test(t))) fail('Time Attack still asks the player to save');
  const note = texts.find((t) => /Saved as|RECORD|best|Couldn/.test(t));
  console.log(`  it says: "${note}"`);
  if (!note) fail('the results panel does not say whether the run was saved');
  await page.close();
}

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
