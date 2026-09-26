import type { ScoreCurve, ScoreEvent } from './contract';

/**
 * The part library: small vibration shapes built only from general values
 * (intensity, sharpness, lengths, counts). Phrases are made by combining
 * parts; each part becomes its own score so its curves never reshape
 * another part.
 *
 * Numbers marked "hypothesis" are fixed after the S1 device session.
 */

export type Shape = { events: ScoreEvent[]; curves: ScoreCurve[] };

export const PART_LIMITS = {
  /** Closest two grains may be and still read as separate (hypothesis, S1). */
  grainMinIntervalMs: 12,
  maxGrains: 24,
  /** A curve returns to neutral this long after the event it shapes. */
  neutralGapMs: 1,
};

const clamp = (x: number, lo = 0, hi = 1): number =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;

const empty = (): Shape => ({ events: [], curves: [] });

/** Moves a shape later by `dt` ms. */
export const shift = (s: Shape, dt: number): Shape => ({
  events: s.events.map((e) => ({ ...e, t: e.t + dt })),
  curves: s.curves.map((c) => ({
    ...c,
    points: c.points.map((p) => ({ ...p, t: p.t + dt })),
  })),
});

/** Where a shape's last event ends. */
export const lengthOf = (s: Shape): number =>
  s.events.reduce(
    (end, e) => Math.max(end, e.t + (e.kind === 'continuous' ? e.duration : 0)),
    0
  );

// ---------------------------------------------------------------------------
// Grains: a chain of light taps (roughness, debris, tension)
// ---------------------------------------------------------------------------

export type GrainsSpec = {
  count: number;
  intervalMs: number;
  intensity: number;
  sharpness: number;
  /** Intensity of the last grain relative to the first (1 = even). */
  fade: number;
  /** Each gap is the previous gap times this (1 = even, <1 speeds up). */
  accel: number;
};

export const grains = (spec: GrainsSpec): Shape => {
  const count = Math.round(clamp(spec.count, 0, PART_LIMITS.maxGrains));
  if (count === 0 || spec.intensity <= 0) return empty();
  const accel = clamp(spec.accel, 0.5, 2);
  const events: ScoreEvent[] = [];
  let t = 0;
  let gap = Math.max(PART_LIMITS.grainMinIntervalMs, spec.intervalMs);
  for (let i = 0; i < count; i++) {
    const ratio =
      count === 1 ? 1 : 1 + (clamp(spec.fade) - 1) * (i / (count - 1));
    events.push({
      kind: 'transient',
      t,
      intensity: clamp(spec.intensity * ratio),
      sharpness: clamp(spec.sharpness),
    });
    t += gap;
    gap = Math.max(PART_LIMITS.grainMinIntervalMs, gap * accel);
  }
  return { events, curves: [] };
};

// ---------------------------------------------------------------------------
// Glide: a continuous vibration whose sharpness travels (texture change)
// ---------------------------------------------------------------------------

export type GlideSpec = {
  durationMs: number;
  intensity: number;
  from: number;
  to: number;
};

export const glide = (spec: GlideSpec): Shape => {
  const duration = Math.max(1, spec.durationMs);
  if (spec.intensity <= 0) return empty();
  const from = clamp(spec.from);
  const to = clamp(spec.to);
  return {
    events: [
      {
        kind: 'continuous',
        t: 0,
        duration,
        intensity: clamp(spec.intensity),
        sharpness: from,
      },
    ],
    curves: [
      {
        control: 'sharpness',
        points: [
          { t: 0, value: 0 },
          { t: duration, value: to - from },
          { t: duration + PART_LIMITS.neutralGapMs, value: 0 },
        ],
      },
    ],
  };
};

// ---------------------------------------------------------------------------
// Strike: a tap with a body that dies away (impact and its mass)
// ---------------------------------------------------------------------------

export type StrikeSpec = {
  intensity: number;
  /** Sharpness of the tap: hardness. */
  sharpness: number;
  /** Body length: weight. 0 for a bare tap. */
  bodyMs: number;
  bodyIntensity: number;
  bodySharpness: number;
};

