import { describe, expect, it } from 'vitest';
import type { Command, Score } from './contract';
import { exportScene, sceneFromCommands } from './scene';
import { validateAhap } from './score';

/** Scene export (plan units 8-1, 8-2): commands → layers → AHAP, curves, graph. */

const PLAIN = {
  name: 'plain',
  kind: 'continuous' as const,
  intensity: 0.8,
  sharpness: 0.4,
  durationMs: 120,
};

const score = (at: number, times: number[], id = `s${at}`): Score => ({
  id,
  at,
  layer: 'upscale',
  source: { kind: 'rule' },
  events: times.map((t) => ({
    kind: 'transient' as const,
    t,
    intensity: 0.5,
    sharpness: 0.5,
  })),
  curves: [],
});

const upscaleTimes = (cs: Command[]) =>
  sceneFromCommands(cs).upscale.flatMap((s) => s.events.map((e) => s.at + e.t));

describe('scene from commands', () => {
  it('keeps what a voice played before a revise, then the new score', () => {
    const times = upscaleTimes([
      { op: 'play', voice: 'a', score: score(0, [0, 50, 100]) },
      { op: 'revise', voice: 'a', from: 60, score: score(60, [0, 10]) },
    ]);
    expect(times.sort((x, y) => x - y)).toEqual([0, 50, 60, 70]);
  });

  it('cuts a released voice and leaves other voices alone', () => {
    const times = upscaleTimes([
      { op: 'play', voice: 'a', score: score(0, [0, 50, 100]) },
      { op: 'play', voice: 'b', score: score(0, [80]) },
      { op: 'release', voice: 'a', at: 60, fadeMs: 20 },
    ]);
    expect(times.sort((x, y) => x - y)).toEqual([0, 50, 80]);
  });

  it('turns a held stream into steps at each drive', () => {
    const scene = sceneFromCommands([
      {
        op: 'hold',
        voice: 'v',
        stream: 's',
        at: 0,
        intensity: 0.2,
        sharpness: 0.3,
      },
      {
        op: 'drive',
        voice: 'v',
        stream: 's',
        at: 40,
        intensity: 0.6,
        sharpness: 0.5,
        rampMs: 16,
      },
      { op: 'unhold', voice: 'v', stream: 's', at: 100, fadeMs: 25 },
    ]);
    const held = scene.upscale.flatMap((s) =>
      s.events.map((e) => ({ at: s.at + e.t, e }))
    );
    expect(held.map(({ at, e }) => [at, e.kind, e.intensity])).toEqual([
      [0, 'continuous', 0.2],
      [40, 'continuous', 0.6],
    ]);
    const lengths = held.map(({ e }) =>
      e.kind === 'continuous' ? e.duration : 0
    );
    expect(lengths).toEqual([40, 60]);
  });

  it('plays registered bases at their gain', () => {
    const scene = sceneFromCommands([
      { op: 'defineBase', base: PLAIN },
      { op: 'base', name: 'plain', at: 10, gain: 0.7 },
    ]);
    expect(scene.base).toHaveLength(1);
    expect(scene.base[0]!.at).toBe(10);
    expect(scene.base[0]!.events[0]!.intensity).toBeCloseTo(0.56);
  });
});

describe('scene export', () => {
  const commands: Command[] = [
    { op: 'defineBase', base: PLAIN },
    { op: 'base', name: 'plain', at: 1000, gain: 0.9 },
    { op: 'play', voice: 'a', score: score(1000, [0, 30, 60]) },
    { op: 'play', voice: 'b', score: score(1500, [0]) },
  ];

  it('writes valid AHAP for both layers together and each alone, from the window start', () => {
    const out = exportScene('test', sceneFromCommands(commands), 990, 1300);
    for (const ahap of [out.ahap.both, out.ahap.base, out.ahap.upscale]) {
      expect(validateAhap(ahap)).toEqual([]);
      for (const p of ahap.Pattern)
        if ('Event' in p) {
          expect(p.Event.Time).toBeGreaterThanOrEqual(0);
          expect(p.Event.Time).toBeLessThanOrEqual(0.31);
        }
    }
    // The score outside the window stays out.
    const upscaleEvents = out.ahap.upscale.Pattern.filter((p) => 'Event' in p);
    expect(upscaleEvents).toHaveLength(3);
    expect(out.ahap.both.Pattern.length).toBe(
      out.ahap.base.Pattern.length + out.ahap.upscale.Pattern.length
    );
  });

  it('samples both layers on one time axis and draws them', () => {
    const out = exportScene('test', sceneFromCommands(commands), 990, 1300);
    expect(out.curves.base.length).toBe(out.curves.upscale.length);
    expect(out.curves.base[0]!.t).toBe(0);
    expect(
      Math.max(...out.curves.base.map((p) => p.intensity))
    ).toBeGreaterThan(0);
    expect(out.svg).toContain('<svg');
  });
});
