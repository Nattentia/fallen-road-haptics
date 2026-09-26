import { describe, expect, it } from 'vitest';
import type { ClockSignal, EventSignal } from '../haptics/signals';
import { ANTICIPATION, tension } from './anticipation';
import type { Command } from './contract';
import { PART_LIMITS } from './parts';
import { HapticUpscaler } from './upscaler';

describe('tension grains before an expected moment (6-2)', () => {
  it('fills the window with grains that close in and grow', () => {
    for (const span of [120, 300, 800, 2000])
      for (const importance of [0.6, 0.8, 1]) {
        const { events } = tension(span, importance);
        expect(events.length).toBeGreaterThan(1);
        expect(events.length).toBeLessThanOrEqual(PART_LIMITS.maxGrains);
        events.forEach((e, i) => {
          expect(e.t).toBeGreaterThanOrEqual(0);
          expect(e.t).toBeLessThanOrEqual(span);
          if (i === 0) return;
          const prev = events[i - 1]!;
          expect(e.t - prev.t).toBeGreaterThanOrEqual(ANTICIPATION.minGapMs);
          expect(e.intensity).toBeGreaterThanOrEqual(prev.intensity);
          if (i > 1)
            expect(e.t - prev.t).toBeLessThanOrEqual(prev.t - events[i - 2]!.t);
        });
      }
  });

  it('stays quiet below an ordinary moment and says nothing for a short window', () => {
    const peak = Math.max(...tension(800, 1).events.map((e) => e.intensity));
    expect(peak).toBeLessThanOrEqual(ANTICIPATION.peak);
    expect(tension(ANTICIPATION.minTensionMs - 1, 1).events).toEqual([]);
  });
});

describe('anticipation in the upscaler (6-2)', () => {
  const PLAIN = {
    kind: 'continuous' as const,
    intensity: 0.8,
    sharpness: 0.4,
    durationMs: 120,
  };
  const run = () => {
    const e = new HapticUpscaler();
    e.define([{ name: 'plain', ...PLAIN }]);
    return e;
  };
  const at = (now: number) => ({ now, gameToJs: 0, paired: true });
  const expectAt = (impact: number, importance: number): ClockSignal => ({
    kind: 'clock',
    clock: 'expect',
    t: 0,
    at: impact,
    description: 'something is coming',
    importance,
    chain: { id: 'attack-1', step: 'start' },
  });
  const moment = (over: Partial<EventSignal> = {}): EventSignal => ({
    kind: 'event',
    t: 0,
    magnitude: 0.6,
    valence: 'bad',
    importance: 0.8,
    actor: 'other',
    target: 'self',
    outcome: 'landed',
    description: 'something lands',
    base: 'plain',
    chain: { id: 'attack-1', step: 'resolve' },
    ...over,
  });
  /** A lighter moment of its own, still ringing a while after it lands. */
  const lighter = (): EventSignal => ({
    kind: 'event',
    t: 0,
    magnitude: 1,
    valence: 'good',
    importance: 0.3,
    actor: 'self',
    target: 'other',
    outcome: 'broke',
    description: 'something breaks',
    base: 'plain',
  });
  const onVoice = (cs: readonly Command[], voice: string) =>
    cs.filter((c) => 'voice' in c && c.voice === voice);

  it('plays tension on the action and stops it before the moment', () => {
    const e = run();
    const step = e.consume(expectAt(1000, 0.9), at(0));
    const plays = step.commands.filter((c) => c.op === 'play');
    expect(plays.length).toBe(1);
    const play = plays[0]!;
    if (play.op !== 'play') return;
    expect(play.voice).toBe('attack-1');
    const last = Math.max(
      ...play.score.events.map((ev) => play.score.at + ev.t)
    );
    expect(last).toBeLessThanOrEqual(1000 - ANTICIPATION.restMs);
    expect(step.wakeAt).toBeLessThanOrEqual(1000 - ANTICIPATION.restMs);
  });

  it('adds nothing for a minor expected moment', () => {
    const e = run();
    expect(e.consume(expectAt(1000, 0.3), at(0)).commands).toEqual([]);
  });

  it('never delays the moment: an early result replaces the tension at once', () => {
    const e = run();
    e.consume(expectAt(1000, 0.9), at(0));
    const step = e.consume(moment(), at(400));
    const mine = onVoice(step.commands, 'attack-1');
    expect(mine[0]).toMatchObject({ op: 'revise', from: 400 });
    const starts = mine.flatMap((c) =>
      c.op === 'play' || c.op === 'revise' ? [c.score.at] : []
    );
    expect(Math.min(...starts)).toBe(400);
  });

  it('quiets lighter voices for the rest just before the moment', () => {
    const e = run();
    // A lighter moment still ringing when the rest begins.
    e.consume(lighter(), at(700));
    e.consume(expectAt(1000, 0.9), at(690));
    const woken = e.wake(1000 - ANTICIPATION.restMs);
    const others = woken.commands.filter(
      (c) => 'voice' in c && c.voice !== 'attack-1'
    );
    expect(others.some((c) => c.op === 'revise')).toBe(true);
  });

  it('forgets the rest when the action is cancelled', () => {
    const e = run();
    e.consume(lighter(), at(700));
    e.consume(expectAt(1000, 0.9), at(690));
    e.consume(
      moment({ chain: { id: 'attack-1', step: 'cancel' }, outcome: 'none' }),
      at(750)
    );
    const woken = e.wake(1000 - ANTICIPATION.restMs);
    expect(woken.commands).toEqual([]);
  });
});
