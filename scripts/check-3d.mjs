// Browser-driven check for the 3D actors overlay (?r3d=1): the original 2D board, with
// the ball and figures drawn as real 3D meshes on a transparent layer above it.
//
// The central claim this has to prove is that the LAYOUT IS UNCHANGED. So it loads the
// same page twice - with and without the flag - and compares the board's own geometry
// number for number, then checks that each mesh sits on the 2D coordinate it replaces.
//
// Needs the dev server (`npm run dev`) and the API on :4000, the latter started with a
// raised limit: `RATE_LIMIT_MAX=1000 npm run dev` in api/.
import { chromium } from 'playwright';

const BASE = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const OUT = process.env.SHOT_DIR ?? '/tmp';
// Headless Chromium has no GPU; SwiftShader gives it a real WebGL implementation.
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
let failed = false;
const fail = (m) => { failed = true; console.log('  FAIL ' + m); };

/** Boots a page, names the player, picks Easy, and returns it ready to play. */
async function openGame(url, w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (await page.$('#name-gate')) {
    await page.fill('#name-gate .ng-input', 'Ntsako');
    await page.click('#name-gate .ng-btn');
  }
  await page.waitForTimeout(400);
  await page.keyboard.press('1');
  await page.waitForTimeout(700);
  return { page, errors };
}

const layoutOf = (page) =>
  page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const l = s.actorLayout();
    return {
      ...l,
      ballRestY: s.ballRestY,
      turnY: Math.round(s.turnText.y),
      messageY: Math.round(s.messageText.y),
      clockY: Math.round(s.clockText.y),
      zonkeHeaderPresent: s.children.list.some((o) => o.type === 'Text' && o.text === 'ZONKE'),
    };
  });

