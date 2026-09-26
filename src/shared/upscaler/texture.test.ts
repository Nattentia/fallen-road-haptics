import { describe, expect, it } from 'vitest';
import type { Outcome, Valence } from '../haptics/signals';
import { validateScore, type Score, type SoundFeatures } from './contract';
import { PART_LIMITS, type Shape } from './parts';
import { DEFAULT_MATERIAL, synthesize, type PhraseInput } from './phrase';
import { seeded } from './rng';
import { energyOf } from './score';
import {
  resolveTexture,
  textureOfMaterial,
  textureOfSound,
  type Texture,
} from './texture';

/** A made-up sound: a flat brightness, a loudness that falls away. */
const sound = (
  brightness: number,
  durationMs: number,
  noisiness: number,
  start = brightness
): SoundFeatures => ({
  durationMs,
  brightness: [
    { t: 0, value: start },
    { t: durationMs / 2, value: brightness },
    { t: durationMs, value: brightness },
  ],
  loudness: [
    { t: 0, value: 1 },
    { t: durationMs * 0.3, value: 0.4 },
    { t: durationMs, value: 0.05 },
  ],
  noisiness,
});

const OUTCOMES: Outcome[] = [
  'landed',
  'blocked',
  'deflected',
  'missed',
  'broke',
  'none',
];
const VALENCES: Valence[] = ['good', 'bad', 'neutral'];

const input = (
  texture: Texture,
  over: Partial<PhraseInput> = {}
): PhraseInput => ({
  outcome: 'landed',
  valence: 'good',
  actor: 'self',
  target: 'other',
  magnitude: 0.5,
  importance: 0.9,
  texture,
  decoration: { instability: 0, advantage: 0, random: seeded(5) },
  ...over,
});

const asScore = (s: Shape): Score => ({
  id: 'x',
  at: 0,
  layer: 'upscale',
  source: { kind: 'rule' },
  ...s,
});

const randomTextures = (n: number): Texture[] => {
  const r = seeded(11);
  return Array.from({ length: n }, () => {
    const low = r();
    const mid = (1 - low) * r();
    return textureOfSound({
      ...sound(r(), 20 + 900 * r(), r() * 0.5, r()),
      attackMs: 60 * r(),
      decayMs: 300 * r(),
      bands: { low, mid, high: (1 - low - mid) * r() },
    });
  });
};

