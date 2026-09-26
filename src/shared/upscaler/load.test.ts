import { describe, expect, it } from 'vitest';
import type {
  ClockSignal,
  EventSignal,
  GaugeSignal,
  StreamSignal,
} from '../haptics/signals';
import type {
  BaseVibration,
  Command,
  Hint,
  SoundFeatures,
  UpscalerEngine,
  UpscalerInput,
  UpscalerStep,
} from './contract';
import { UpscalerLink, LINK_BREAKER, loadForThermal } from './link';
import { HapticUpscaler } from './upscaler';

/** Fallback stages (plan unit 6-3): full → light (heat) → off (base only). */

const PLAIN = {
  kind: 'continuous' as const,
  intensity: 0.8,
  sharpness: 0.4,
  durationMs: 120,
};
const at = (now: number): UpscalerInput => ({ now, gameToJs: 0, paired: true });
const run = () => {
  const e = new HapticUpscaler();
  e.define([{ name: 'plain', ...PLAIN }]);
  return e;
};

/** A grainy sound: its texture scatters debris on a landed hit. */
const HISS: SoundFeatures = {
  durationMs: 300,
  brightness: [
    { t: 0, value: 0.9 },
    { t: 300, value: 0.9 },
  ],
  loudness: [
    { t: 0, value: 1 },
    { t: 300, value: 0 },
  ],
  noisiness: 0.3,
};

const hit = (over: Partial<EventSignal> = {}): EventSignal => ({
  kind: 'event',
  t: 0,
  magnitude: 0.7,
  valence: 'good',
  importance: 0.7,
  actor: 'self',
  target: 'other',
  outcome: 'landed',
  description: 'something lands',
  base: 'plain',
  sound: 'hiss',
  gauges: ['armour'],
  ...over,
});
const lowGauge: GaugeSignal = {
  kind: 'gauge',
  t: 0,
  id: 'armour',
  value: 0.1,
  goodWhen: 'high',
  owner: 'self',
  description: 'armour',
};
const expectSoon: ClockSignal = {
  kind: 'clock',
  clock: 'expect',
  t: 0,
  at: 1000,
  description: 'something is coming',
  importance: 0.9,
  chain: { id: 'coming', step: 'start' },
};
const rough: StreamSignal = {
  kind: 'stream',
  t: 0,
  id: 'contact',
  phase: 'start',
  value: 1,
  material: { roughness: 1 },
  importance: 0.3,
};

const events = (cs: readonly Command[]) =>
  cs.flatMap((c) =>
    c.op === 'play' || c.op === 'revise' ? c.score.events : []
  );

describe('light load: decoration goes, skeleton and size stay', () => {
  const prepared = (load: 'full' | 'light') => {
    const e = run();
    e.defineSounds({ hiss: HISS });
    e.setLoad(load, 0);
    e.consume(lowGauge, at(0));
    return e;
  };

  it('drops debris, unrest grains, tension and rough stream texture', () => {
    const full = prepared('full');
    const light = prepared('light');
    const f = full.consume(hit(), at(10)).commands;
    const l = light.consume(hit(), at(10)).commands;
    expect(events(l).length).toBeLessThan(events(f).length);
    // The skeleton's first part (the strike) is the same in both.
    const firstOf = (cs: readonly Command[]) =>
      cs.find((c) => c.op === 'play' || c.op === 'revise');
    const a = firstOf(f);
    const b = firstOf(l);
    if (a?.op === 'play' && b?.op === 'play')
      expect(b.score.events.map((x) => x.kind)).toEqual(
        a.score.events.map((x) => x.kind)
      );
    expect(light.consume(expectSoon, at(20)).commands).toEqual([]);
    expect(full.consume(expectSoon, at(20)).commands.length).toBeGreaterThan(0);
    const holdOnly = light.consume(rough, at(30)).commands;
    expect(holdOnly.map((c) => c.op)).toEqual(['hold']);
  });

  it('keeps bigger moments bigger', () => {
    const energy = (m: number) => {
      const e = prepared('light');
      return events(e.consume(hit({ magnitude: m }), at(10)).commands).reduce(
        (s, x) => s + x.intensity,
        0
      );
    };
    expect(energy(0.9)).toBeGreaterThanOrEqual(energy(0.2));
  });
});

describe('off: the base alone', () => {
  it('releases what is sounding and adds nothing until it comes back', () => {
    const e = run();
    e.defineSounds({ hiss: HISS });
    e.consume(hit({ chain: { id: 'swing', step: 'start' } }), at(0));
    const off = e.setLoad('off', 10);
    expect(
      off.commands.some((c) => c.op === 'release' && c.voice === 'swing')
    ).toBe(true);
    expect(e.consume(hit(), at(20))).toEqual({ baseGain: 1, commands: [] });
    expect(e.consume(expectSoon, at(30)).commands).toEqual([]);
    expect(e.wake(2000).commands).toEqual([]);
    e.setLoad('full', 3000);
    expect(events(e.consume(hit(), at(3010)).commands).length).toBeGreaterThan(
      0
    );
  });
});

