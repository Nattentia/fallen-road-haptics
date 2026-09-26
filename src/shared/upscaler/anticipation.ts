import { PART_LIMITS, type Shape } from './parts';
import type { ScoreEvent } from './contract';

/**
 * Anticipation (v4 6, 8; plan unit 6-2): a moment the game announced ahead
 * (clock `expect`) is prepared, never delayed.
 * - tension: sparse grains that close in and grow while it approaches, for
 *   moments that matter;
 * - rest: the upscale layer goes quiet just before it (lighter voices are
 *   pushed back) so the moment lands on contrast.
 * The result itself plays the instant it arrives and replaces the tension.
 * Numbers are first guesses, to be tuned on a device (S5).
 */
export const ANTICIPATION = {
  /** Expected moments below this importance get neither tension nor rest. */
  minImportance: 0.6,
  /** Silence of the upscale layer just before the expected moment. */
  restMs: 120,
  /** Lighter voices keep this share of their strength during the rest. */
  restGain: 0.25,
  /** Tension needs at least this much time before the rest. */
  minTensionMs: 100,
  /** First gap between tension grains, and how each gap shrinks. */
  firstGapMs: 140,
  accel: 0.82,
  minGapMs: 35,
  /** Tension grain strength: from `floor` up to `floor + reach × importance`. */
  floor: 0.1,
  reach: 0.2,
  /** Never stronger than this: tension must stay below the moment itself. */
  peak: 0.3,
  sharpness: 0.45,
};

const clamp = (x: number, lo = 0, hi = 1): number =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;

/** Grains over `spanMs` (ending at the rest) for a moment of `importance`. */
export const tension = (spanMs: number, importance: number): Shape => {
  const A = ANTICIPATION;
  if (spanMs < A.minTensionMs) return { events: [], curves: [] };
  // Lay the gaps backwards from the end so the closest grains sit next to
  // the rest, whatever the window's length. Whole-ms gaps keep the order.
  const end = Math.floor(spanMs);
  const times: number[] = [];
  let t = end;
  let gap = Math.max(A.minGapMs, PART_LIMITS.grainMinIntervalMs);
  while (t >= 0 && times.length < PART_LIMITS.maxGrains) {
    times.unshift(t);
    t -= gap;
    gap = Math.min(A.firstGapMs, Math.ceil(gap / A.accel));
  }
  const top = Math.min(A.peak, A.floor + A.reach * clamp(importance));
  const events: ScoreEvent[] = times.map((at) => ({
    kind: 'transient',
    t: at,
    intensity: clamp(A.floor + (top - A.floor) * (at / end)),
    sharpness: A.sharpness,
  }));
  return { events, curves: [] };
};
