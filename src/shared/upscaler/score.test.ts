import { describe, expect, it } from 'vitest';
import type { Score } from './contract';
import {
  bakeCurves,
  curveValueAt,
  endOf,
  mergeToAhap,
  scaleScore,
  toAhap,
  validateAhap,
} from './score';

const make = (overrides: Partial<Score> = {}): Score => ({
  id: 's',
  at: 0,
  layer: 'upscale',
  source: { kind: 'rule' },
  events: [],
  curves: [],
  ...overrides,
});

const strike = make({
  id: 'strike',
  events: [
    { kind: 'transient', t: 0, intensity: 1, sharpness: 0.9 },
    { kind: 'continuous', t: 5, duration: 100, intensity: 0.8, sharpness: 0.3 },
  ],
  curves: [
    {
      control: 'intensity',
      points: [
        { t: 5, value: 1 },
        { t: 105, value: 0 },
        { t: 106, value: 1 },
      ],
    },
  ],
});

const glide = make({
  id: 'glide',
  events: [
    { kind: 'continuous', t: 0, duration: 200, intensity: 0.6, sharpness: 0.5 },
  ],
  curves: [
    {
      control: 'sharpness',
      points: [
        { t: 0, value: 0.5 },
        { t: 200, value: -0.5 },
        { t: 201, value: 0 },
      ],
    },
  ],
});

const grains = make({
  id: 'grains',
  events: [0, 20, 40, 60].map((t) => ({
    kind: 'transient' as const,
    t,
    intensity: 0.4,
    sharpness: 0.8,
  })),
});

describe('score helpers', () => {
  it('reads curves as neutral before the first point and held after the last', () => {
    const pts = [
      { t: 10, value: 0.5 },
      { t: 20, value: 1 },
    ];
    expect(curveValueAt(pts, 0, 1)).toBe(1);
    expect(curveValueAt(pts, 15, 1)).toBeCloseTo(0.75);
    expect(curveValueAt(pts, 30, 1)).toBe(1);
  });

  it('scales intensity only and clamps to 1', () => {
    const s = scaleScore(strike, 1.5);
    expect(s.events.map((e) => e.intensity)).toEqual([1, 1]);
    expect(s.events.map((e) => e.sharpness)).toEqual([0.9, 0.3]);
    expect(scaleScore(strike, 0.5).events[1]?.intensity).toBeCloseTo(0.4);
  });

  it('finds where a score ends', () => {
    expect(endOf(strike)).toBe(105);
    expect(endOf(grains)).toBe(60);
    expect(endOf(make())).toBe(0);
  });

  it('bakes curves into plain events that follow the curve', () => {
    const baked = bakeCurves(strike, 10);
    expect(baked.curves).toEqual([]);
    const body = baked.events.filter((e) => e.kind === 'continuous');
    expect(body.length).toBeGreaterThan(5);
    // The body fades from 0.8 towards 0 as the curve does.
    expect(body[0]!.intensity).toBeGreaterThan(body.at(-1)!.intensity);
    const total = body.reduce(
      (sum, e) => sum + (e.kind === 'continuous' ? e.duration : 0),
      0
    );
    expect(total).toBeCloseTo(100);
    const glideBaked = bakeCurves(glide, 20);
    const sharp = glideBaked.events.map((e) => e.sharpness);
    expect(sharp[0]).toBeGreaterThan(sharp.at(-1)!);
    expect(Math.max(...sharp)).toBeLessThanOrEqual(1);
    expect(Math.min(...sharp)).toBeGreaterThanOrEqual(0);
  });
});

describe('AHAP export', () => {
  it('writes each score as a valid AHAP pattern with its curves', () => {
    for (const s of [strike, glide, grains]) {
      const ahap = toAhap(s);
      expect(validateAhap(ahap)).toEqual([]);
    }
    expect(toAhap(strike)).toMatchInlineSnapshot(`
      {
        "Pattern": [
          {
            "Event": {
              "EventParameters": [
                {
                  "ParameterID": "HapticIntensity",
                  "ParameterValue": 1,
                },
                {
                  "ParameterID": "HapticSharpness",
                  "ParameterValue": 0.9,
                },
              ],
              "EventType": "HapticTransient",
              "Time": 0,
            },
          },
          {
            "Event": {
              "EventDuration": 0.1,
              "EventParameters": [
                {
                  "ParameterID": "HapticIntensity",
                  "ParameterValue": 0.8,
                },
                {
                  "ParameterID": "HapticSharpness",
                  "ParameterValue": 0.3,
                },
              ],
              "EventType": "HapticContinuous",
              "Time": 0.005,
            },
          },
          {
            "ParameterCurve": {
              "ParameterCurveControlPoints": [
                {
                  "ParameterValue": 1,
                  "Time": 0,
                },
                {
                  "ParameterValue": 0,
                  "Time": 0.1,
                },
                {
                  "ParameterValue": 1,
                  "Time": 0.101,
                },
              ],
              "ParameterID": "HapticIntensityControl",
              "Time": 0.005,
            },
          },
        ],
        "Version": 1,
      }
    `);
  });

  it('merges scores on one time axis without letting curves leak', () => {
    const later = { ...grains, at: 500 };
    const ahap = mergeToAhap([strike, later], 0);
    expect(validateAhap(ahap)).toEqual([]);
    expect(ahap.Pattern.some((p) => 'ParameterCurve' in p)).toBe(false);
    const times = ahap.Pattern.flatMap((p) =>
      'Event' in p ? [p.Event.Time] : []
    );
    expect(Math.max(...times)).toBeCloseTo(0.56);
  });

  it('flags malformed patterns', () => {
    const bad = toAhap(strike);
    const first = bad.Pattern[0];
    if (first && 'Event' in first) first.Event.Time = -1;
    expect(validateAhap(bad)).not.toEqual([]);
  });
});

describe('clipping and windows', () => {
  it('keeps what is left of a score from a time on', async () => {
    const { clipScore, windowEnergy, energyOf } = await import('./score');
    const s = { ...strike, at: 1000 };
    const rest = clipScore(s, 1050, 'r');
    expect(rest.at).toBe(1050);
    expect(rest.events).toEqual([
      {
        kind: 'continuous',
        t: 0,
        duration: 55,
        intensity: 0.8,
        sharpness: 0.3,
      },
    ]);
    expect(rest.curves[0]!.points[0]!.value).toBeCloseTo(0.55);
    expect(clipScore(s, 900, 'r').events).toHaveLength(2);
    expect(clipScore(s, 2000, 'r').events).toEqual([]);
    const whole = windowEnergy(s, 0, 10_000);
    expect(whole).toBeCloseTo(energyOf(s));
    expect(windowEnergy(s, 1000, 1030)).toBeLessThan(whole);
  });
});