for (const [label, w, h] of [['phone', 390, 844], ['desktop', 1366, 768]]) {
  console.log(`\n=== 3D actors ${label} ${w}x${h}`);

  // --- the layout must be identical to the plain 2D board, number for number ---------
  const plain = await openGame(BASE, w, h);
  const layout2d = await layoutOf(plain.page);
  await plain.page.screenshot({ path: `${OUT}/actors-${label}-2d.png` });
  await plain.page.close();

  const { page, errors } = await openGame(`${BASE}?r3d=1`, w, h);
  const layout3d = await layoutOf(page);

  const differences = Object.keys(layout2d).filter((k) => JSON.stringify(layout2d[k]) !== JSON.stringify(layout3d[k]));
  if (differences.length) fail(`layout changed: ${differences.map((k) => `${k} ${JSON.stringify(layout2d[k])}->${JSON.stringify(layout3d[k])}`).join(', ')}`);
  else console.log(`  layout identical to 2D (grid ${Math.round(layout3d.gridLeft)}+${Math.round(layout3d.cellW * 8)}, rowH ${layout3d.rowH.toFixed(1)})`);

  // --- the flat ball and flat figures are gone, an overlay canvas is there instead ---
  const swap = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const canvases = [...document.querySelectorAll('canvas')];
    const phaser = window.zonkeGame.canvas;
    const overlay = canvases.find((c) => c !== phaser);
    const rectP = phaser.getBoundingClientRect();
    const rectO = overlay?.getBoundingClientRect();
    return {
      canvases: canvases.length,
      flatBallVisible: s.ball.visible,
      flatFigureDraws: s.miniFigureGfx.flat().filter((g) => g.commandBuffer && g.commandBuffer.length > 0).length,
      aligned: rectO ? Math.abs(rectO.x - rectP.x) < 1 && Math.abs(rectO.y - rectP.y) < 1 &&
        Math.abs(rectO.width - rectP.width) < 1 && Math.abs(rectO.height - rectP.height) < 1 : false,
      overlayIgnoresInput: overlay ? getComputedStyle(overlay).pointerEvents === 'none' : false,
    };
  });
  if (swap.canvases !== 2) fail(`expected 2 canvases (board + overlay), saw ${swap.canvases}`);
  if (swap.flatBallVisible) fail('the flat 2D ball is still being drawn');
  if (swap.flatFigureDraws > 0) fail(`${swap.flatFigureDraws} flat figures are still being drawn`);
  if (!swap.aligned) fail('the overlay canvas is not exactly over the board canvas');
  if (!swap.overlayIgnoresInput) fail('the overlay would swallow taps');

  // --- the 3D ball sits exactly where the 2D ball would be -------------------------
  const ball = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const o = window.zonkeActors;
    const mesh = o.ballMeshes[0];
    const expected = s.actorBalls()[0];
    return {
      visible: mesh.visible,
      dx: Math.abs(mesh.position.x - expected.x),
      // The overlay's y is flipped into pixel space, so undo that to compare.
      dy: Math.abs(s.actorLayout().canvasH - mesh.position.y - expected.y),
      radius: mesh.scale.x,
      expectedRadius: expected.r,
    };
  });
  if (!ball.visible) fail('no 3D ball on the board');
  if (ball.dx > 0.6 || ball.dy > 0.6) fail(`3D ball is off its 2D position by (${ball.dx.toFixed(2)}, ${ball.dy.toFixed(2)})px`);
  if (Math.abs(ball.radius - ball.expectedRadius) > 0.01) fail(`3D ball radius ${ball.radius} != 2D ${ball.expectedRadius}`);
  console.log(`  ball tracks its 2D position within ${Math.max(ball.dx, ball.dy).toFixed(2)}px, r=${ball.radius.toFixed(1)}`);

  // --- play a shot: the ball must fly, and a figure must appear in 3D --------------
  const played = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const o = window.zonkeActors;
    for (let i = 0; i < 200 && !(s.ready && s.activeIndex === 0); i++) await new Promise((r) => setTimeout(r, 100));
    s.launchWithPower(0.55);
    let minY = 1e9;
    let moved = false;
    for (let i = 0; i < 300; i++) {
      const mesh = o.ballMeshes[0];
      minY = Math.min(minY, s.actorLayout().canvasH - mesh.position.y);
      if (s.flying) moved = true;
      if (!s.flying && moved) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 1200));
    const figures = s.actorFigures();
    const visibleParts = o.figures.flat().reduce((n, f) => n + f.parts.filter((p) => p.visible).length, 0);
    const shownGroups = o.figures.flat().filter((f) => f.group.visible).length;
    return { moved, minY, figures: figures.length, visibleParts, shownGroups, expectedParts: figures.reduce((n, f) => n + f.parts, 0) };
  });
  console.log(`  shot: flew=${played.moved} peakY=${Math.round(played.minY)} figures=${played.figures} parts=${played.visibleParts}`);
  if (!played.moved) fail('the ball never flew');
  if (played.minY > layout3d.ballRestY - layout3d.rowH) fail('the 3D ball did not follow the shot up the board');
  if (played.figures === 0) fail('no figure was earned by the landing');
  if (played.visibleParts !== played.expectedParts) fail(`3D shows ${played.visibleParts} parts, the board says ${played.expectedParts}`);
  if (played.shownGroups !== played.figures) fail(`${played.shownGroups} figures shown, ${played.figures} expected`);

  // --- a figure stands on its own row, in its own margin ---------------------------
  const placement = await page.evaluate(() => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const o = window.zonkeActors;
    const l = s.actorLayout();
    const f = s.actorFigures()[0];
    const node = o.figures[f.slot][f.side];
    const expectedY = l.logTop + f.slot * l.rowH + l.rowH / 2;
    return {
      side: f.side,
      dx: Math.abs(node.group.position.x - l.figureX[f.side]),
      dy: Math.abs(l.canvasH - node.group.position.y - expectedY),
    };
  });
  if (placement.dx > 0.6 || placement.dy > 0.6) {
    fail(`figure off its 2D spot by (${placement.dx.toFixed(2)}, ${placement.dy.toFixed(2)})px`);
  } else console.log(`  figure sits on its row centre within ${Math.max(placement.dx, placement.dy).toFixed(2)}px`);

  // --- a split puts several 3D balls on the board ----------------------------------
  const split = await page.evaluate(async () => {
    const s = window.zonkeGame.scene.getScene('ZonkeScene');
    const o = window.zonkeActors;
    for (let i = 0; i < 200 && !(s.ready && s.activeIndex === 0); i++) await new Promise((r) => setTimeout(r, 100));
    s.splitRow = s.rowSlotAt(s.restingYFor(0.5));
    s.launchWithPower(0.5);
    let peakMeshes = 0;
    let peakBalls = 0;
    for (let i = 0; i < 400; i++) {
      peakBalls = Math.max(peakBalls, s.actorBalls().length);
      peakMeshes = Math.max(peakMeshes, o.ballMeshes.filter((m) => m.visible).length);
      if (!s.flying && peakBalls > 1) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    return { peakBalls, peakMeshes };
  });
  console.log(`  split: ${split.peakBalls} balls, ${split.peakMeshes} meshes`);
  if (split.peakBalls < 3) fail(`no split (peak ${split.peakBalls})`);
  if (split.peakMeshes !== split.peakBalls) fail(`${split.peakBalls} balls but ${split.peakMeshes} meshes drawn`);

  await page.screenshot({ path: `${OUT}/actors-${label}-3d.png` });
  if (errors.length) fail('console errors: ' + errors.join(' | '));
  await page.close();
}

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
