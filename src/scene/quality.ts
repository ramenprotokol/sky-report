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
  /** Time-weighted median frame interval above this steps quality down (ms). */
  downMs: number;
  /** On the cheapest tier, a median above this (under 20 frames a second) gives up on animation: still mode. */
  stillMs: number;
  /** A measurement window closes after this many frames… */
  window: number;
  /** …or once it spans this much time (ms), so a slow GPU is judged in seconds, not minutes… */
  windowMs: number;
  /** …but never with fewer frames than this, so one long frame can't decide anything. */
  minWindow: number;
  /** Frames ignored after any change (shader warm-up, resize)… */
  warmup: number;
  /** …or fewer, once this much time (ms) has passed and at least `minWarmup` frames were skipped. */
  warmupMs: number;
  minWarmup: number;
  /** A frame longer than this that follows a normal frame is a hitch; one per window is ignored. */
  hitchMs: number;
  /** Consecutive windows that keep up with the display before stepping up. */
  upWindows: number;
  /**
   * "Keeping up with the display": the median interval is within this factor of the fastest
   * intervals seen. rAF is paced by the display, so the interval can never drop below its refresh
   * period (16.7 ms at 60 Hz); an absolute threshold under that could never be met.
   */
  upSlack: number;
}

export const DEFAULT_CONTROLLER: ControllerOptions = {
  downMs: 24,
  stillMs: 50,
  window: 30,
  windowMs: 1500,
  minWindow: 3,
  warmup: 12,
  warmupMs: 400,
  minWarmup: 2,
  hitchMs: 250,
  upWindows: 4,
  upSlack: 1.12,
};

/** What the controller asks the renderer to do. */
export type Decision = { kind: 'tier'; index: number } | { kind: 'still' };

/**
 * Watches frame intervals and suggests tier changes. It steps down while the median frame is
 * slow, one tier per window. If the cheapest tier is still too slow to animate, it asks for still
 * mode (render only when something changes). It steps up only into tiers that have never been
 * too slow, so it cannot oscillate.
 */
export class TierController {
  index: number;
  private opts: ControllerOptions;
  private samples: number[] = [];
  private sampleTime = 0;
  private skipLeft: number;
  private skipped = 0;
  private skippedTime = 0;
  private lastRaw = 0;
  private hitchDropped = false;
  private fastWindows = 0;
  /** Fastest intervals seen: an estimate of the display's refresh period. */
  private refreshMs = Infinity;
  /** Lowest-quality index that has proven too slow from above: never go above (lower index than) this again. */
  private ceiling = 0;
  locked = false;
  /** Set once the cheapest tier proved too slow to animate. */
  gaveUp = false;

  constructor(startIndex: number, opts: ControllerOptions = DEFAULT_CONTROLLER) {
    this.index = Math.min(TIERS.length - 1, Math.max(0, startIndex));
    this.opts = opts;
    this.skipLeft = opts.warmup;
  }

  get tier(): Tier {
    return TIERS[this.index]!;
  }

  /** A manual choice turns the automatic controller off. */
  lock(index: number): void {
    this.index = Math.min(TIERS.length - 1, Math.max(0, index));
    this.locked = true;
  }

  /** Back to automatic. It keeps what it learned (the ceiling), but may try animating again. */
  unlock(): void {
    this.locked = false;
    this.gaveUp = false;
    this.reset();
  }

  /** Start a fresh measurement: after a resize, a tier change, or the tab becoming visible again. */
  reset(): void {
    this.samples = [];
    this.sampleTime = 0;
    this.skipLeft = this.opts.warmup;
    this.skipped = 0;
    this.skippedTime = 0;
    this.lastRaw = 0;
    this.hitchDropped = false;
    this.fastWindows = 0;
  }

  /** Feed one frame interval in ms. Returns a decision when something should change, else null. */
  sample(frameMs: number): Decision | null {
    if (this.locked || this.gaveUp) return null;
    if (!Number.isFinite(frameMs) || frameMs <= 0) return null;
    const o = this.opts;

    if (this.skipLeft > 0) {
      this.skipped += 1;
      this.skippedTime += frameMs;
      this.skipLeft -= 1;
      if (this.skipped >= o.minWarmup && this.skippedTime >= o.warmupMs) this.skipLeft = 0;
      return null;
    }

    // One isolated long frame (after a normal one) is a hitch: garbage collection, a page
    // re-layout. A second long frame in the same window, or a run of them, is real.
    const prev = this.lastRaw;
    this.lastRaw = frameMs;
    if (frameMs > o.hitchMs && prev > 0 && prev <= o.hitchMs && !this.hitchDropped) {
      this.hitchDropped = true;
      return null;
    }

    this.samples.push(frameMs);
    this.sampleTime += frameMs;
    const full = this.samples.length >= o.window || (this.samples.length >= o.minWindow && this.sampleTime >= o.windowMs);
    if (!full) return null;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = timeMedian(sorted, this.sampleTime);
    const fast = sorted[Math.floor(sorted.length / 10)]!;
    this.refreshMs = Math.min(this.refreshMs, fast);
    this.samples = [];
    this.sampleTime = 0;
    this.hitchDropped = false;

    if (median > o.downMs) {
      this.fastWindows = 0;
      if (this.index < TIERS.length - 1) {
        this.ceiling = Math.max(this.ceiling, this.index + 1);
        this.index += 1;
        this.startWarmup();
        return { kind: 'tier', index: this.index };
      }
      if (median > o.stillMs) {
        this.gaveUp = true;
        return { kind: 'still' };
      }
      return null;
    }
    if (median <= this.refreshMs * o.upSlack && this.index > this.ceiling) {
      this.fastWindows += 1;
      if (this.fastWindows >= o.upWindows) {
        this.index -= 1;
        this.fastWindows = 0;
        this.startWarmup();
        return { kind: 'tier', index: this.index };
      }
    } else {
      this.fastWindows = 0;
    }
    return null;
  }

  private startWarmup(): void {
    this.skipLeft = this.opts.warmup;
    this.skipped = 0;
    this.skippedTime = 0;
    this.lastRaw = 0;
  }
}

/**
 * The time-weighted median of sorted frame intervals: half of the window's wall time was spent in
 * frames at least this long. A few slow frames among many fast ones are what a viewer sees most of
 * the time, so they must not be outvoted by frame count.
 */
export function timeMedian(sorted: readonly number[], total: number): number {
  let acc = 0;
  for (const ms of sorted) {
    acc += ms;
    if (acc >= total / 2) return ms;
  }
  return sorted.at(-1) ?? 0;
}

/** First guess before any frame is measured: phones and small screens start lower. */
export function initialTierIndex(env: { coarsePointer: boolean; cssPixels: number; saveData: boolean }): number {
  if (env.saveData) return 3;
  if (env.coarsePointer) return 2;
  if (env.cssPixels > 2_500_000) return 2;
  return 1;
}

/** Median of recent frame intervals as frames per second, for the quality label. */
export function framesPerSecond(intervalsMs: readonly number[]): number | null {
  if (intervalsMs.length === 0) return null;
  const sorted = [...intervalsMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return median > 0 ? 1000 / median : null;
}
