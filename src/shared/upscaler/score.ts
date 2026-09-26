import type { CurvePoint, Score, ScoreEvent } from './contract';

/**
 * Score helpers and AHAP export. A score maps 1:1 onto an AHAP pattern; when
 * several scores are merged onto one time axis their curves are baked into
 * the events first, because a curve acts on every event of its pattern.
 */

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** Value of a curve at `t`: neutral before it starts, held after it ends. */
export const curveValueAt = (
  points: readonly CurvePoint[],
  t: number,
  neutral: number
): number => {
  const first = points[0];
  if (!first || t < first.t) return neutral;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (t <= b.t) {
      const span = b.t - a.t;
      return span > 0
        ? a.value + ((t - a.t) / span) * (b.value - a.value)
        : b.value;
    }
  }
  return points[points.length - 1]!.value;
};

/** Where the last event of a score ends, relative to its zero. */
export const endOf = (s: Score): number =>
  s.events.reduce(
    (end, e) => Math.max(end, e.t + (e.kind === 'continuous' ? e.duration : 0)),
    0
  );

/** Scales every event's intensity; shape and timing stay fixed. */
export const scaleScore = (s: Score, gain: number): Score => ({
  ...s,
  events: s.events.map((e) => ({
    ...e,
    intensity: clamp(e.intensity * gain, 0, 1),
  })),
});

/** Intensity multiplier and sharpness offset the score's curves give at `t`. */
const controlsAt = (s: Score, t: number): { gain: number; shift: number } => {
  let gain = 1;
  let shift = 0;
  for (const c of s.curves) {
    if (c.control === 'intensity') gain *= curveValueAt(c.points, t, 1);
    else shift += curveValueAt(c.points, t, 0);
  }
  return { gain, shift };
};

const shaped = <E extends ScoreEvent>(e: E, s: Score, t: number): E => {
  const { gain, shift } = controlsAt(s, t);
  return {
    ...e,
    intensity: clamp(e.intensity * gain, 0, 1),
    sharpness: clamp(e.sharpness + shift, 0, 1),
  };
};

/**
 * The same score without curves: transients take the curve value at their
 * time, continuous events are cut into `stepMs` pieces that each take the
 * value at their middle.
 */
export const bakeCurves = (s: Score, stepMs = 10): Score => {
  if (s.curves.length === 0) return s;
  const events: ScoreEvent[] = [];
  for (const e of s.events) {
    if (e.kind === 'transient') {
      events.push(shaped(e, s, e.t));
      continue;
    }
    const end = e.t + e.duration;
    for (let t = e.t; t < end - 1e-9; t += stepMs) {
      const duration = Math.min(stepMs, end - t);
      events.push(shaped({ ...e, t, duration }, s, t + duration / 2));
    }
  }
  return { ...s, events, curves: [] };
};

// ---------------------------------------------------------------------------
// AHAP
// ---------------------------------------------------------------------------

type AhapParameter = { ParameterID: string; ParameterValue: number };
export type AhapEvent = {
  Event: {
    Time: number;
    EventType: 'HapticTransient' | 'HapticContinuous';
    EventDuration?: number;
    EventParameters: AhapParameter[];
  };
};
export type AhapCurve = {
  ParameterCurve: {
    ParameterID: 'HapticIntensityControl' | 'HapticSharpnessControl';
    Time: number;
    ParameterCurveControlPoints: { Time: number; ParameterValue: number }[];
  };
};
export type Ahap = { Version: 1; Pattern: (AhapEvent | AhapCurve)[] };

/** ms → s, rounded to the microsecond so files stay readable. */
const sec = (ms: number): number => Math.round(ms * 1000) / 1_000_000;

const ahapEvent = (e: ScoreEvent, offsetMs: number): AhapEvent => ({
  Event: {
    Time: sec(e.t + offsetMs),
    EventType: e.kind === 'transient' ? 'HapticTransient' : 'HapticContinuous',
    ...(e.kind === 'continuous' ? { EventDuration: sec(e.duration) } : {}),
    EventParameters: [
      { ParameterID: 'HapticIntensity', ParameterValue: e.intensity },
      { ParameterID: 'HapticSharpness', ParameterValue: e.sharpness },
    ],
  },
});

/** One score as one AHAP pattern, curves included. */
export const toAhap = (s: Score): Ahap => ({
  Version: 1,
  Pattern: [
    ...s.events.map((e) => ahapEvent(e, 0)),
    ...s.curves.map((c): AhapCurve => {
      const start = c.points[0]?.t ?? 0;
      return {
        ParameterCurve: {
          ParameterID:
            c.control === 'intensity'
              ? 'HapticIntensityControl'
              : 'HapticSharpnessControl',
          Time: sec(start),
          ParameterCurveControlPoints: c.points.map((p) => ({
            Time: sec(p.t - start),
            ParameterValue: p.value,
          })),
        },
      };
    }),
  ],
});

/** Several scores on one time axis starting at `originMs`, curves baked. */
export const mergeToAhap = (
  scores: readonly Score[],
  originMs: number
): Ahap => {
  const events = scores.flatMap((s) =>
    bakeCurves(s).events.map((e) => ahapEvent(e, s.at - originMs))
  );
  events.sort((a, b) => a.Event.Time - b.Event.Time);
  return { Version: 1, Pattern: events };
};

export const validateAhap = (a: Ahap): string[] => {
  const out: string[] = [];
  if (a.Version !== 1) out.push('Version must be 1');
  a.Pattern.forEach((p, i) => {
    if ('Event' in p) {
      const e = p.Event;
      if (!(e.Time >= 0)) out.push(`Pattern[${i}].Time negative`);
      if (e.EventType === 'HapticContinuous' && !((e.EventDuration ?? 0) > 0))
        out.push(`Pattern[${i}].EventDuration missing`);
      for (const id of ['HapticIntensity', 'HapticSharpness']) {
        const v = e.EventParameters.find(
          (q) => q.ParameterID === id
        )?.ParameterValue;
        if (v === undefined || !(v >= 0 && v <= 1))
          out.push(`Pattern[${i}].${id} missing or outside 0..1`);
      }
    } else {
      const c = p.ParameterCurve;
      const [lo, hi] =
        c.ParameterID === 'HapticIntensityControl' ? [0, 1] : [-1, 1];
      if (!(c.Time >= 0)) out.push(`Pattern[${i}].Time negative`);
      c.ParameterCurveControlPoints.forEach((q, j) => {
        if (!(q.Time >= 0))
          out.push(`Pattern[${i}].points[${j}].Time negative`);
        if (!(q.ParameterValue >= lo && q.ParameterValue <= hi))
          out.push(`Pattern[${i}].points[${j}] outside ${lo}..${hi}`);
      });
    }
  });
  return out;
};
