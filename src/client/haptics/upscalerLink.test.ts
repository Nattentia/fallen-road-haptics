import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Command,
  Hint,
  UpscalerEngine,
  UpscalerInput,
  UpscalerStep,
} from '../../shared/upscaler/contract';
import type { EventSignal, Signal } from '../../shared/haptics/signals';
import { UpscalerLink } from './upscalerLink';

const event = (base?: string, t = 100): EventSignal => ({
  kind: 'event',
  t,
  magnitude: 0.5,
  valence: 'good',
  importance: 0.5,
  actor: 'self',
  target: 'other',
  outcome: 'landed',
  description: 'something lands',
  ...(base ? { base } : {}),
});

/** Echoes what it was given so tests can see pairing and timing. */
const fakeEngine = () => {
  const seen: { signal: Signal; input: UpscalerInput }[] = [];
  const hints: Hint[] = [];
  const wakes: number[] = [];
  let nextWake: number | undefined;
  const step = (commands: Command[], gain = 1): UpscalerStep => ({
    baseGain: gain,
    commands,
    ...(nextWake !== undefined ? { wakeAt: nextWake } : {}),
  });
  const engine: UpscalerEngine = {
    define: (bases) => bases.map((base) => ({ op: 'defineBase', base })),
    consume: (signal, input) => {
      seen.push({ signal, input });
      return step(
        [{ op: 'release', voice: `v${seen.length}`, at: input.now, fadeMs: 0 }],
        input.paired ? 0.8 : 1
      );
    },
    hint: (hint) => {
      hints.push(hint);
      return step([]);
    },
    wake: (now) => {
      wakes.push(now);
      return step([{ op: 'release', voice: 'woken', at: now, fadeMs: 0 }]);
    },
  };
  return {
    engine,
    seen,
    hints,
    wakes,
    wakeAt: (t: number | undefined) => {
      nextWake = t;
    },
  };
};

const setup = () => {
  const fake = fakeEngine();
  const sent: Command[][] = [];
  let now = 1000;
  const link = new UpscalerLink(
    fake.engine,
    (c) => sent.push(c),
    () => now
  );
  return {
    ...fake,
    link,
    sent,
    setNow: (t: number) => {
      now = t;
    },
  };
};

const ops = (batch: Command[] | undefined) =>
  (batch ?? []).map((c) =>
    c.op === 'base' ? `base:${c.name}@${c.gain}` : c.op
  );

describe('UpscalerLink', () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  );
  afterEach(() => vi.useRealTimers());

  it('sends a base first and its signal right after as one batch', () => {
    const { link, sent, seen } = setup();
    link.base('hit');
    expect(sent).toEqual([]);
    link.signal(event('hit'));
    expect(sent).toHaveLength(1);
    expect(ops(sent[0])).toEqual(['base:hit@0.8', 'release']);
    expect(seen[0]?.input.paired).toBe(true);
  });

  it('pairs a signal that arrives before its base', () => {
    const { link, sent, seen } = setup();
    link.signal(event('hit'));
    expect(sent).toEqual([]);
    link.base('hit');
    expect(ops(sent[0])).toEqual(['base:hit@0.8', 'release']);
    expect(seen[0]?.input.paired).toBe(true);
  });

  it('pairs by name when several are in flight', () => {
    const { link, sent } = setup();
    link.signal(event('hit'));
    link.base('hit');
    link.base('death');
    link.signal(event('death'));
    expect(sent.map(ops)).toEqual([
      ['base:hit@0.8', 'release'],
      ['base:death@0.8', 'release'],
    ]);
  });

  it('sends signals without a base at once', () => {
    const { link, sent, seen } = setup();
    link.signal(event());
    expect(ops(sent[0])).toEqual(['release']);
    expect(seen[0]?.input.paired).toBe(false);
  });

  it('flushes an unpaired base at the end of the task with full gain', async () => {
    const { link, sent } = setup();
    link.base('hit');
    await Promise.resolve();
    expect(sent.map(ops)).toEqual([['base:hit@1']]);
  });

  it('flushes a signal whose base never came as unpaired', async () => {
    const { link, sent, seen } = setup();
    link.signal(event('hit'));
    await Promise.resolve();
    expect(sent.map(ops)).toEqual([['release']]);
    expect(seen[0]?.input.paired).toBe(false);
  });

  it('converts game time with the offset at arrival', () => {
    const { link, seen, setNow } = setup();
    setNow(5000);
    link.signal(event(undefined, 4200));
    expect(seen[0]?.input).toMatchObject({ now: 5000, gameToJs: 800 });
  });

  it('defines bases and forwards hints', () => {
    const { link, sent, hints } = setup();
    link.define([
      {
        name: 'hit',
        kind: 'transient',
        intensity: 1,
        sharpness: 0.5,
        durationMs: 0,
      },
    ]);
    expect(ops(sent[0])).toEqual(['defineBase']);
    link.hint({
      voice: 'v',
      questionId: 'q',
      field: 'hardness',
      value: 0.7,
      confidence: 0.6,
      latencyMs: 20,
    });
    expect(hints).toHaveLength(1);
  });

  it('wakes the engine at the time it asked for, once', () => {
    const { link, sent, wakes, wakeAt, setNow } = setup();
    wakeAt(1100);
    link.signal(event());
    wakeAt(undefined);
    setNow(1100);
    vi.advanceTimersByTime(100);
    expect(wakes).toEqual([1100]);
    expect(ops(sent.at(-1))).toEqual(['release']);
    vi.advanceTimersByTime(500);
    expect(wakes).toEqual([1100]);
  });

  it('keeps only the earliest pending wake-up', () => {
    const { link, wakes, wakeAt, setNow } = setup();
    wakeAt(1300);
    link.signal(event());
    wakeAt(1100);
    link.signal(event());
    wakeAt(undefined);
    setNow(1100);
    vi.advanceTimersByTime(100);
    expect(wakes).toEqual([1100]);
  });
});
