/**
 * Genre-agnostic input to the haptic upscaler. A game reports what happens as
 * signals of four kinds; nothing in here knows any game's vocabulary.
 *
 * - event:  one moment whose outcome is settled at that moment
 * - stream: a sensation that lasts while it is on and changes as it goes
 * - gauge:  a lasting 0..1 quantity; it never vibrates by itself, it shapes
 *           related signals and its threshold crossings become events
 * - clock:  timing context: an expected moment, a regular grid, a bounded
 *           window, or the game's time scale
 *
 * A chain ties the signals of one action together (start → progress →
 * resolve → end, or cancel) so the upscaler can keep one haptic running and
 * reshape it as the action unfolds, instead of starting a new one per signal.
 */

export const PARTIES = ['self', 'other', 'world'] as const;
export type Party = (typeof PARTIES)[number];
export const VALENCES = ['good', 'bad', 'neutral'] as const;
export type Valence = (typeof VALENCES)[number];
/** How a contact ended. Games know this exactly, so it is never inferred. */
export const OUTCOMES = [
  'landed',
  'blocked',
  'deflected',
  'missed',
  'broke',
  'none',
] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type ChainStep = 'start' | 'progress' | 'resolve' | 'end' | 'cancel';
export type ChainRef = { id: string; step: ChainStep };

/** Optional physical reading of what is touched, each 0..1. */
export type Material = {
  hardness?: number;
  weight?: number;
  roughness?: number;
};

type Envelope = {
  /** Game time, ms. */
  t: number;
  chain?: ChainRef;
};

export type EventSignal = Envelope & {
  kind: 'event';
  /** 0..1, the only source of size order. */
  magnitude: number;
  valence: Valence;
  /** 0..1, how much it matters not to miss it. */
  importance: number;
  actor: Party;
  target: Party;
  outcome: Outcome;
  /** Short fixed-form English phrase describing what happened. */
  description: string;
  material?: Material;
  /** Ids of gauges that colour this event. */
  gauges?: string[];
  /** Id of the sound effect played at the same moment. */
  sound?: string;
  /** Name of the base vibration the game played at the same moment. */
  base?: string;
};

export type StreamSignal = Envelope & {
  kind: 'stream';
  id: string;
  phase: 'start' | 'update' | 'end';
  /** 0..1, what drives the sensation right now. */
  value: number;
  /** Repetition rate in Hz, when a fast repeat is sent as a stream. */
  rate?: number;
  description?: string;
  material?: Material;
  valence?: Valence;
  importance?: number;
  actor?: Party;
  target?: Party;
  gauges?: string[];
};

export type GaugeSignal = Envelope & {
  kind: 'gauge';
  id: string;
  /** 0..1 */
  value: number;
  goodWhen: 'high' | 'low';
  owner: Party;
  thresholds?: number[];
  description?: string;
};

export type ClockSignal = Envelope &
  (
    | {
        kind: 'clock';
        clock: 'expect';
        at: number;
        description: string;
        importance: number;
      }
    | { kind: 'clock'; clock: 'grid'; interval: number; until: number }
    | { kind: 'clock'; clock: 'window'; until: number; description: string }
    | { kind: 'clock'; clock: 'timescale'; value: number; until?: number }
  );

export type Signal = EventSignal | StreamSignal | GaugeSignal | ClockSignal;

export const clamp01 = (x: number): number =>
  Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;

/** Size of an event as a fraction of the game's reference maximum. */
export const magnitudeOf = (value: number, reference: number): number =>
  reference > 0 ? clamp01(value / reference) : 0;

// ---------------------------------------------------------------------------
// Stream coalescing
// ---------------------------------------------------------------------------

export type CoalesceTuning = { minIntervalMs: number; minDelta: number };
export const STREAM_TUNING: CoalesceTuning = {
  minIntervalMs: 1000 / 60,
  minDelta: 0.02,
};

/**
 * Drops stream updates that come too fast or change too little. Start and end
 * always pass; an update passes once enough time has gone by and the value
 * moved by at least `minDelta` since the last one that passed.
 */
export class StreamCoalescer {
  private last = new Map<string, { t: number; value: number }>();

  constructor(private readonly tuning: CoalesceTuning = STREAM_TUNING) {}