export const strike = (spec: StrikeSpec): Shape => {
  const events: ScoreEvent[] = [];
  const curves: ScoreCurve[] = [];
  if (spec.intensity > 0)
    events.push({
      kind: 'transient',
      t: 0,
      intensity: clamp(spec.intensity),
      sharpness: clamp(spec.sharpness),
    });
  const body = Math.max(0, spec.bodyMs);
  if (body > 0 && spec.bodyIntensity > 0) {
    events.push({
      kind: 'continuous',
      t: 0,
      duration: body,
      intensity: clamp(spec.bodyIntensity),
      sharpness: clamp(spec.bodySharpness),
    });
    // Fast fall then a long tail, like a struck object ringing out.
    curves.push({
      control: 'intensity',
      points: [
        { t: 0, value: 1 },
        { t: body * 0.25, value: 0.55 },
        { t: body, value: 0 },
        { t: body + PART_LIMITS.neutralGapMs, value: 1 },
      ],
    });
  }
  return { events, curves };
};

// ---------------------------------------------------------------------------
// Swell: rises and falls away (charge, collapse, wobble)
// ---------------------------------------------------------------------------

export type SwellSpec = {
  durationMs: number;
  peak: number;
  sharpness: number;
  /** Share of the length spent rising (0..1). */
  attack: number;
  /** Wobble frequency; 0 for a smooth swell. */
  wobbleHz: number;
  /** Wobble depth 0..1 (how far it dips each cycle). */
  wobbleDepth: number;
};

export const swell = (spec: SwellSpec): Shape => {
  const duration = Math.max(2, spec.durationMs);
  if (spec.peak <= 0) return empty();
  const attack = clamp(spec.attack, 0.05, 0.95) * duration;
  const envelope = (t: number) =>
    t <= attack ? t / attack : 1 - (t - attack) / (duration - attack);
  // Room for the rise, the peak, the fall and the return to neutral.
  const budget = 14;
  const depth = clamp(spec.wobbleDepth);
  const hz = Math.max(0, spec.wobbleHz);
  const steps = hz > 0 && depth > 0 ? budget - 2 : 2;
  const times = new Set<number>([0, attack, duration]);
  for (let i = 1; i < steps; i++) times.add((duration * i) / steps);
  const points = [...times]
    .sort((a, b) => a - b)
    .map((t) => {
      const wobble =
        hz > 0
          ? 1 - depth * 0.5 * (1 - Math.cos((2 * Math.PI * hz * t) / 1000))
          : 1;
      return { t, value: clamp(envelope(t) * wobble) };
    });
  points.push({ t: duration + PART_LIMITS.neutralGapMs, value: 1 });
  return {
    events: [
      {
        kind: 'continuous',
        t: 0,
        duration,
        intensity: clamp(spec.peak),
        sharpness: clamp(spec.sharpness),
      },
    ],
    curves: [{ control: 'intensity', points }],
  };
};

// ---------------------------------------------------------------------------
// Bounce: taps that come back smaller and sooner (rebound, recoil)
// ---------------------------------------------------------------------------

export type BounceSpec = {
  count: number;
  intensity: number;
  sharpness: number;
  firstGapMs: number;
  /** Each rebound's intensity and gap relative to the previous one. */
  ratio: number;
};

export const bounce = (spec: BounceSpec): Shape => {
  const count = Math.round(clamp(spec.count, 0, 6));
  if (count === 0 || spec.intensity <= 0) return empty();
  const ratio = clamp(spec.ratio, 0.2, 0.95);
  const events: ScoreEvent[] = [];
  let t = 0;
  let gap = Math.max(PART_LIMITS.grainMinIntervalMs, spec.firstGapMs);
  let level = clamp(spec.intensity);
  for (let i = 0; i < count; i++) {
    events.push({
      kind: 'transient',
      t,
      intensity: level,
      sharpness: clamp(spec.sharpness),
    });
    t += gap;
    gap = Math.max(PART_LIMITS.grainMinIntervalMs, gap * ratio);
    level *= ratio;
  }
  return { events, curves: [] };
};

// ---------------------------------------------------------------------------
// Rest: deliberate silence of the upscale layer (contrast before a big hit)
// ---------------------------------------------------------------------------

/** Silence has no events; its length is carried by the phrase timing. */
export const rest = (): Shape => empty();
