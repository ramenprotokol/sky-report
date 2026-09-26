/**
 * Where the sky is dimmed so text stays readable. Each block of text (the chart label, the
 * readout, the ICAO bar) gets one broad squircle-shaped falloff, anchored to the corner or edge
 * of the frame the block sits against. The shader keeps the full brightness cap inside the
 * squircle (radius 1) and fades it out, in stops, by radius 2, so it reads as a window vignette.
 * A block wider than most of the screen becomes a band along its edge.
 * Pure functions, unit-tested.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** CSS pixels, y down: centre and radii of the squircle |x/rx|³ + |y/ry|³ = 1. */
export interface Block {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export type Anchor = 'top-left' | 'bottom-left' | 'centre';

export const SQUIRCLE_P = 3;
/**
 * A point (a, b) from the centre lies on the squircle with radii (k·a, k·b) when 2/k³ = 1,
 * so k = 2^⅓ puts the box's far corner exactly on the full-strength boundary.
 */
export const SQUIRCLE_K = Math.pow(2, 1 / SQUIRCLE_P);
/** The shader fades the cap out between radius 1 and this. */
export const FADE_TO = 2;
/** A corner block reaching past this fraction of the screen width becomes a full-width band. */
export const BAND_FRACTION = 0.6;

export function union(boxes: readonly Box[]): Box | null {
  const real = boxes.filter((b) => b.right > b.left && b.bottom > b.top);
  if (real.length === 0) return null;
  return {
    left: Math.min(...real.map((b) => b.left)),
    top: Math.min(...real.map((b) => b.top)),
    right: Math.max(...real.map((b) => b.right)),
    bottom: Math.max(...real.map((b) => b.bottom)),
  };
}

export function blockFor(box: Box, anchor: Anchor, viewport: { width: number; height: number }, margin = 10): Block {
  const k = SQUIRCLE_K;
  // A band: so wide that across the screen only the vertical distance matters.
  const band = box.right > BAND_FRACTION * viewport.width;
  const rx = band ? 100 * viewport.width : k * (Math.max(0, box.right) + margin);
  const ky = band ? 1 : k;
  if (anchor === 'top-left') {
    return { cx: 0, cy: 0, rx, ry: ky * (Math.max(0, box.bottom) + margin) };
  }
  if (anchor === 'bottom-left') {
    return { cx: 0, cy: viewport.height, rx, ry: ky * (Math.max(0, viewport.height - box.top) + margin) };
  }
  return {
    cx: (box.left + box.right) / 2,
    cy: (box.top + box.bottom) / 2,
    rx: k * ((box.right - box.left) / 2 + margin),
    ry: k * ((box.bottom - box.top) / 2 + margin),
  };
}

/** The squircle radius of a point for a block: ≤ 1 means full dimming, ≥ FADE_TO means none. */
export function blockRadius(b: Block, x: number, y: number): number {
  const dx = Math.abs(x - b.cx) / Math.max(1, b.rx);
  const dy = Math.abs(y - b.cy) / Math.max(1, b.ry);
  return Math.pow(dx ** SQUIRCLE_P + dy ** SQUIRCLE_P, 1 / SQUIRCLE_P);
}

/** How much of the brightness cap applies at a point (1 = all of it), as the shader computes it. */
export function blockMask(b: Block, x: number, y: number): number {
  const t = Math.min(1, Math.max(0, (blockRadius(b, x, y) - 1) / (FADE_TO - 1)));
  return 1 - t * t * (3 - 2 * t);
}