  accept(signal: StreamSignal): boolean {
    if (signal.phase === 'end') {
      this.last.delete(signal.id);
      return true;
    }
    const prev = this.last.get(signal.id);
    if (signal.phase === 'update' && prev) {
      const soon = signal.t - prev.t < this.tuning.minIntervalMs;
      const flat = Math.abs(signal.value - prev.value) < this.tuning.minDelta;
      if (soon || flat) return false;
    }
    this.last.set(signal.id, { t: signal.t, value: signal.value });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Gauge crossings
// ---------------------------------------------------------------------------

export type GaugeCrossing =
  | { gauge: string; kind: 'empty' | 'full' }
  | { gauge: string; kind: 'below' | 'above'; threshold: number };

/**
 * Remembers each gauge's last value and reports what a new value crossed:
 * reaching 0 or 1, and passing a threshold in either direction. The first
 * report of a gauge only records it.
 */
export class GaugeTracker {
  private values = new Map<string, number>();

  update(signal: GaugeSignal): GaugeCrossing[] {
    const value = clamp01(signal.value);
    const prev = this.values.get(signal.id);
    this.values.set(signal.id, value);
    if (prev === undefined || prev === value) return [];
    const out: GaugeCrossing[] = [];
    for (const threshold of signal.thresholds ?? []) {
      if (prev >= threshold && value < threshold)
        out.push({ gauge: signal.id, kind: 'below', threshold });
      if (prev < threshold && value >= threshold)
        out.push({ gauge: signal.id, kind: 'above', threshold });
    }
    if (value === 0) out.push({ gauge: signal.id, kind: 'empty' });
    if (value === 1) out.push({ gauge: signal.id, kind: 'full' });
    return out;
  }

  value(id: string): number | undefined {
    return this.values.get(id);
  }
}

// ---------------------------------------------------------------------------
// State phrases for the live decision model
// ---------------------------------------------------------------------------

/** Ordered bins so every phrase comes from a small, fixed vocabulary. */
export const LEVELS = ['none', 'low', 'medium', 'high', 'full'] as const;
export type Level = (typeof LEVELS)[number];

export const levelOf = (x: number): Level => {
  const v = clamp01(x);
  if (v === 0) return 'none';
  if (v === 1) return 'full';
  return v < 1 / 3 ? 'low' : v < 2 / 3 ? 'medium' : 'high';
};

const phrase = {
  description: (d: string) => `${d}.`,
  result: (o: Outcome) => `result: ${o}.`,
  size: (l: Level) => `size: ${l}.`,
  intensity: (l: Level) => `intensity: ${l}.`,
  by: (p: Party) => `by: ${p}.`,
  to: (p: Party) => `to: ${p}.`,
  forPlayer: (v: Valence) => `for player: ${v}.`,
  gauge: (d: string, l: Level) => `${d}: ${l}.`,
};

/**
 * The live state as short phrases, one fact each. Values are binned so the
 * phrase set is finite: every phrase can be tokenized ahead of time and the
 * model's input assembled on the device without a tokenizer.
 */
export const statePhrases = (
  signal: EventSignal | StreamSignal,
  gauges: ReadonlyArray<{ description: string; value: number }> = []
): string[] => {
  const phrases: string[] = [];
  if (signal.description) phrases.push(phrase.description(signal.description));
  if (signal.kind === 'event') {
    phrases.push(
      phrase.result(signal.outcome),
      phrase.size(levelOf(signal.magnitude))
    );
  } else {
    phrases.push(phrase.intensity(levelOf(signal.value)));
  }
  if (signal.actor) phrases.push(phrase.by(signal.actor));
  if (signal.target) phrases.push(phrase.to(signal.target));
  if (signal.valence) phrases.push(phrase.forPlayer(signal.valence));
  for (const g of gauges)
    phrases.push(phrase.gauge(g.description, levelOf(g.value)));
  return phrases;
};

/**
 * Every phrase `statePhrases` can produce for a game that uses these
 * descriptions and gauges. Each is tokenized ahead of time; the device joins
 * their tokens instead of running a tokenizer.
 */
export const stateVocabulary = (
  descriptions: readonly string[],
  gaugeDescriptions: readonly string[]
): string[] => {
  const out = new Set<string>();
  for (const d of descriptions) out.add(phrase.description(d));
  for (const o of OUTCOMES) out.add(phrase.result(o));
  for (const l of LEVELS) {
    out.add(phrase.size(l));
    out.add(phrase.intensity(l));
    for (const g of gaugeDescriptions) out.add(phrase.gauge(g, l));
  }
  for (const p of PARTIES) {
    out.add(phrase.by(p));
    out.add(phrase.to(p));
  }
  for (const v of VALENCES) out.add(phrase.forPlayer(v));
  return [...out].sort();
};