describe('texture from sound (v5 3.2)', () => {
  it('turns slow attacks into a push, long decays into long bodies, bass into thickness (v5 A)', () => {
    const base = sound(0.3, 300, 0);
    const snap = textureOfSound({ ...base, attackMs: 0, decayMs: 30 });
    const push = textureOfSound({ ...base, attackMs: 30, decayMs: 30 });
    expect(push.tapScale).toBeLessThan(snap.tapScale);
    expect(push.bodyLevelScale).toBeGreaterThan(snap.bodyLevelScale);
    const ring = textureOfSound({ ...base, attackMs: 0, decayMs: 130 });
    expect(ring.bodyScale).toBeGreaterThan(snap.bodyScale);
    const thin = textureOfSound({
      ...base,
      bands: { low: 0, mid: 0.9, high: 0 },
    });
    const thick = textureOfSound({
      ...base,
      bands: { low: 0.9, mid: 0.1, high: 0 },
    });
    expect(thick.bodySharpness).toBeLessThan(thin.bodySharpness);
    expect(thick.bodyLevelScale).toBeGreaterThan(thin.bodyLevelScale);
    const hiss = textureOfSound({
      ...base,
      bands: { low: 0, mid: 0.1, high: 0.8 },
    });
    expect(hiss.grain).toBeGreaterThan(0.4);
  });

  it('reproduces the v4 numbers when only material is known', () => {
    const t = textureOfMaterial({ hardness: 1, weight: 0, roughness: 0.7 });
    expect(t.tapSharpness).toBeCloseTo(0.95);
    expect(t.bodyScale).toBeCloseTo(0.6);
    expect(t.bodySharpness).toBeCloseTo(0.5);
    expect(t.grain).toBeCloseTo(0.7);
    expect(t.tapScale).toBe(1);
    expect(t.bodyLevelScale).toBe(1);
    expect(t.bodyCurve).toBeUndefined();
  });

  it('keeps every number in range for any sound', () => {
    for (const t of randomTextures(200)) {
      for (const x of [t.tapSharpness, t.bodySharpness, t.grain])
        expect(x >= 0 && x <= 1).toBe(true);
      expect(t.bodyScale).toBeGreaterThanOrEqual(0.6);
      expect(t.bodyScale).toBeLessThanOrEqual(1.4);
      expect(t.tapScale).toBeGreaterThanOrEqual(0.7);
      expect(t.tapScale).toBeLessThanOrEqual(1);
      expect(t.bodyLevelScale).toBeGreaterThanOrEqual(1);
      expect(t.bodyLevelScale).toBeLessThanOrEqual(1.6);
      for (const p of t.bodyCurve ?? []) {
        expect(p.at >= 0 && p.at <= 1).toBe(true);
        expect(p.value >= 0 && p.value <= 1).toBe(true);
      }
    }
  });

  it('turns bright onsets sharp, long sounds long and noisy sounds grainy', () => {
    const dull = textureOfSound(sound(0.1, 150, 0));
    const bright = textureOfSound(sound(0.9, 150, 0));
    expect(bright.tapSharpness).toBeGreaterThan(dull.tapSharpness);
    expect(bright.bodySharpness).toBeGreaterThan(dull.bodySharpness);
    expect(textureOfSound(sound(0.5, 500, 0)).bodyScale).toBeGreaterThan(
      textureOfSound(sound(0.5, 120, 0)).bodyScale
    );
    expect(textureOfSound(sound(0.5, 300, 0.2)).grain).toBeGreaterThan(
      textureOfSound(sound(0.5, 300, 0)).grain
    );
  });

  it('lets the game material win field by field, then sound, then the rule', () => {
    const s = sound(0.9, 600, 0.3);
    const fromSound = textureOfSound(s);
    const onlyHardness = resolveTexture(
      { hardness: 0 },
      { ...DEFAULT_MATERIAL, hardness: 0 },
      s
    );
    expect(onlyHardness.texture.tapSharpness).toBeCloseTo(0.35);
    expect(onlyHardness.texture.bodyScale).toBeCloseTo(fromSound.bodyScale);
    expect(onlyHardness.texture.grain).toBeCloseTo(fromSound.grain);
    expect(onlyHardness.fromSound).toBe(true);

    const none = resolveTexture(undefined, DEFAULT_MATERIAL, undefined);
    expect(none.texture).toEqual(textureOfMaterial(DEFAULT_MATERIAL));
    expect(none.fromSound).toBe(false);
  });

  it('never changes the skeleton: same parts, same events, only their numbers', () => {
    const shapeKinds = (shapes: Shape[]) =>
      shapes.map((s) => s.events.map((e) => e.kind).join(','));
    const base = { ...textureOfMaterial(DEFAULT_MATERIAL), grain: 0 };
    for (const t of randomTextures(40)) {
      const smooth = { ...t, grain: 0 };
      for (const outcome of OUTCOMES)
        for (const valence of VALENCES)
          expect(
            shapeKinds(synthesize(input(smooth, { outcome, valence })))
          ).toEqual(shapeKinds(synthesize(input(base, { outcome, valence }))));
    }
  });

  it('keeps bigger moments bigger for every sound', () => {
    for (const t of randomTextures(40))
      for (const outcome of OUTCOMES)
        for (const valence of VALENCES) {
          const e = (m: number) =>
            synthesize(input(t, { outcome, valence, magnitude: m })).reduce(
              (sum, s) => sum + energyOf(asScore(s)),
              0
            );
          expect(e(0.9)).toBeGreaterThanOrEqual(e(0.2));
        }
  });

  it('leaves the tap at full strength even when the sound starts quiet', () => {
    // The intensity curve scales every event in a pattern, taps included.
    const quietStart: SoundFeatures = {
      ...sound(0.3, 400, 0),
      loudness: [
        { t: 0, value: 0.1 },
        { t: 100, value: 1 },
        { t: 400, value: 0 },
      ],
    };
    const [strike] = synthesize(input(textureOfSound(quietStart)));
    const curve = strike!.curves.find((c) => c.control === 'intensity')!;
    expect(curve.points[0]).toEqual({ t: 0, value: 1 });
    for (const p of curve.points)
      if (p.t > 0 && p.t < PART_LIMITS.tapClearMs) expect(p.value).toBe(1);
  });

  it('shapes the ringing body after the sound and stays a valid score', () => {
    const t = textureOfSound(sound(0.3, 400, 0));
    const [strike] = synthesize(input(t));
    expect(validateScore(asScore(strike!))).toEqual([]);
    const curve = strike!.curves.find((c) => c.control === 'intensity');
    const ts = curve!.points.map((p) => p.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(new Set(ts).size).toBe(ts.length);
  });
});
