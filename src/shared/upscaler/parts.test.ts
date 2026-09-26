import { describe, expect, it } from 'vitest';
import { validateScore, type Score } from './contract';
import {
  bounce,
  glide,
  grains,
  lengthOf,
  PART_LIMITS,
  rest,
  shift,
  strike,
  swell,
  type Shape,
} from './parts';
import { energyOf } from './score';

const asScore = (s: Shape): Score => ({
  id: 'p',
  at: 0,
  layer: 'upscale',
  source: { kind: 'rule' },
  ...s,
});

const valid = (s: Shape) => expect(validateScore(asScore(s))).toEqual([]);

/** Every curve ends at its neutral value after the last event it shapes. */
const neutralAtEnd = (s: Shape) => {
  const end = lengthOf(s);
  for (const c of s.curves) {
    const last = c.points.at(-1)!;
    expect(last.t).toBeGreaterThan(end - 1e-9);
    expect(last.value).toBe(c.control === 'intensity' ? 1 : 0);
  }
};

describe('parts', () => {
  it('grains keep their minimum spacing, count cap and fade', () => {
    const g = grains({
      count: 40,
      intervalMs: 2,
      intensity: 0.8,
      sharpness: 0.9,
      fade: 0.25,
      accel: 1,
    });
    valid(g);
    expect(g.events).toHaveLength(PART_LIMITS.maxGrains);
    const times = g.events.map((e) => e.t);
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(
        PART_LIMITS.grainMinIntervalMs
      );
    expect(g.events[0]!.intensity).toBeCloseTo(0.8);
    expect(g.events.at(-1)!.intensity).toBeCloseTo(0.2);
    const faster = grains({
      count: 6,
      intervalMs: 40,
      intensity: 0.5,
      sharpness: 0.5,
      fade: 1,
      accel: 0.7,
    });
    const gaps = faster.events
      .slice(1)
      .map((e, i) => e.t - faster.events[i]!.t);
    expect(gaps[0]).toBeGreaterThan(gaps.at(-1)!);
  });

  it('glide travels sharpness and returns its curve to neutral', () => {
    const g = glide({ durationMs: 200, intensity: 0.6, from: 0.2, to: 0.9 });
    valid(g);
    neutralAtEnd(g);
    expect(g.curves[0]!.points[1]!.value).toBeCloseTo(0.7);
  });

  it('strike grows with its intensity and body', () => {
    const small = strike({
      intensity: 0.5,
      sharpness: 0.8,
      bodyMs: 40,
      bodyIntensity: 0.4,
      bodySharpness: 0.3,
    });
    const big = strike({
      intensity: 0.9,
      sharpness: 0.8,
      bodyMs: 160,
      bodyIntensity: 0.7,
      bodySharpness: 0.3,
    });
    valid(small);
    valid(big);
    neutralAtEnd(big);
    expect(energyOf(asScore(big))).toBeGreaterThan(energyOf(asScore(small)));
    expect(
      strike({
        intensity: 0.7,
        sharpness: 0.5,
        bodyMs: 0,
        bodyIntensity: 0.5,
        bodySharpness: 0.5,
      }).events
    ).toHaveLength(1);
  });

  it('swell stays within the curve budget, with or without wobble', () => {
    for (const wobbleHz of [0, 4, 12]) {
      const s = swell({
        durationMs: 400,
        peak: 0.7,
        sharpness: 0.2,
        attack: 0.3,
        wobbleHz,
        wobbleDepth: 0.6,
      });
      valid(s);
      neutralAtEnd(s);
    }
  });

  it('bounce comes back smaller and sooner', () => {
    const b = bounce({
      count: 3,
      intensity: 0.9,
      sharpness: 0.9,
      firstGapMs: 60,
      ratio: 0.5,
    });
    valid(b);
    expect(b.events.map((e) => e.intensity)).toEqual([0.9, 0.45, 0.225]);
    expect(b.events[1]!.t - b.events[0]!.t).toBeGreaterThan(
      b.events[2]!.t - b.events[1]!.t
    );
  });

  it('rest and zero-size parts are empty', () => {
    expect(rest().events).toEqual([]);
    expect(
      grains({
        count: 5,
        intervalMs: 20,
        intensity: 0,
        sharpness: 0.5,
        fade: 1,
        accel: 1,
      }).events
    ).toEqual([]);
    expect(
      swell({
        durationMs: 100,
        peak: 0,
        sharpness: 0.5,
        attack: 0.5,
        wobbleHz: 0,
        wobbleDepth: 0,
      }).events
    ).toEqual([]);
  });

  it('shift moves events and curves together', () => {
    const g = shift(
      glide({ durationMs: 100, intensity: 0.5, from: 0.5, to: 0.1 }),
      30
    );
    expect(g.events[0]!.t).toBe(30);
    expect(g.curves[0]!.points[0]!.t).toBe(30);
    expect(lengthOf(g)).toBe(130);
  });

  it('clamps out-of-range inputs instead of producing invalid scores', () => {
    valid(
      strike({
        intensity: 3,
        sharpness: -1,
        bodyMs: 50,
        bodyIntensity: 2,
        bodySharpness: 9,
      })
    );
    valid(
      grains({
        count: 3,
        intervalMs: 10,
        intensity: Number.NaN,
        sharpness: 2,
        fade: 5,
        accel: 9,
      })
    );
  });
});
