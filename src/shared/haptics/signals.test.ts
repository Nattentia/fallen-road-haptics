import { describe, expect, it } from 'vitest';
import {
  GaugeTracker,
  StreamCoalescer,
  levelOf,
  magnitudeOf,
  statePhrases,
  type EventSignal,
  type GaugeSignal,
  type StreamSignal,
} from './signals';

const stream = (
  phase: StreamSignal['phase'],
  t: number,
  value: number
): StreamSignal => ({
  kind: 'stream',
  id: 's',
  phase,
  t,
  value,
});

const gauge = (value: number, thresholds?: number[]): GaugeSignal => ({
  kind: 'gauge',
  id: 'g',
  t: 0,
  value,
  goodWhen: 'high',
  owner: 'self',
  ...(thresholds ? { thresholds } : {}),
});

describe('magnitudeOf', () => {
  it('scales by the reference and clamps to 0..1', () => {
    expect(magnitudeOf(5, 20)).toBe(0.25);
    expect(magnitudeOf(40, 20)).toBe(1);
    expect(magnitudeOf(-3, 20)).toBe(0);
  });

  it('is 0 for a missing reference', () => {
    expect(magnitudeOf(5, 0)).toBe(0);
  });
});

describe('StreamCoalescer', () => {
  it('always passes start and end', () => {
    const c = new StreamCoalescer();
    expect(c.accept(stream('start', 0, 0.5))).toBe(true);
    expect(c.accept(stream('end', 1, 0.5))).toBe(true);
  });

  it('drops updates that come too soon or change too little', () => {
    const c = new StreamCoalescer({ minIntervalMs: 16, minDelta: 0.05 });
    c.accept(stream('start', 0, 0.5));
    expect(c.accept(stream('update', 5, 0.9))).toBe(false);
    expect(c.accept(stream('update', 20, 0.52))).toBe(false);
    expect(c.accept(stream('update', 20, 0.6))).toBe(true);
    expect(c.accept(stream('update', 30, 0.9))).toBe(false);
    expect(c.accept(stream('update', 40, 0.9))).toBe(true);
  });
});

describe('GaugeTracker', () => {
  it('only records the first value', () => {
    expect(new GaugeTracker().update(gauge(0))).toEqual([]);
  });

  it('reports reaching empty and full', () => {
    const g = new GaugeTracker();
    g.update(gauge(0.4));
    expect(g.update(gauge(0))).toEqual([{ gauge: 'g', kind: 'empty' }]);
    expect(g.update(gauge(1))).toEqual([{ gauge: 'g', kind: 'full' }]);
    expect(g.update(gauge(1))).toEqual([]);
  });

  it('reports threshold crossings in both directions', () => {
    const g = new GaugeTracker();
    g.update(gauge(0.5, [0.25]));
    expect(g.update(gauge(0.2, [0.25]))).toEqual([
      { gauge: 'g', kind: 'below', threshold: 0.25 },
    ]);
    expect(g.update(gauge(0.1, [0.25]))).toEqual([]);
    expect(g.update(gauge(0.3, [0.25]))).toEqual([
      { gauge: 'g', kind: 'above', threshold: 0.25 },
    ]);
  });
});

describe('statePhrases', () => {
  const event: EventSignal = {
    kind: 'event',
    t: 0,
    magnitude: 0.8,
    valence: 'good',
    importance: 0.5,
    actor: 'self',
    target: 'other',
    outcome: 'landed',
    description: 'player slashes enemy head with iron sword',
  };

  it('bins values into a fixed vocabulary', () => {
    expect(levelOf(0)).toBe('none');
    expect(levelOf(0.2)).toBe('low');
    expect(levelOf(0.5)).toBe('medium');
    expect(levelOf(0.9)).toBe('high');
    expect(levelOf(1)).toBe('full');
  });

  it('turns an event and its gauges into one-fact phrases', () => {
    expect(
      statePhrases(event, [{ description: 'enemy guard', value: 0.1 }])
    ).toEqual([
      'player slashes enemy head with iron sword.',
      'result: landed.',
      'size: high.',
      'by: self.',
      'to: other.',
      'for player: good.',
      'enemy guard: low.',
    ]);
  });
});
