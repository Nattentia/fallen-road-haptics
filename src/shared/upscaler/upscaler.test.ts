import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventSignal, GaugeSignal } from '../haptics/signals';
import {
  BASE_GAIN_MAX,
  BASE_GAIN_MIN,
  validateCommand,
  type Score,
} from './contract';
import { PLAIN, replay } from './fixtures/replay';
import { SCENARIOS } from './fixtures/scenarios';
import { MIX } from './mixer';
import { levelAt, windowEnergy } from './score';
import { HapticUpscaler } from './upscaler';

const scenarios = SCENARIOS;

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('upscaler on every recorded moment', () => {
  it.each(scenarios.map((s) => [s.name, s] as const))(
    '%s',
    async (_, scenario) => {
      const { commands, batches } = await replay(scenario);

      // Every command is valid.
      for (const c of commands) expect(validateCommand(c)).toEqual([]);

      // Every base the game played is sent once, within the gain range.
      const bases = scenario.records.filter((r) => r.kind === 'base').length;
      const baseCommands = commands.filter((c) => c.op === 'base');
      expect(baseCommands).toHaveLength(bases);
      for (const c of baseCommands)
        if (c.op === 'base') {
          expect(c.gain).toBeGreaterThanOrEqual(BASE_GAIN_MIN);
          expect(c.gain).toBeLessThanOrEqual(BASE_GAIN_MAX);
        }

      // Nothing starts before the batch that asked for it.
      for (const b of batches)
        for (const c of b.commands)
          if ('at' in c) expect(c.at).toBeGreaterThanOrEqual(b.at);
          else if (c.op === 'play')
            expect(c.score.at).toBeGreaterThanOrEqual(b.at);

      // No held vibration is left running.
      const held = new Set<string>();
      for (const c of commands) {
        if (c.op === 'hold') held.add(`${c.voice}/${c.stream}`);
        if (c.op === 'unhold') held.delete(`${c.voice}/${c.stream}`);
        if (c.op === 'release')
          for (const k of [...held])
            if (k.startsWith(`${c.voice}/`)) held.delete(k);
      }
      expect([...held]).toEqual([]);

      // Continuous levels in one batch never sum above the cap.
      for (const b of batches) {
        const scores: Score[] = b.commands.flatMap((c) =>
          c.op === 'play' || c.op === 'revise' ? [c.score] : []
        );
        const base = b.commands.find((c) => c.op === 'base');
        const gain = base?.op === 'base' ? base.gain : 0;
        for (let t = b.at; t < b.at + 800; t += 5) {
          const layer = scores.reduce(
            (sum, s) =>
              sum +
              levelAt(
                {
                  ...s,
                  events: s.events.filter((e) => e.kind === 'continuous'),
                },
                t
              ),
            0
          );
          const bed =
            base && t < b.at + PLAIN.durationMs ? PLAIN.intensity * gain : 0;
          expect(layer + bed).toBeLessThanOrEqual(MIX.levelCap + 1e-6);
        }
      }
    }
  );

  it('is deterministic', async () => {
    for (const s of scenarios) {
      const a = await replay(s);
      const b = await replay(s);
      expect(b.commands).toEqual(a.commands);
    }
  });

  it('matches the recorded command sequence (regression)', async () => {
    const summary: { [name: string]: string[] } = {};
    for (const s of scenarios) {
      const { commands } = await replay(s);
      summary[s.name] = commands.map((c) =>
        c.op === 'play' || c.op === 'revise'
          ? `${c.op}:${c.voice.replace(/-\d+$/, '')}:${c.score.events.length}`
          : c.op === 'base'
            ? `base:${c.name}`
            : `${c.op}:${'voice' in c ? c.voice.replace(/-\d+$/, '') : ''}`
      );
    }
    expect(summary).toMatchSnapshot();
  });
});

