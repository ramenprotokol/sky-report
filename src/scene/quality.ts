/**
 * Quality tiers and the automatic fallback. The shader cost is roughly
 * pixels × ray-march steps × light steps, so each tier trims all three.
 */

export interface Tier {
  name: 'high' | 'medium' | 'low' | 'minimal';
  /** Fraction of the device-pixel canvas actually rendered; the browser scales it up. */
  scale: number;
  /** Upper bound on devicePixelRatio used for the canvas. */
  maxDpr: number;
  /** Ray-march steps per cloud layer. */
  steps: number;
  /** Steps toward the sun for self-shadowing. */
  lightSteps: number;
  /** Single-scattering samples for the clear-sky colour. */
  skySteps: number;
}

export const TIERS: readonly Tier[] = [
  { name: 'high', scale: 1, maxDpr: 2, steps: 64, lightSteps: 6, skySteps: 12 },
  { name: 'medium', scale: 0.75, maxDpr: 1.5, steps: 44, lightSteps: 5, skySteps: 10 },
  { name: 'low', scale: 0.55, maxDpr: 1.5, steps: 30, lightSteps: 4, skySteps: 8 },
  { name: 'minimal', scale: 0.4, maxDpr: 1, steps: 20, lightSteps: 3, skySteps: 6 },
];

export function tierIndex(name: string | null | undefined): number {
  const i = TIERS.findIndex((t) => t.name === name);
  return i;
}

/** Canvas backing size for a CSS size, a device pixel ratio and a tier. */
export function backingSize(cssW: number, cssH: number, dpr: number, tier: Tier): { w: number; h: number } {
  const k = Math.min(dpr || 1, tier.maxDpr) * tier.scale;
  return { w: Math.max(1, Math.round(cssW * k)), h: Math.max(1, Math.round(cssH * k)) };
}

export interface ControllerOptions {
  /** Median frame time above this steps quality down (ms). */
  downMs: number;
  /** Median frame time below this, sustained, allows one step up (ms). */
  upMs: number;
  /** Frames per measurement window. */
  window: number;
  /** Frames ignored after any change (shader warm-up, resize). */
  warmup: number;
  /** Consecutive fast windows needed before stepping up. */
  upWindows: number;
}

export const DEFAULT_CONTROLLER: ControllerOptions = { downMs: 24, upMs: 13, window: 30, warmup: 12, upWindows: 4 };

/**
 * Watches frame times and suggests tier changes. It steps down when the median frame is
 * slow, and steps up only into tiers that have never been too slow, so it cannot oscillate.
 */
export class TierController {
  index: number;
  private opts: ControllerOptions;
  private samples: number[] = [];
  private skip: number;
  private fastWindows = 0;
  /** Lowest-quality index that has proven too slow from above: never go above (lower index than) this again. */
  private ceiling = 0;
  locked = false;

  constructor(startIndex: number, opts: ControllerOptions = DEFAULT_CONTROLLER) {
    this.index = Math.min(TIERS.length - 1, Math.max(0, startIndex));
    this.opts = opts;
    this.skip = opts.warmup;
  }

  get tier(): Tier {
    return TIERS[this.index]!;
  }

  /** A manual choice turns the automatic controller off. */
  lock(index: number): void {
    this.index = Math.min(TIERS.length - 1, Math.max(0, index));
    this.locked = true;
  }

  reset(): void {
    this.samples = [];
    this.skip = this.opts.warmup;
    this.fastWindows = 0;
  }

  /** Feed one frame time in ms. Returns the new tier index when it changes, else null. */
  sample(frameMs: number): number | null {
    if (this.locked) return null;
    // Ignore paused tabs and one-off hitches.
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 250) return null;
    if (this.skip > 0) {
      this.skip -= 1;
      return null;
    }
    this.samples.push(frameMs);
    if (this.samples.length < this.opts.window) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    this.samples = [];

    if (median > this.opts.downMs && this.index < TIERS.length - 1) {
      this.ceiling = Math.max(this.ceiling, this.index + 1);
      this.index += 1;
      this.fastWindows = 0;
      this.skip = this.opts.warmup;
      return this.index;
    }
    if (median < this.opts.upMs && this.index > this.ceiling) {
      this.fastWindows += 1;
      if (this.fastWindows >= this.opts.upWindows) {
        this.index -= 1;
        this.fastWindows = 0;
        this.skip = this.opts.warmup;
        return this.index;
      }
    } else {
      this.fastWindows = 0;
    }
    return null;
  }
}

/** First guess before any frame is measured: phones and small screens start lower. */
export function initialTierIndex(env: { coarsePointer: boolean; cssPixels: number; saveData: boolean }): number {
  if (env.saveData) return 3;
  if (env.coarsePointer) return 2;
  if (env.cssPixels > 2_500_000) return 2;
  return 1;
}