describe('link breaker: an engine that keeps failing is set aside', () => {
  class Failing implements UpscalerEngine {
    calls = 0;
    define(_: readonly BaseVibration[]): Command[] {
      return [];
    }
    defineSounds(): void {}
    consume(): UpscalerStep {
      this.calls += 1;
      throw new Error('broken');
    }
    hint(_: Hint): UpscalerStep {
      this.calls += 1;
      throw new Error('broken');
    }
    wake(): UpscalerStep {
      return { baseGain: 1, commands: [] };
    }
    setLoad(): UpscalerStep {
      return { baseGain: 1, commands: [] };
    }
  }

  it('stops calling it after repeated failures, keeps the base, and retries later', async () => {
    let now = 0;
    const sent: Command[][] = [];
    const engine = new Failing();
    const problems: string[] = [];
    const link = new UpscalerLink(
      engine,
      (c) => sent.push(c),
      () => now,
      (p) => problems.push(p)
    );
    const signal = (): EventSignal => {
      const { sound: _sound, gauges: _gauges, ...plain } = hit();
      return plain;
    };
    for (let i = 0; i < LINK_BREAKER.failures + 2; i++) {
      link.base('plain');
      link.signal(signal());
      await Promise.resolve();
      now += 10;
    }
    expect(engine.calls).toBe(LINK_BREAKER.failures);
    // Every base still left, at full gain.
    const bases = sent.flat().filter((c) => c.op === 'base');
    expect(bases.length).toBe(LINK_BREAKER.failures + 2);
    expect(problems.some((p) => p.includes('base only'))).toBe(true);

    now += LINK_BREAKER.cooldownMs;
    link.base('plain');
    link.signal(signal());
    await Promise.resolve();
    expect(engine.calls).toBe(LINK_BREAKER.failures + 1);
  });
});

describe('thermal state → load', () => {
  it('sheds decoration when serious and the layer when critical', () => {
    expect(loadForThermal('nominal')).toBe('full');
    expect(loadForThermal('fair')).toBe('full');
    expect(loadForThermal('serious')).toBe('light');
    expect(loadForThermal('critical')).toBe('off');
    expect(loadForThermal('something new')).toBe('full');
  });
});

describe('link breaker, review fixes', () => {
  const quietStep = (): UpscalerStep => ({ baseGain: 1, commands: [] });

  it('still hands a load change to the engine while the breaker is open', async () => {
    let now = 0;
    const loads: string[] = [];
    const engine: UpscalerEngine = {
      define: () => [],
      defineSounds: () => undefined,
      consume: () => {
        throw new Error('broken');
      },
      hint: quietStep,
      wake: quietStep,
      setLoad: (load) => {
        loads.push(load);
        return quietStep();
      },
    };
    const link = new UpscalerLink(
      engine,
      () => undefined,
      () => now,
      () => undefined
    );
    for (let i = 0; i < LINK_BREAKER.failures; i++) {
      link.signal(lowGauge);
      now += 10;
    }
    link.load('off');
    expect(loads).toEqual(['off']);
  });

  it('trips even when other calls succeed between the failing ones', () => {
    let now = 0;
    let consumed = 0;
    const engine: UpscalerEngine = {
      define: () => [],
      defineSounds: () => undefined,
      consume: () => {
        consumed += 1;
        throw new Error('broken');
      },
      hint: quietStep,
      wake: quietStep,
      setLoad: quietStep,
    };
    const link = new UpscalerLink(
      engine,
      () => undefined,
      () => now,
      () => undefined
    );
    const hint: Hint = {
      voice: 'v',
      field: 'hardness',
      questionId: 'hardness',
      value: 0.5,
      confidence: 0.9,
      latencyMs: 5,
    };
    for (let i = 0; i < LINK_BREAKER.failures + 3; i++) {
      link.signal(lowGauge);
      link.hint(hint);
      now += 10;
    }
    expect(consumed).toBe(LINK_BREAKER.failures);
  });
});

describe('upscaler load, review fixes', () => {
  it('holds a stream again when the layer comes back on', () => {
    const e = run();
    e.consume(rough, at(0));
    e.setLoad('off', 10);
    e.setLoad('full', 20);
    const next = e.consume({ ...rough, phase: 'update', value: 0.5 }, at(30));
    expect(next.commands.map((c) => c.op)).toContain('hold');
  });

  it('skips re-making a sounded moment when a hint arrives', () => {
    const e = run();
    e.defineSounds({ hiss: HISS });
    e.consume(hit({ chain: { id: 'swing', step: 'resolve' } }), at(0));
    const step = e.hint(
      {
        voice: 'swing',
        field: 'hardness',
      questionId: 'hardness',
        value: 1,
        confidence: 0.9,
        latencyMs: 5,
      },
      10
    );
    expect(step.commands).toEqual([]);
  });
});
