// Gameplay feature check: drives a real match in Chromium and asserts the things pure
// type-checking can't see - that the session name reaches the board, the match clock ticks
// above it, a landing on the green row really does burst the ball into several with their
// own speeds, and the win screen shows (and saves) the run's kills and time without any of
// it falling off the canvas.
//
// Companion to check-layout.mjs, and like it, needs a running dev server: `npm run dev`,
// plus the API on :4000 for the leaderboard leg. Start that API with a raised limit -
// `RATE_LIMIT_MAX=1000 npm run dev` in api/ - because this suite drives several sessions
// from one address within a minute and the shipped 60/min would throttle the last leg. It steers the game through
// window.zonkeGame, the dev-only handle main.ts exposes - see the note there.
import { chromium } from 'playwright';

// The 3D ball and figures are the default now, and they replace the flat ones - so this
// suite, which is about the flat board's own drawing, asks for the flat board explicitly.
// check-3d.mjs covers the overlay, including that its layout matches this one exactly.
const ROOT = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const URL = `${ROOT}?flat=1`;
const OUT = process.env.SHOT_DIR ?? '/tmp';
const sizes = [['phone', 390, 844], ['desktop', 1366, 768]];
const browser = await chromium.launch();
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

for (const [label, w, h] of sizes) {
  console.log(`\n=== ${label} ${w}x${h}`);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // 1. The name gate should be up, before anything else.
  const gate = await page.$('#name-gate');
  if (!gate) fail('no name prompt on first load');
  await page.fill('#name-gate .ng-input', 'Ntsako');
  await page.screenshot({ path: `${OUT}/${label}-1-name.png` });
  await page.click('#name-gate .ng-btn');
  await page.waitForTimeout(400);
  if (await page.$('#name-gate')) fail('name prompt did not close');

  // Kept in localStorage so a player coming back tomorrow is not asked again; whether
  // that actually survives a return visit is check-name.mjs's job.
  const stored = await page.evaluate(() => localStorage.getItem('zonke.playerName'));
  if (stored !== 'Ntsako') fail(`name not persisted (got ${stored})`);

  await page.screenshot({ path: `${OUT}/${label}-2-picker.png` });

  // 2. Pick Easy, then read back the live scene state.
  await page.keyboard.press('1');
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    return {
      p1: s.players[0].name,
      turn: s.turnText.text,
      clock: s.clockText.text,
      splitRow: s.splitRow,
      splitVisible: s.splitHighlight.visible,
      splitSeen: s.splitSeenThisGame,
      penaltyRow: s.penaltyRow,
      clockTop: s.clockText.y,
    };
  });
  console.log('  ' + JSON.stringify(state));
  if (state.p1 !== 'Ntsako') fail('player name not applied to the board');
  if (!state.turn.startsWith('Ntsako')) fail(`turn text still says "${state.turn}"`);
  if (!/^Time  \d:\d\d$/.test(state.clock)) fail(`clock text wrong: "${state.clock}"`);
  // The green row is a rare visitor, not a fixture - a fresh board must not have one.
  if (state.splitRow !== null || state.splitVisible) fail('green split row present at kick-off');
  if (state.splitSeen) fail('match starts with its green row already spent');
  // The red row is rolled for too - a fresh board has neither.
  if (state.penaltyRow !== null) fail('a red row is on the board before anything is rolled');

  // 3. Let the clock run and confirm it actually counts.
  await page.waitForTimeout(2200);
  const clock2 = await page.evaluate(() => window.zonkeGame.scene.getScene('ZonkeScene').clockText.text);
  if (clock2 === state.clock) fail(`clock is not ticking (${clock2})`);
  console.log(`  clock ticked ${state.clock} -> ${clock2}`);

  // 3b. No horizontal line inside a row. Read the real pixels rather than trust the
  // screenshot: a strip down the middle of column A is sampled at each row's divider, at
  // the half-height where the old sub-line ran, and at a blank quarter of the same row.
  // The divider is the control - if that does not read as bright, the sampling is wrong.
  const lines = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const l = s.actorLayout();
    const x = Math.round(l.gridLeft + l.cellW * 0.5);
    const w = 3;
    const h = Math.round(l.rowH * 10);
    const img = await new Promise((resolve) =>
      window.zonkeGame.renderer.snapshotArea(x, Math.round(l.logTop), w, h, resolve)
    );
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const brightness = (row) => {
      const y = Math.max(0, Math.min(h - 1, row));
      let sum = 0;
      for (let i = 0; i < w; i++) {
        const o = (y * w + i) * 4;
        sum += data[o] + data[o + 1] + data[o + 2];
      }
      return sum / (w * 3);
    };
    const rows = [];
    for (let r = 1; r < 10; r++) {
      rows.push({
        r,
        divider: brightness(Math.round(r * l.rowH)),
        mid: brightness(Math.round(r * l.rowH + l.rowH / 2)),
        blank: brightness(Math.round(r * l.rowH + l.rowH * 0.28)),
      });
    }
    return rows;
  });
  const control = lines.filter((row) => row.divider > row.blank + 25);
  if (control.length < 5) {
    fail(`pixel sampling is not detecting row dividers, so it cannot prove anything: ${JSON.stringify(lines[0])}`);
  } else {
    const withLine = lines.filter((row) => row.mid > row.blank + 12);
    if (withLine.length) {
      fail(`${withLine.length} rows still have a line across the middle: ${JSON.stringify(withLine[0])}`);
    } else {
      console.log(`  no mid-row lines (dividers read +${Math.round(control[0].divider - control[0].blank)} brightness, mid-row +${Math.round(lines[0].mid - lines[0].blank)})`);
    }
  }

  // 3c. Row 1 has to be reachable. It used to be half a row of the charge range, because
  // a charge of nothing rested at row 1's CENTRE - so the bottom row felt impossible.
  const reach = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const counts = {};
    // Walk the whole charge range and see which row each charge would land on.
    for (let power = 0; power <= 1.55; power += 0.001) {
      const y = s.restingYFor(power);
      const row = y < s.actorLayout().logTop ? 'ZONKE' : 10 - s.rowSlotAt(y);
      counts[row] = (counts[row] ?? 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { row1: (counts[1] ?? 0) / total, row5: (counts[5] ?? 0) / total, row10: (counts[10] ?? 0) / total };
  });
  console.log(`  charge range by row: row 1 ${(reach.row1 * 100).toFixed(1)}%, row 5 ${(reach.row5 * 100).toFixed(1)}%, row 10 ${(reach.row10 * 100).toFixed(1)}%`);
  if (reach.row1 === 0) fail('row 1 cannot be reached at all');
  // Row 1 should be as reachable as a middle row, give or take.
  if (reach.row1 < reach.row5 * 0.8) fail(`row 1 is ${(reach.row1 * 100).toFixed(1)}% of the range against row 5's ${(reach.row5 * 100).toFixed(1)}% - still much harder`);

  // And a weak tap really does land there, in the real physics rather than on paper.
  const landed = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const rows = [];
    for (let i = 0; i < 3; i++) {
      for (let w = 0; w < 200 && !(s.ready && s.activeIndex === 0); w++) await new Promise((r) => setTimeout(r, 50));
      if (s.gameOver) break;
      s.launchWithPower(0.02 + i * 0.01);
      // Watch it come to rest: arming the next shot clears the ball, so reading afterwards
      // reads nothing - which is what made this report row 10 every time.
      let restingY = null;
      for (let w = 0; w < 400; w++) {
        if (s.balls.length > 0) restingY = s.balls[s.balls.length - 1].y;
        if (s.ready && restingY !== null) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      rows.push(restingY === null ? 0 : 10 - s.rowSlotAt(restingY));
    }
    return rows;
  });
  console.log(`  weak taps landed on rows: ${landed.join(', ')}`);
  if (!landed.every((r) => r === 1)) fail(`a weak tap should land on row 1, got ${landed.join(', ')}`);

  // 3d. The red row: rolled for, at most twice a match, four kills apart, worth 1-3 moves.
  const penaltyRules = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    // Roll the dice a great many times and watch the lifecycle the rules describe. The
    // match's own state is saved and put back afterwards: this is a simulation of the
    // rules, and it must not leave the board it borrowed in a different position.
    const saved = {
      used: s.penaltyUsed,
      row: s.penaltyRow,
      turns: s.penaltyTurnsLeft,
      moves: s.penaltyMoves,
      gate: s.killsAtLastPenalty,
      kills: [s.players[0].kills, s.players[1].kills],
    };
    const opens = [];
    s.penaltyUsed = 0;
    s.penaltyRow = null;
    s.killsAtLastPenalty = 0;
    s.players[0].kills = 0;
    s.players[1].kills = 0;
    for (let turn = 0; turn < 4000; turn++) {
      const before = s.penaltyRow;
      s.tickPenaltyRow(false);
      if (before === null && s.penaltyRow !== null) {
        opens.push({ turn, moves: s.penaltyMoves, killsThen: s.players[0].kills + s.players[1].kills });
        s.tickPenaltyRow(true); // claimed straight away
      }
      // A couple of kills along the way - not yet the four a second one needs.
      if (turn === 500) s.players[0].kills = 2;
      if (turn === 2000) s.players[0].kills = 6; // now four more than when the first closed
    }
    s.penaltyUsed = saved.used;
    s.penaltyRow = saved.row;
    s.penaltyTurnsLeft = saved.turns;
    s.penaltyMoves = saved.moves;
    s.killsAtLastPenalty = saved.gate;
    s.players[0].kills = saved.kills[0];
    s.players[1].kills = saved.kills[1];
    s.penaltyHighlight.setVisible(saved.row !== null);
    s.penaltyLabel.setVisible(saved.row !== null);
    return { opens, used: saved.used };
  });
  console.log(`  red row: ${penaltyRules.opens.length} opened in 4000 turns, moves ${penaltyRules.opens.map((o) => o.moves).join('/')}`);
  if (penaltyRules.opens.length === 0) fail('a red row never opens');
  if (penaltyRules.opens.length > 2) fail(`${penaltyRules.opens.length} red rows in one match - the limit is two`);
  penaltyRules.opens.forEach((o) => {
    if (o.moves < 1 || o.moves > 3) fail(`a red row was worth ${o.moves} moves, expected 1-3`);
  });
  if (penaltyRules.opens.length === 2) {
    const [first, second] = penaltyRules.opens;
    if (second.killsThen - first.killsThen < 4) {
      fail(`the second red row opened after only ${second.killsThen - first.killsThen} more kills, expected 4`);
    } else {
      console.log(`  the second needed ${second.killsThen - first.killsThen} more kills`);
    }
  }

  // And what it actually does: your move plays, the opponent loses that many.
  const penalty = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    for (let i = 0; i < 200 && !(s.ready && s.activeIndex === 0); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    let power = 0.5;
    for (let t = 0; t <= 1.55; t += 0.005) {
      if (s.rowSlotAt(s.restingYFor(t)) === s.rowSlotAt(s.restingYFor(0.5)) && s.restingYFor(t) > 0) power = t;
    }
    const row = s.rowSlotAt(s.restingYFor(power));
    s.penaltyRow = row;
    s.penaltyMoves = 3;
    s.splitRow = null;
    s.rowFigureParts[row][1] = 7;
    s.rowBullets[row][1] = 4;
    const before = { parts: s.rowFigureParts[row][1], bullets: s.rowBullets[row][1], mine: s.rowFigureParts[row][0] };
    s.launchWithPower(power);
    for (let i = 0; i < 400 && !(s.ready || s.gameOver); i++) await new Promise((r) => setTimeout(r, 40));
    await new Promise((r) => setTimeout(r, 300));
    return {
      before,
      after: { parts: s.rowFigureParts[row][1], bullets: s.rowBullets[row][1], mine: s.rowFigureParts[row][0] },
      message: s.messageText.text,
      closed: s.penaltyRow === null,
    };
  });
  const lost = (penalty.before.bullets + penalty.before.parts) - (penalty.after.bullets + penalty.after.parts);
  console.log(`  claimed a -3 row: opponent lost ${lost}; "${penalty.message.slice(0, 60)}"`);
  if (lost !== 3) fail(`a -3 row took ${lost} moves, expected 3`);
  if (penalty.after.bullets !== penalty.before.bullets - 3) fail('the bullet steps should go first');
  if (penalty.after.mine <= penalty.before.mine) fail('the player did not get their own move as well');
  if (!penalty.closed) fail('the red row stayed open after being claimed');

  // 4. Open a green row the way the game does, then aim a shot at the row it chose. The
  // board is restarted first: the legs above take real shots, which can end the match.
  await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    s.scene.restart({ mode: s.mode });
  });
  await page.waitForTimeout(1200);

  const split = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    // Wait for the human's turn with the ball parked and ready.
    for (let i = 0; i < 200 && !(s.ready && s.activeIndex === 0); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    s.openSplitRow();
    const openedVisible = s.splitHighlight.visible && s.splitLabel.visible;
    const windowSeconds = Math.round((s.splitExpiresAt - s.time.now) / 1000);
    // Find the charge that comes to rest on that row, the way a player aiming at it would.
    let power = null;
    for (let t = 0; t <= 1.55; t += 0.005) {
      if (s.rowSlotAt(s.restingYFor(t)) === s.splitRow && s.restingYFor(t) > 0) power = t;
    }
    s.launchWithPower(power);
    // Wait until the split has fired and the balls have all come to rest.
    let peak = 0;
    let splitMsg = '';
    let resolveMsg = '';
    // The CPU takes its turn straight afterwards and overwrites the message, so both are
    // captured as they are shown rather than read back once the dust has settled.
    let peakLandings = 0;
    for (let i = 0; i < 400; i++) {
      peak = Math.max(peak, s.balls.length);
      // Landings are cleared when the next shot is armed, so watch the high-water mark.
      peakLandings = Math.max(peakLandings, s.landings.length);
      const t = s.messageText.text;
      if (/^SPLIT!/.test(t)) splitMsg = t;
      if (/^Split into/.test(t)) resolveMsg = t;
      if (resolveMsg) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Hitting it spends the match's one chance: no further roll may bring it back.
    let reopened = false;
    for (let i = 0; i < 5000; i++) {
      s.tickSplitRow(false);
      if (s.splitRow !== null) { reopened = true; break; }
    }
    return {
      peak, splitMsg, resolveMsg, landings: peakLandings, openedVisible, windowSeconds,
      closedAfter: s.splitRow === null && !s.splitHighlight.visible,
      reopened,
    };
  });
  console.log('  split: ' + JSON.stringify(split));
  if (split.peak < 3) fail(`ball did not split (peak balls ${split.peak})`);
  if (split.peak > 6) fail(`too many balls after split (${split.peak})`);
  if (!/^SPLIT! The ball burst into [2-5] /.test(split.splitMsg)) fail(`no split announcement: "${split.splitMsg}"`);
  if (!/^Split into [2-5] balls/.test(split.resolveMsg)) fail(`split turn message missing: "${split.resolveMsg}"`);
  if (split.landings !== split.peak) fail(`${split.peak} balls but ${split.landings} landings`);
  if (!split.openedVisible) fail('an open green row is not shown on the board');
  if (split.windowSeconds !== 15) fail(`green row window is ${split.windowSeconds}s, not 15s`);
  if (!split.closedAfter) fail('green row stayed open after being claimed');
  if (split.reopened) fail('a second green row opened in the same game');
  await page.screenshot({ path: `${OUT}/${label}-3-split.png` });

  // 5. The win screen, with a match time and kills on it. Restarted first, because the
  // legs above take real shots and any of them can have ended the match already.
  await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    s.scene.restart({ mode: s.mode });
  });
  await page.waitForTimeout(1200);

  const win = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    s.players[0].kills = 4;
    s.players[1].kills = 2;
    s.matchStartAt = s.time.now - 251_000; // 4:11 on the clock
    s.gameOver = true;
    s.matchEndedAt = s.time.now;
    s.updateClock();
    s.showCelebration(s.players[0], 'Ntsako cannot be caught - wins!');
    await new Promise((r) => setTimeout(r, 900));
    // Everything on the win screen has to be inside the canvas, at any screen size.
    const texts = s.children.list.filter((o) => o.type === 'Text' && o.depth >= 20 && o.text);
    return texts.map((t) => ({
      text: t.text.split('\n')[0],
      left: t.x - t.displayWidth * t.originX,
      right: t.x + t.displayWidth * (1 - t.originX),
      top: t.y - t.displayHeight * t.originY,
      bottom: t.y + t.displayHeight * (1 - t.originY),
      w: s.scale.width,
      h: s.scale.height,
    }));
  });
  const march = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const graphics = s.children.list.filter((o) => o.type === 'Graphics' && o.depth >= 20);
    const sample = () => graphics.map((g) => (g.commandBuffer ?? []).length).reduce((a, b) => a + b, 0);
    const first = sample();
    await new Promise((r) => setTimeout(r, 400));
    const second = sample();
    return { layers: graphics.length, first, second };
  });
  console.log(`  victory march: ${march.layers} animated layer(s), ${march.first} -> ${march.second} draw commands`);
  if (march.layers === 0) fail('nothing is being drawn over the win screen');
  if (march.first === 0) fail('the marching figures are not drawn');

  await page.screenshot({ path: `${OUT}/${label}-4-win.png` });
  const big = win.find((t) => t.text.includes('WINS!'));
  if (!big) fail('no winner headline on the win screen');
  else console.log(`  headline "${big.text}" ${Math.round(big.right - big.left)}px wide`);
  if (!win.some((t) => /Kills  4 - 2/.test(t.text))) fail('kills missing from win screen');
  if (!win.some((t) => /Time  4:1\d/.test(t.text))) fail('match time missing from win screen');
  // A win saves itself now; there is no button to find, only a note saying what happened.
  if (win.some((t) => /Save my score/.test(t.text))) fail('the win screen still asks the player to save');
  for (const t of win) {
    if (t.left < -1 || t.right > t.w + 1 || t.top < -1 || t.bottom > t.h + 1) {
      fail(`"${t.text}" outside the canvas (${Math.round(t.left)}..${Math.round(t.right)} of ${t.w})`);
    }
  }

  // 6. The run saves itself, and the board follows - no tap involved.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${label}-5-saved.png` });
  const after = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    return s.children.list.filter((o) => o.type === 'Text' && o.depth >= 20).map((t) => t.text);
  });
  const note = after.find((t) => /^(NEW RECORD|Saved -|Saved to|Could not save)/.test(t));
  console.log(`  it says: "${note}"`);
  if (!note) fail(`the win screen never reported the save: ${JSON.stringify(after.slice(-3))}`);
  if (/Could not save/.test(note ?? '')) fail('the run failed to save');

  const board = after.find((t) => t.includes('Fastest wins'));
  if (!board) fail(`the fastest-wins board did not load: ${JSON.stringify(after.slice(-3))}`);
  else {
    console.log('  leaderboard: ' + board.split('\n').slice(0, 3).join(' | '));
    const names = board.split('\n').slice(1).map((l) => l.replace(/^\d+\. /, '').split('  -  ')[0]);
    if (new Set(names).size !== names.length) fail(`a player appears twice on the board: ${names.join(', ')}`);
    const times = [...board.matchAll(/(\d+):(\d\d)/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
    if (times.some((t, i) => i > 0 && t < times[i - 1])) fail(`the board is not sorted: ${times}`);
  }

  const rep = await (await fetch('http://127.0.0.1:4000/players/rep?name=Ntsako')).json();
  const easy = (rep.cpu.byDifficulty ?? []).find((d) => d.difficulty === 'Easy');
  if (!easy || easy.wins < 1) fail(`the win was not recorded against Easy: ${JSON.stringify(rep.cpu)}`);
  else console.log(`  recorded: ${easy.wins} Easy win(s), fastest ${Math.round(easy.fastestMs / 1000)}s`);

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------------
// How often the green row opens. A match is around 70 turns (measured), and the point of
// the feature is that plenty of matches never see one at all - so this asserts the rate
// stays scarce rather than drifting back into being a fixture on every board.
// ---------------------------------------------------------------------------------
{
  console.log('\n=== green row scarcity');
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.fill('#name-gate .ng-input', 'Rate');
  await page.click('#name-gate .ng-btn');
  await page.waitForTimeout(300);
  await page.keyboard.press('1');
  await page.waitForTimeout(400);
  const rate = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    // Each simulated opening would otherwise fire a real analytics post - hundreds of them,
    // filling the events table with rows no player ever caused. Silence the network for the
    // length of the simulation only.
    const realFetch = window.fetch;
    window.fetch = () => Promise.resolve(new Response('', { status: 204 }));
    const MATCHES = 500;
    const TURNS = 70; // a measured match
    let withNone = 0;
    let total = 0;
    let mostInOneMatch = 0;
    for (let m = 0; m < MATCHES; m++) {
      // A fresh match, then its turns played out. The row's own 15s clock runs in update(),
      // so here the window is closed by hand the turn after it opens.
      s.splitRow = null;
      s.splitSeenThisGame = false;
      s.splitHighlight.setVisible(false);
      let opened = 0;
      for (let t = 0; t < TURNS; t++) {
        s.tickSplitRow(false);
        if (s.splitRow !== null) {
          opened++;
          s.closeSplitRow();
        }
      }
      total += opened;
      mostInOneMatch = Math.max(mostInOneMatch, opened);
      if (opened === 0) withNone++;
    }
    s.splitRow = null;
    s.splitSeenThisGame = false;
    s.splitHighlight.setVisible(false);
    s.splitLabel.setVisible(false);
    window.fetch = realFetch;
    return { perMatch: total / MATCHES, noneRate: withNone / MATCHES, mostInOneMatch };
  });
  console.log(`  opens ${rate.perMatch.toFixed(2)}x per 70-turn match; ${Math.round(rate.noneRate * 100)}% of matches never see one; most in one match: ${rate.mostInOneMatch}`);
  if (rate.mostInOneMatch > 1) fail(`green row opened ${rate.mostInOneMatch} times in one match`);
  if (rate.noneRate < 0.25) fail(`too few matches end without one (${Math.round(rate.noneRate * 100)}%)`);
  if (rate.perMatch < 0.15) fail(`green row effectively never opens (${rate.perMatch.toFixed(2)} per match)`);
  // The window is a real 15 seconds, and it shuts on its own.
  const timed = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    s.splitSeenThisGame = false;
    s.openSplitRow();
    const opened = s.splitRow;
    const labels = [];
    const startedAt = performance.now();
    let closedAfterMs = null;
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (s.splitLabel.visible) labels.push(s.splitLabel.text);
      if (s.splitRow === null) { closedAfterMs = performance.now() - startedAt; break; }
    }
    return { opened, closedAfterMs, firstLabel: labels[0], lastLabel: labels[labels.length - 1] };
  });
  console.log(`  window: ${timed.firstLabel} -> ${timed.lastLabel}, closed after ${Math.round(timed.closedAfterMs)}ms`);
  if (timed.closedAfterMs === null) fail('green row never closed on its own');
  else if (Math.abs(timed.closedAfterMs - 15_000) > 1500) fail(`window was ${Math.round(timed.closedAfterMs)}ms, not ~15s`);
  if (!/^SPLIT 1[45]s$/.test(timed.firstLabel)) fail(`countdown starts at "${timed.firstLabel}"`);
  if (!/^SPLIT [12]s$/.test(timed.lastLabel)) fail(`countdown ends at "${timed.lastLabel}"`);

  await page.close();
}

