import { describe, expect, it } from 'vitest';
import type { Outcome, Party, Valence } from '../haptics/signals';
import { validateScore, type Score } from './contract';
import type { Shape } from './parts';
import {
  DEFAULT_MATERIAL,
  streamLevels,
  synthesize,
  type Decoration,
  type PhraseInput,
} from './phrase';
import { seeded } from './rng';
import { energyOf } from './score';
import { textureOfMaterial } from './texture';

const OUTCOMES: Outcome[] = [
  'landed',
  'blocked',
  'deflected',
  'missed',
  'broke',
  'none',
];
const VALENCES: Valence[] = ['good', 'bad', 'neutral'];
const PARTIES: [Party, Party][] = [
  ['self', 'other'],
  ['other', 'self'],
  ['world', 'self'],
];

const calm = (seed = 1): Decoration => ({
  instability: 0,
  advantage: 0,
  random: seeded(seed),
});

const input = (over: Partial<PhraseInput> = {}): PhraseInput => ({
  outcome: 'landed',
  valence: 'good',
  actor: 'self',
  target: 'other',
  magnitude: 0.5,
  importance: 0.6,
  texture: textureOfMaterial(DEFAULT_MATERIAL),
  decoration: calm(),
  ...over,
});

const score = (s: Shape): Score => ({
  id: 'x',
  at: 0,
  layer: 'upscale',
  source: { kind: 'rule' },
  ...s,
});

const energy = (shapes: Shape[]) =>
  shapes.reduce((e, s) => e + energyOf(score(s)), 0);

const everyCase = function* () {
  for (const outcome of OUTCOMES)
    for (const valence of VALENCES)
      for (const [actor, target] of PARTIES)
        yield { outcome, valence, actor, target };
};

describe('phrase synthesis', () => {
  it('produces only valid scores for every skeleton and size', () => {
    for (const c of everyCase())
      for (const magnitude of [0, 0.3, 1])
        for (const shape of synthesize(input({ ...c, magnitude })))
          expect(validateScore(score(shape))).toEqual([]);
  });

  it('never lets a bigger moment feel smaller (same skeleton)', () => {
    const sizes = Array.from({ length: 21 }, (_, i) => i / 20);
    for (const c of everyCase()) {
      const energies = sizes.map((magnitude) =>
        energy(synthesize(input({ ...c, magnitude, decoration: calm(7) })))
      );
      for (let i = 1; i < energies.length; i++)
        expect({
          ...c,
          m: sizes[i],
          ok: energies[i]! >= energies[i - 1]!,
        }).toEqual({
          ...c,
          m: sizes[i],
          ok: true,
        });
    }
  });

  it('grows strictly for skeletons that play at all', () => {
    for (const c of everyCase()) {
      const small = energy(
        synthesize(input({ ...c, magnitude: 0.2, decoration: calm(3) }))
      );
      const big = energy(
        synthesize(input({ ...c, magnitude: 0.9, decoration: calm(3) }))
      );
      if (small > 0) expect(big).toBeGreaterThan(small);
    }
  });

  it('is deterministic for the same input and seed', () => {
    const a = synthesize(input({ outcome: 'broke', decoration: calm(42) }));
    const b = synthesize(input({ outcome: 'broke', decoration: calm(42) }));
    expect(a).toEqual(b);
  });

  it('gives good and bad outcomes different skeletons', () => {
    const kinds = (v: Valence) =>
      synthesize(input({ valence: v })).map((s) =>
        s.events.map((e) => e.kind).join(',')
      );
    expect(kinds('good')).not.toEqual(kinds('bad'));
  });

  it('adds nothing below the floor and nothing for a plain miss', () => {
    expect(synthesize(input({ magnitude: 0, importance: 0 }))).toEqual([]);
    expect(
      synthesize(input({ outcome: 'missed', valence: 'neutral' }))
    ).toEqual([]);
  });

  it('lets gauge decoration add parts but never change the skeleton or size order (5-2)', () => {
    const kinds = (shapes: Shape[]) =>
      shapes.map((x) => x.events.map((e) => e.kind).join(','));
    const decorations = [
      { instability: 1, advantage: 0 },
      { instability: 0, advantage: 1 },
      { instability: 0.6, advantage: 0.6 },
    ];
    for (const c of everyCase())
      for (const d of decorations) {
        const deco = (seed: number) => ({ ...calm(seed), ...d });
        const plain = kinds(synthesize(input({ ...c, decoration: calm(4) })));
        const decorated = kinds(synthesize(input({ ...c, decoration: deco(4) })));
        // Decoration only appends parts after the skeleton's own.
        expect(decorated.slice(0, plain.length)).toEqual(plain);
        expect(
          energy(synthesize(input({ ...c, magnitude: 0.9, decoration: deco(4) })))
        ).toBeGreaterThanOrEqual(
          energy(synthesize(input({ ...c, magnitude: 0.2, decoration: deco(4) })))
        );
      }
  });

  it('roughens and shortens when a gauge that matters runs low', () => {
    const steady = synthesize(input({ valence: 'bad' }));
    const shaky = synthesize(
      input({ valence: 'bad', decoration: { ...calm(), instability: 1 } })
    );
    expect(shaky.length).toBeGreaterThan(steady.length);
  });

  it('maps material to tap sharpness and body length', () => {
    const hard = synthesize(
      input({ texture: textureOfMaterial({ ...DEFAULT_MATERIAL, hardness: 1 }) })
    );
    const soft = synthesize(
      input({ texture: textureOfMaterial({ ...DEFAULT_MATERIAL, hardness: 0 }) })
    );
    expect(hard[0]!.events[0]!.sharpness).toBeGreaterThan(
      soft[0]!.events[0]!.sharpness
    );
    const heavy = synthesize(
      input({ texture: textureOfMaterial({ ...DEFAULT_MATERIAL, weight: 1 }) })
    );
    const light = synthesize(
      input({ texture: textureOfMaterial({ ...DEFAULT_MATERIAL, weight: 0 }) })
    );
    const body = (s: Shape[]) =>
      s[0]!.events.find((e) => e.kind === 'continuous');
    const heavyBody = body(heavy);
    const lightBody = body(light);
    expect(
      heavyBody?.kind === 'continuous' && lightBody?.kind === 'continuous'
    ).toBe(true);
    if (heavyBody?.kind === 'continuous' && lightBody?.kind === 'continuous')
      expect(heavyBody.duration).toBeGreaterThan(lightBody.duration);
  });

  it('holds streams weakly and adds grains only for rough materials', () => {
    const smooth = streamLevels(1, { ...DEFAULT_MATERIAL, roughness: 0.1 });
    const rough = streamLevels(1, { ...DEFAULT_MATERIAL, roughness: 0.9 });
    expect(smooth.grainRateHz).toBe(0);
    expect(rough.grainRateHz).toBeGreaterThan(20);
    expect(streamLevels(1, DEFAULT_MATERIAL).intensity).toBeLessThan(0.5);
    expect(streamLevels(0.2, DEFAULT_MATERIAL).intensity).toBeLessThan(
      streamLevels(0.8, DEFAULT_MATERIAL).intensity
    );
  });
});
