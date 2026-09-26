import { describe, expect, it } from 'vitest';
import type { Material, StreamSignal } from '../haptics/signals';
import { validateCommand, type Command } from './contract';
import { HapticUpscaler } from './upscaler';

/**
 * A second genre without any game code: a car's surface under its tyres,
 * sent as one stream whose material changes (asphalt → gravel → grass) and
 * whose value is speed. Only the body is imported here.
 */

const ASPHALT: Material = { hardness: 0.75, weight: 0.5, roughness: 0.1 };
const GRAVEL: Material = { hardness: 0.6, weight: 0.4, roughness: 0.9 };
const GRASS: Material = { hardness: 0.2, weight: 0.3, roughness: 0.5 };

const surface = (
  t: number,
  phase: StreamSignal['phase'],
  value: number,
  material: Material
): StreamSignal => ({
  kind: 'stream',
  t,
  id: 'surface',
  phase,
  value,
  material,
  description: 'tyres roll over the ground',
  actor: 'self',
  target: 'world',
  valence: 'neutral',
  importance: 0.4,
});

const drive = () => {
  const engine = new HapticUpscaler();
  const out: { t: number; commands: Command[] }[] = [];
  const feed = (s: StreamSignal) => {
    const step = engine.consume(s, { now: s.t, gameToJs: 0, paired: false });
    out.push({ t: s.t, commands: step.commands });
    // Wake-ups renew rough texture while the car keeps rolling.
    if (step.wakeAt !== undefined && step.wakeAt <= s.t + 100)
      out.push({ t: step.wakeAt, commands: engine.wake(step.wakeAt).commands });
  };
  feed(surface(0, 'start', 0.6, ASPHALT));
  for (let t = 50; t <= 500; t += 50) feed(surface(t, 'update', 0.6, ASPHALT));
  for (let t = 550; t <= 1000; t += 50) feed(surface(t, 'update', 0.7, GRAVEL));
  for (let t = 1050; t <= 1500; t += 50) feed(surface(t, 'update', 0.4, GRASS));
  feed(surface(1550, 'end', 0, GRASS));
  return out;
};

const grainsBetween = (
  out: ReturnType<typeof drive>,
  from: number,
  to: number
) =>
  out
    .flatMap((b) => b.commands)
    .flatMap((c) =>
      c.op === 'play' ? c.score.events.map((e) => c.score.at + e.t) : []
    )
    .filter((t) => t >= from && t < to).length;

describe('a second genre through the same body', () => {
  it('turns a surface stream into valid commands only', () => {
    for (const b of drive())
      for (const c of b.commands) expect(validateCommand(c)).toEqual([]);
  });

  it('holds one sustained vibration for the whole drive and closes it', () => {
    const commands = drive().flatMap((b) => b.commands);
    expect(commands.filter((c) => c.op === 'hold')).toHaveLength(1);
    expect(commands.filter((c) => c.op === 'unhold')).toHaveLength(1);
    expect(commands.filter((c) => c.op === 'release')).toHaveLength(1);
  });

  it('feels each surface differently', () => {
    const out = drive();
    const sharpnessAt = (t: number) => {
      const c = out
        .find((b) => b.t === t)
        ?.commands.find((x) => x.op === 'drive');
      return c?.op === 'drive' ? c.sharpness : Number.NaN;
    };
    expect(sharpnessAt(500)).toBeGreaterThan(sharpnessAt(1500));
    // Smooth asphalt adds almost no grains; gravel adds many.
    expect(grainsBetween(out, 100, 500)).toBeLessThan(
      grainsBetween(out, 600, 1000) / 4
    );
    expect(grainsBetween(out, 600, 1000)).toBeGreaterThanOrEqual(8);
  });

  it('stops the rough texture when the car stops', () => {
    const out = drive();
    const last = out.at(-1)!;
    expect(
      last.commands.some(
        (c) => c.op === 'release' && c.voice.endsWith('~surface')
      )
    ).toBe(true);
  });
});
