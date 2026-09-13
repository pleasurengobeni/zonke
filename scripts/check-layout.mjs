// Responsive layout regression check: loads the game in real Chromium at a matrix of
// device sizes and verifies (a) no structural overflow/canvas mismatch and (b) no runtime
// errors. This exists because the responsive layout has broken in ways pure formula review
// and physics simulation both missed - text clipping and z-order bugs only show up when the
// page actually renders. Run with `npm run test:layout` against a running dev server.
import { chromium } from 'playwright';

const URL = process.env.LAYOUT_TEST_URL ?? 'http://localhost:5173/';

const devices = [
  ['smallest_phone',   320,  568],
  ['iphone_se',        375,  667],
  ['iphone_15',        390,  844],
  ['iphone_15_pro_max',430,  932],
  ['iphone_landscape', 932,  430],
  ['small_android',    360,  740],
  ['ipad_portrait',    768, 1024],
  ['ipad_landscape',  1024,  768],
  ['laptop',          1366,  768],
  ['desktop',         1920, 1080],
  ['ultrawide',        2560, 1080],
];

const browser = await chromium.launch();
let failed = false;

for (const [name, w, h] of devices) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const metrics = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const rect = canvas ? canvas.getBoundingClientRect() : null;
    return {
      docScrollW: document.documentElement.scrollWidth,
      docScrollH: document.documentElement.scrollHeight,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      canvasRect: rect ? { w: rect.width, h: rect.height } : null,
    };
  });

  const overflowX = metrics.docScrollW > metrics.innerW + 1;
  const overflowY = metrics.docScrollH > metrics.innerH + 1;
  const canvasMismatch =
    !metrics.canvasRect ||
    Math.abs(metrics.canvasRect.w - metrics.innerW) > 2 ||
    Math.abs(metrics.canvasRect.h - metrics.innerH) > 2;

  const ok = !overflowX && !overflowY && !canvasMismatch && errors.length === 0;
  if (!ok) failed = true;

  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${String(w + 'x' + h).padEnd(11)}` +
      (overflowX ? ' overflowX' : '') +
      (overflowY ? ' overflowY' : '') +
      (canvasMismatch ? ' canvasMismatch' : '') +
      (errors.length ? ` errors:${errors.join(' | ')}` : '')
  );

  await page.close();
}

await browser.close();
if (failed) process.exit(1);
