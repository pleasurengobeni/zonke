// The engine must be reproducible: two Match instances, same seed, same shots in the same
// order, must produce byte-identical matches. Online play is built entirely on this - only
// the power of each shot crosses the network, and everything else (wall bounces, splits,
// which rows turn gold) is reproduced on both sides rather than transmitted.
//
// Run against the dev server, which serves the TypeScript module directly.
import { chromium } from 'playwright';

const BASE = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  page error: ' + e));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const { Match, MODES, seededRng } = await import('/src/zonke/Match.ts');

  /** Plays a fixed script of shots against a fresh engine and returns its whole history. */
  const play = (seed, powers) => {
    const match = new Match(MODES[1], 'A', {}, { rng: seededRng(seed), cpu: false, opponentName: 'B' });
    const digests = [];
    for (const power of powers) {
      // Wait for the engine to be ready, stepping in fixed frames as a renderer would.
      for (let i = 0; i < 2000 && !match.canShoot; i++) match.update(16.7);
      match.fireShot(power);
      for (let i = 0; i < 2000; i++) {
        match.update(16.7);
        if (match.canShoot || match.phase === 'over') break;
      }
      digests.push(match.stateDigest());
      if (match.phase === 'over') break;
    }
    return digests;
  };

  const powers = [0.42, 1.31, 0.77, 0.95, 1.52, 0.18, 0.64, 1.1, 0.88, 0.5, 1.4, 0.3];
  const a = play(987654321, powers);
  const b = play(987654321, powers);
  const different = play(123456789, powers);

  const firstMismatch = a.findIndex((d, i) => d !== b[i]);
  return {
    shots: a.length,
    identical: firstMismatch === -1,
    firstMismatch,
    mismatchA: firstMismatch >= 0 ? a[firstMismatch].slice(0, 200) : null,
    mismatchB: firstMismatch >= 0 ? b[firstMismatch].slice(0, 200) : null,
    // A different seed must actually produce a different match, or the test proves nothing.
    seedMatters: different.some((d, i) => d !== a[i]),
    finalA: a[a.length - 1].slice(0, 120),
  };
});

let failed = false;
console.log(`  replayed ${result.shots} shots`);
if (!result.identical) {
  failed = true;
  console.log(`  FAIL engines diverged at shot ${result.firstMismatch}`);
  console.log(`    A: ${result.mismatchA}`);
  console.log(`    B: ${result.mismatchB}`);
} else {
  console.log('  two engines, same seed and shots -> identical state throughout');
}
if (!result.seedMatters) {
  failed = true;
  console.log('  FAIL a different seed produced the same match, so the check is vacuous');
} else {
  console.log('  a different seed produces a different match (the control)');
}

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