// ---------------------------------------------------------------------------------
// A single session played end to end: split in flight, Play again, then Time Attack.
// ---------------------------------------------------------------------------------
{
  console.log('\n=== full session 430x932');
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.fill('#name-gate .ng-input', 'Thandi');
  await page.click('#name-gate .ng-btn');
  await page.waitForTimeout(300);
  await page.keyboard.press('2'); // Moderate
  await page.waitForTimeout(400);

  // --- balls in the air during a split ---------------------------------------------
  const flight = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    for (let i = 0; i < 200 && !(s.ready && s.activeIndex === 0); i++) await new Promise((r) => setTimeout(r, 100));
    s.openSplitRow();
    let power = null;
    for (let t = 0; t <= 1.55; t += 0.005) {
      if (s.rowSlotAt(s.restingYFor(t)) === s.splitRow && s.restingYFor(t) > 0) power = t;
    }
    s.launchWithPower(power);
    let snap = null;
    for (let i = 0; i < 400; i++) {
      const moving = s.balls.filter((b) => !b.resting);
      if (s.balls.length > 1 && moving.length > 1) {
        snap = {
          total: s.balls.length,
          moving: moving.length,
          // Each splinter should be carrying its own speed, not a shared one.
          speeds: moving.map((b) => Number(Math.hypot(b.vx, b.vy).toFixed(2))),
          visible: s.balls.filter((b) => b.gfx.visible).length,
          colors: [...new Set(s.balls.map((b) => b.gfx.fillColor))],
          radii: [...new Set(s.balls.map((b) => Number(b.gfx.radius.toFixed(1))))],
        };
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return snap;
  });
  console.log('  in flight: ' + JSON.stringify(flight));
  if (!flight) fail('never saw more than one ball moving at once');
  else {
    if (flight.visible !== flight.total) fail('some balls are invisible in flight');
    if (new Set(flight.speeds).size < 2) fail(`splinters share one speed: ${flight.speeds}`);
    if (flight.colors.length < 2) fail('split balls are not drawn differently from the launcher ball');
  }
  await page.screenshot({ path: `${OUT}/flight.png` });

  // --- Play again restarts a clean match ------------------------------------------
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    s.players[0].kills = 3;
    s.gameOver = true;
    s.matchEndedAt = s.time.now;
    s.showCelebration(s.players[0], 'test win');
    await new Promise((r) => setTimeout(r, 600));
    const buttons = s.children.list.filter((o) => o.type === 'Rectangle' && o.depth === 22 && o.input);
    buttons[buttons.length - 1].emit('pointerdown', {}, 0, 0, { stopPropagation() {} }); // Play again
  });
  await page.waitForTimeout(1200);
  const restarted = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    return {
      gameOver: s.gameOver,
      kills: s.players.map((p) => p.kills),
      name: s.players[0].name,
      clock: s.clockText.text,
      mode: s.mode && s.mode.name,
      celebrationLeft: s.children.list.filter((o) => o.depth >= 20).length,
      gate: Boolean(document.querySelector('#name-gate')),
    };
  });
  console.log('  after Play again: ' + JSON.stringify(restarted));
  if (restarted.gameOver) fail('still in game-over state after Play again');
  if (restarted.kills.some((k) => k !== 0)) fail('kills not reset');
  if (restarted.name !== 'Thandi') fail('name not kept across restart');
  if (restarted.mode !== 'Moderate') fail('difficulty not kept across restart');
  if (restarted.gate) fail('name prompt reappeared mid-session');
  if (restarted.celebrationLeft > 0) fail('win screen objects survived the restart');
  // The new match's clock starts the moment it restarts, so it may already read a second.
  if (!/^Time  0:0[0-3]$/.test(restarted.clock)) fail(`clock not reset: ${restarted.clock}`);

  // --- Time Attack: no prompt, saves under the session name ------------------------
  await page.evaluate(() => window.zonkeGame.scene.getScene('ZonkeScene').scene.start('TimeAttackScene'));
  await page.waitForTimeout(600);
  const ta = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('TimeAttackScene');
    s.score = 17;
    s.roundStartAt = s.time.now - 59_000; // let the round run out in a second
    for (let i = 0; i < 100 && !s.roundOver; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 2500));
    return {
      over: s.roundOver,
      texts: s.children.list.filter((o) => o.type === 'Text').map((t) => t.text),
      prompted: Boolean(document.querySelector('#name-gate')),
    };
  });
  await page.screenshot({ path: `${OUT}/timeattack.png` });
  console.log('  time attack: over=' + ta.over + ' prompted=' + ta.prompted);
  if (ta.prompted) fail('Time Attack asked for a name again');
  // The round must NOT have saved itself - it offers a button instead. Whether that button
  // works is check-saves.mjs's job; here it only has to be on screen and unpressed.
  // Time Attack saves itself too - what has to be true is that it says so, and that it
  // never asks. check-saves.mjs is where the submission itself is pinned down.
  if (ta.texts.some((t) => /Save my score/.test(t))) fail('Time Attack still asks the player to save');
  if (!ta.texts.some((t) => /Saved as|NEW RECORD|Couldn/.test(t))) fail('Time Attack does not report the save');
  if (!ta.texts.some((t) => /1\. \w+ - \d+/.test(t))) fail('no leaderboard on the Time Attack results');

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  await page.close();
}

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
