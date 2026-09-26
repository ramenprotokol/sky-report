// Measures how much of the ground a report's clouds cover, seen straight up from below, using the
// page's ?probe=below test hook (an orthographic upward view that writes cloud opacity). A pixel
// counts as cloud when its opacity is over COVER_OPACITY. Used by the smoke test and by
// scripts/calibrate-cover.mjs.
import { decodePng } from '../tests/smoke/png.mjs';
import { sleep } from './cdp.mjs';

/** Opacity above which a pixel counts as cloud: clearly visible, even for thin cirrus. */
export const COVER_OPACITY = 0.2;
/** Width of the ground square, km. Large, so a few of the widest (cirrus) noise periods average out. */
export const PROBE_SPAN_KM = 480;

export async function measureCover(browser, base, metar, { rawcover = null, span = PROBE_SPAN_KM } = {}) {
  const raw = rawcover === null ? '' : `&rawcover=${rawcover}`;
  await browser.goto(`${base}?metar=${encodeURIComponent(metar)}&still=1&notext=1&q=high&probe=below&span=${span}${raw}`);
  await sleep(100);
  const img = decodePng(await browser.screenshot());
  const threshold = Math.round(COVER_OPACITY * 255);
  let cloud = 0;
  for (let i = 0; i < img.width * img.height; i++) if (img.data[i * img.bpp] > threshold) cloud++;
  return cloud / (img.width * img.height);
}
