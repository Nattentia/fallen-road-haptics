import {
  BASE_GAIN_MAX,
  BASE_GAIN_MIN,
  type BaseVibration,
  type Command,
  type Score,
} from './contract';
import { clipScore, endOf, levelAt, windowEnergy } from './score';

/**
 * Keeps the whole mix in balance (v4 5.2) and applies the overlap policy
 * (v2 5): a layered moment must not feel much stronger than its size says,
 * continuous levels never sum above 1, and a clearly more important moment
 * pushes quieter voices into the background.
 *
 * Numbers are hypotheses for D3.
 */

export const MIX = {
  /** The felt strength of a moment is judged over its first this many ms. */
  onsetWindowMs: 250,
  /** Target onset energy relative to the base's: lo + span × magnitude. */
  targetLo: 1.1,
  targetSpan: 1.2,
  /** A voice this much more important ducks the others. */
  duckMargin: 0.2,
  duckGain: 0.35,
  /** Ducking starts this long after the new onset (onset protection). */
  duckDelayMs: 0,
  /** Continuous events may not push the summed level above this. */
  levelCap: 1,
};

type Active = { voice: string; importance: number; score: Score };

export type Placement = {
  baseGain: number;
  scores: Score[];
  /** Commands that reshape other voices (ducking). */
  others: Command[];
};

export const baseScore = (
  base: BaseVibration,
  at: number,
  gain: number
): Score => ({
  id: 'base',
  at,
  layer: 'base',
  source: { kind: 'rule' },
  events: [
    base.kind === 'continuous'
      ? {
          kind: 'continuous',
          t: 0,
          duration: base.durationMs,
          intensity: base.intensity * gain,
          sharpness: base.sharpness,
        }
      : {
          kind: 'transient',
          t: 0,
          intensity: base.intensity * gain,
          sharpness: base.sharpness,
        },
  ],
  curves: [],
});

const scaleContinuous = (s: Score, k: number): Score => ({
  ...s,
  events: s.events.map((e) =>
    e.kind === 'continuous' ? { ...e, intensity: e.intensity * k } : e
  ),
});

const scaleAll = (s: Score, k: number): Score => ({
  ...s,
  events: s.events.map((e) => ({ ...e, intensity: e.intensity * k })),
});

/** Sum of continuous levels only (taps are brief and never summed). */
const continuousLevel = (scores: readonly Score[], t: number): number =>
  scores.reduce(
    (sum, s) =>
      sum +
      levelAt(
        { ...s, events: s.events.filter((e) => e.kind === 'continuous') },
        t
      ),
    0
  );

export class Mixer {
  private active: Active[] = [];
  private seq = 0;

  /** Forgets scores that have finished. */
  private prune(now: number): void {
    this.active = this.active.filter((a) => a.score.at + endOf(a.score) > now);
  }

  /** Scores of a voice still sounding after `now`. */
  sounding(voice: string, now: number): Score[] {
    this.prune(now);
    return this.active.filter((a) => a.voice === voice).map((a) => a.score);
  }

  /** Records a score played outside `place` (so it can be ducked later). */
  track(voice: string, importance: number, score: Score): void {
    this.active.push({ voice, importance, score });
  }

  /** The voice's scores are cut from `now` (revise or release elsewhere). */
  forget(voice: string): void {
    this.active = this.active.filter((a) => a.voice !== voice);
  }

  place(
    voice: string,
    importance: number,
    magnitude: number,
    scores: Score[],
    base: BaseVibration | null,
    now: number
  ): Placement {
    this.prune(now);
    let layer = scores;
    let baseGain = 1;

    // 1. Energy balance against the paired base over the onset window.
    if (base && layer.length > 0) {
      const from = now;
      const to = now + MIX.onsetWindowMs;
      const eBase = windowEnergy(baseScore(base, now, 1), from, to);
      const eLayer = layer.reduce((e, s) => e + windowEnergy(s, from, to), 0);
      const target = eBase * (MIX.targetLo + MIX.targetSpan * magnitude);
      if (eBase > 0 && eBase + eLayer > target) {
        baseGain = Math.max(BASE_GAIN_MIN, (target - eLayer) / eBase);
        const room = target - eBase * baseGain;
        if (eLayer > room) {
          const k = Math.max(0, room / eLayer);
          layer = layer.map((s) => scaleAll(s, k));
        }
      }
      baseGain = Math.min(BASE_GAIN_MAX, baseGain);
    }

    // 2. Continuous level cap over everything sounding.
    const others = this.active.map((a) => a.score);
    const bed = base ? [baseScore(base, now, baseGain)] : [];
    const span = Math.max(0, ...layer.map((s) => s.at + endOf(s) - now));
    let k = 1;
    for (let t = now; t <= now + span; t += 5) {
      const mine = continuousLevel(layer, t);
      if (mine <= 0) continue;
      const room = MIX.levelCap - continuousLevel([...others, ...bed], t);
      k = Math.min(k, Math.max(0, room) / mine);
    }
    if (k < 1) layer = layer.map((s) => scaleContinuous(s, k));

    // 3. Ducking: clearly more important moments push others back.
    const out = this.duck(voice, importance, now + MIX.duckDelayMs);

    for (const s of layer) this.active.push({ voice, importance, score: s });
    return { baseGain, scores: layer, others: out };
  }

  /**
   * Pushes back, from `from`, every other voice clearly less important than
   * `importance` (to `gain` of its strength). Returns the commands.
   */
  duck(
    voice: string,
    importance: number,
    from: number,
    gain: number = MIX.duckGain
  ): Command[] {
    this.prune(from);
    const out: Command[] = [];
    const ducked = new Set<string>();
    for (const a of this.active) {
      if (a.voice === voice || ducked.has(a.voice)) continue;
      if (importance < a.importance + MIX.duckMargin) continue;
      ducked.add(a.voice);
    }
    for (const v of ducked) {
      const remainders = this.active
        .filter((a) => a.voice === v)
        .map((a) => {
          this.seq += 1;
          return {
            ...a,
            score: scaleAll(
              clipScore(a.score, from, `duck#${this.seq}`),
              gain
            ),
          };
        })
        .filter((a) => a.score.events.length > 0);
      this.active = this.active.filter((a) => a.voice !== v);
      const [first, ...rest] = remainders;
      if (!first) continue;
      out.push({ op: 'revise', voice: v, from, score: first.score });
      for (const r of rest) out.push({ op: 'play', voice: v, score: r.score });
      // Ducked voices stay ducked; they no longer compete for importance.
      this.active.push(...remainders.map((r) => ({ ...r, importance: 0 })));
    }
    return out;
  }
}