describe('upscaler rules', () => {
  const run = () => {
    const engine = new HapticUpscaler();
    engine.define([{ name: 'plain', ...PLAIN }]);
    return engine;
  };
  const gauge = (value: number, t: number): GaugeSignal => ({
    kind: 'gauge',
    t,
    id: 'armour',
    value,
    goodWhen: 'high',
    owner: 'self',
    description: 'armour',
  });
  const hit = (
    magnitude: number,
    over: Partial<EventSignal> = {}
  ): EventSignal => ({
    kind: 'event',
    t: 0,
    magnitude,
    valence: 'good',
    importance: 0.6,
    actor: 'self',
    target: 'other',
    outcome: 'landed',
    description: 'something lands',
    base: 'plain',
    ...over,
  });
  const at = (now: number) => ({ now, gameToJs: 0, paired: true });

  it('collapses a gauge that empties with no event naming it, after the window', () => {
    const e = run();
    e.consume(gauge(1, 0), at(0));
    const step = e.consume(gauge(0, 10), at(10));
    expect(step.commands).toEqual([]);
    expect(step.wakeAt).toBe(110);
    const woken = e.wake(110);
    expect(
      woken.commands.some((c) => c.op === 'play' && c.voice === 'gauge:armour')
    ).toBe(true);
  });

  it('never doubles a break the game reported, in either order', () => {
    for (const eventFirst of [true, false]) {
      const e = run();
      e.consume(gauge(1, 0), at(0));
      const brk = hit(0.8, {
        outcome: 'broke',
        valence: 'bad',
        gauges: ['armour'],
      });
      if (eventFirst) e.consume(brk, at(10));
      e.consume(gauge(0, 20), at(20));
      if (!eventFirst) e.consume(brk, at(40));
      const woken = e.wake(200);
      expect(
        woken.commands.filter((c) => 'voice' in c && c.voice === 'gauge:armour')
      ).toEqual([]);
    }
  });

  it('keeps size order after mixing with the base', () => {
    const onset = (m: number) => {
      const step = run().consume(hit(m), at(1000));
      const layer = step.commands.flatMap((c) =>
        c.op === 'play' ? [c.score] : []
      );
      const base: Score = {
        id: 'b',
        at: 1000,
        layer: 'base',
        source: { kind: 'rule' },
        events: [
          {
            kind: 'continuous',
            t: 0,
            duration: 120,
            intensity: 0.8 * step.baseGain,
            sharpness: 0.4,
          },
        ],
        curves: [],
      };
      return [base, ...layer].reduce(
        (sum, s) => sum + windowEnergy(s, 1000, 1000 + MIX.onsetWindowMs),
        0
      );
    };
    const sizes = Array.from({ length: 11 }, (_, i) => i / 10);
    const energies = sizes.map(onset);
    for (let i = 1; i < energies.length; i++)
      expect(energies[i]!).toBeGreaterThanOrEqual(energies[i - 1]! - 1e-6);
    expect(energies.at(-1)!).toBeGreaterThan(energies[0]!);
  });

  it('lowers the base only within its range', () => {
    for (const m of [0, 0.5, 1]) {
      const g = run().consume(hit(m), at(0)).baseGain;
      expect(g).toBeGreaterThanOrEqual(BASE_GAIN_MIN);
      expect(g).toBeLessThanOrEqual(BASE_GAIN_MAX);
    }
  });

  it('re-makes only the unplayed rest when a hint arrives late', () => {
    const e = run();
    e.consume(hit(0.8, { chain: { id: 'act', step: 'resolve' } }), at(1000));
    const late = e.hint(
      {
        voice: 'act',
        questionId: 'q',
        field: 'weight',
        value: 1,
        confidence: 0.9,
        latencyMs: 30,
      },
      1030
    );
    const revise = late.commands.find((c) => c.op === 'revise');
    expect(revise?.op === 'revise' && revise.from).toBe(1030);
    const scores = late.commands.flatMap((c) =>
      c.op === 'play' || c.op === 'revise' ? [c.score] : []
    );
    for (const s of scores) {
      expect(s.at).toBeGreaterThanOrEqual(1030);
      expect(s.source.kind).toBe('mix');
    }
  });

  it('ignores hints below the confidence threshold', () => {
    const e = run();
    e.consume(hit(0.8, { chain: { id: 'act', step: 'resolve' } }), at(1000));
    const late = e.hint(
      {
        voice: 'act',
        questionId: 'q',
        field: 'weight',
        value: 1,
        confidence: 0.2,
        latencyMs: 30,
      },
      1030
    );
    const scores = late.commands.flatMap((c) =>
      c.op === 'play' || c.op === 'revise' ? [c.score] : []
    );
    for (const s of scores) expect(s.source.kind).toBe('rule');
  });

  it('never starts a phrase later than the moment it answers', () => {
    const step = run().consume(hit(1), at(777));
    for (const c of step.commands)
      if (c.op === 'play') expect(c.score.at).toBe(777);
  });
});
