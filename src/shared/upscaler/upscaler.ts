import type {
  ClockSignal,
  EventSignal,
  GaugeSignal,
  Signal,
  StreamSignal,
} from '../haptics/signals';
import type {
  BaseVibration,
  Command,
  Hint,
  Score,
  ScoreSource,
  SoundFeatures,
  UpscalerEngine,
  UpscalerInput,
  UpscalerStep,
} from './contract';
import { Gauges, type GaugeMoment } from './gauges';
import { resolveMaterial } from './material';
import { resolveTexture, textureOfMaterial } from './texture';
import { Mixer } from './mixer';
import { bounce, strike, type Shape } from './parts';
import {
  streamLevels,
  synthesize,
  type Material,
  type PhraseInput,
} from './phrase';
import { hash, seeded } from './rng';
import { clipScore, endOf } from './score';

/**
 * The haptic upscaler: genre-agnostic signals in, player commands out.
 * Deterministic from its inputs and the clock it is given; live hints only
 * move material values by their calibrated weight.
 */

export const TIMING = {
  /** Fade for held vibrations when their action resolves or ends. */
  streamFadeMs: 25,
  /** Fade for a cancelled action. */
  cancelFadeMs: 30,
  /** Ramp for live stream updates (about one frame). */
  driveRampMs: 16,
  /** Rough-texture grains are scheduled this far ahead, then renewed. */
  textureChunkMs: 200,
  textureRenewLeadMs: 60,
  /** A resolved action is forgotten this long after it resolved. */
  chainMemoryMs: 2000,
};

type Recent = {
  signal: EventSignal;
  at: number;
  until: number;
  importance: number;
};

/** Rough grains under a stream, on a voice of their own. */
type Texture = {
  voice: string;
  importance: number;
  rateHz: number;
  intensity: number;
  scheduledUntil: number;
};

type Chain = {
  streams: Map<string, Material>;
  resolvedAt?: number;
};

export class HapticUpscaler implements UpscalerEngine {
  private readonly bases = new Map<string, BaseVibration>();
  private readonly gauges = new Gauges();
  private readonly mixer = new Mixer();
  private readonly chains = new Map<string, Chain>();
  private readonly hints = new Map<string, Hint[]>();
  private readonly recent = new Map<string, Recent>();
  private readonly textures = new Map<string, Texture>();
  /** Expected moments by voice, kept for stage 6 (prepared decisions). */
  readonly expected = new Map<string, { at: number; importance: number }>();
  private readonly sounds = new Map<string, SoundFeatures>();
  private seq = 0;

  define(bases: readonly BaseVibration[]): Command[] {
    for (const b of bases) this.bases.set(b.name, b);
    return bases.map((base) => ({ op: 'defineBase', base }));
  }

  defineSounds(sounds: Readonly<Record<string, SoundFeatures>>): void {
    for (const [id, f] of Object.entries(sounds)) this.sounds.set(id, f);
  }

  /** Features of a sound the game registered: the texture of its moments (v5). */
  soundOf(id: string | undefined): SoundFeatures | undefined {
    return id === undefined ? undefined : this.sounds.get(id);
  }

  consume(signal: Signal, input: UpscalerInput): UpscalerStep {
    this.prune(input.now);
    let step: UpscalerStep;
    switch (signal.kind) {
      case 'event':
        step = this.event(signal, input);
        break;
      case 'stream':
        step = { baseGain: 1, commands: this.stream(signal, input.now) };
        break;
      case 'gauge':
        step = { baseGain: 1, commands: this.gauge(signal, input.now) };
        break;
      case 'clock':
        this.clock(signal, input);
        step = { baseGain: 1, commands: [] };
        break;
    }
    return this.withWake(step);
  }

  hint(hint: Hint, now: number): UpscalerStep {
    const list = this.hints.get(hint.voice) ?? [];
    list.push(hint);
    this.hints.set(hint.voice, list);
    const commands: Command[] = [];
    // Held streams pick the hint up at their next update. A phrase still sounding: only what has not played yet is re-made.
    const recent = this.recent.get(hint.voice);
    if (recent && now < recent.until) {
      const scores = this.phrase(recent.signal, hint.voice, recent.at, list);
      const rest = scores
        .map((s) => clipScore(s, now, this.nextId(hint.voice)))
        .filter((s) => s.events.length > 0);
      this.mixer.forget(hint.voice);
      const placed = this.mixer.place(
        hint.voice,
        recent.importance,
        recent.signal.magnitude,
        rest,
        null,
        now
      );
      commands.push(
        ...placed.others,
        ...this.revise(hint.voice, now, placed.scores)
      );
    }
    return this.withWake({ baseGain: 1, commands });
  }

  wake(now: number): UpscalerStep {
    const commands: Command[] = [];
    for (const m of this.gauges.due(now)) commands.push(...this.gaugeMoment(m));
    for (const t of this.textures.values())
      if (now >= t.scheduledUntil - TIMING.textureRenewLeadMs)
        commands.push(...this.renewTexture(t, now));
    return this.withWake({ baseGain: 1, commands });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private event(signal: EventSignal, input: UpscalerInput): UpscalerStep {
    const now = input.now;
    if (signal.gauges) this.gauges.explain(signal.gauges, now);
    const voice = signal.chain?.id ?? this.nextVoice('event');
    const step = signal.chain?.step;
    const commands: Command[] = [];

    if (step === 'cancel') {
      commands.push(...this.closeStreams(voice, now, TIMING.cancelFadeMs));
      commands.push({
        op: 'release',
        voice,
        at: now,
        fadeMs: TIMING.cancelFadeMs,
      });
      this.mixer.forget(voice);
      this.chains.delete(voice);
      this.recent.delete(voice);
      this.hints.delete(voice);
      return { baseGain: 1, commands };
    }

    const closing = step === 'resolve' || step === 'end';
    const sounding = this.mixer.sounding(voice, now).length > 0;
    if (closing)
      commands.push(...this.closeStreams(voice, now, TIMING.streamFadeMs));

    const scores = this.phrase(signal, voice, now, this.hints.get(voice) ?? []);
    const base =
      input.paired && signal.base
        ? (this.bases.get(signal.base) ?? null)
        : null;
    if (closing) this.mixer.forget(voice);
    const placed = this.mixer.place(
      voice,
      signal.importance,
      signal.magnitude,
      scores,
      base,
      now
    );
    commands.push(...placed.others);
    // Closing steps replace whatever the action was still playing.
    commands.push(
      ...(closing && (sounding || placed.scores.length > 0)
        ? this.revise(voice, now, placed.scores)
        : this.play(voice, placed.scores))
    );

    const until = Math.max(now, ...placed.scores.map((s) => s.at + endOf(s)));
    this.recent.set(voice, {
      signal,
      at: now,
      until,
      importance: signal.importance,
    });
    if (signal.chain) {
      const chain: Chain = this.chains.get(voice) ?? { streams: new Map() };
      if (step === 'end') this.chains.delete(voice);
      else {
        if (step === 'resolve') chain.resolvedAt = now;
        this.chains.set(voice, chain);
      }
    }
    return { baseGain: placed.baseGain, commands };
  }

  /** Synthesizes a moment as scores placed at `at`. */
  private phrase(
    signal: EventSignal,
    voice: string,
    at: number,
    hints: readonly Hint[]
  ): Score[] {
    const { material, used } = resolveMaterial(signal.material, hints);
    // v5: the sound played with the moment sets its texture; material only
    // where the game gave it (hints do not reach a sounded moment).
    const { texture, fromSound } = resolveTexture(
      signal.material,
      material,
      this.soundOf(signal.sound)
    );
    const deco = this.gauges.decoration(signal.gauges);
    const input: PhraseInput = {
      outcome: signal.outcome,
      valence: signal.valence,
      actor: signal.actor,
      target: signal.target,
      magnitude: signal.magnitude,
      importance: signal.importance,
      texture,
      decoration: {
        ...deco,
        random: seeded(
          hash(`${voice}|${signal.t}|${signal.outcome}|${signal.description}`)
        ),
      },
    };
    const source: ScoreSource =
      !fromSound && used.length > 0
        ? { kind: 'mix', hints: used }
        : { kind: 'rule' };
    return synthesize(input).map((shape) =>
      this.toScore(shape, voice, at, source)
    );
  }

  // -------------------------------------------------------------------------
  // Streams
  // -------------------------------------------------------------------------

  private stream(signal: StreamSignal, now: number): Command[] {
    const voice = signal.chain?.id ?? `stream:${signal.id}`;
    const chain = this.chains.get(voice) ?? {
      streams: new Map<string, Material>(),
    };
    this.chains.set(voice, chain);
    const key = `${voice}/${signal.id}`;

    if (signal.phase === 'end') {
      chain.streams.delete(signal.id);
      const out: Command[] = [
        {
          op: 'unhold',
          voice,
          stream: signal.id,
          at: now,
          fadeMs: TIMING.streamFadeMs,
        },
      ];
      out.push(...this.stopTexture(key, now, TIMING.streamFadeMs));
      if (!signal.chain && chain.streams.size === 0) this.chains.delete(voice);
      return out;
    }

    const material = resolveMaterial(
      signal.material,
      this.hints.get(voice) ?? []
    ).material;
    chain.streams.set(signal.id, material);
    const levels = streamLevels(signal.value, material);
    const out: Command[] =
      signal.phase === 'start'
        ? [
            {
              op: 'hold',
              voice,
              stream: signal.id,
              at: now,
              intensity: levels.intensity,
              sharpness: levels.sharpness,
            },
          ]
        : [
            {
              op: 'drive',
              voice,
              stream: signal.id,
              at: now,
              intensity: levels.intensity,
              sharpness: levels.sharpness,
              rampMs: TIMING.driveRampMs,
            },
          ];

    const texture = this.textures.get(key);
    if (levels.grainRateHz > 0) {
      if (texture) {
        texture.rateHz = levels.grainRateHz;
        texture.intensity = levels.grainIntensity;
      } else {
        const t: Texture = {
          voice: `${voice}~${signal.id}`,
          importance: signal.importance ?? 0.3,
          rateHz: levels.grainRateHz,
          intensity: levels.grainIntensity,
          scheduledUntil: now,
        };
        this.textures.set(key, t);
        out.push(...this.renewTexture(t, now));
      }
    } else if (texture) {
      out.push(...this.stopTexture(key, now, TIMING.streamFadeMs));
    }
    return out;
  }

  private stopTexture(key: string, now: number, fadeMs: number): Command[] {
    const t = this.textures.get(key);
    if (!t) return [];
    this.textures.delete(key);
    this.mixer.forget(t.voice);
    return [{ op: 'release', voice: t.voice, at: now, fadeMs }];
  }

  /** Schedules the next chunk of rough-texture grains. */
  private renewTexture(t: Texture, now: number): Command[] {
    const from = Math.max(now, t.scheduledUntil);
    const interval = 1000 / t.rateHz;
    const random = seeded(hash(`${t.voice}|${from}`));
    const events: Shape['events'] = [];
    for (let x = 0; x < TIMING.textureChunkMs; x += interval)
      events.push({
        kind: 'transient',
        t: x + random() * interval * 0.3,
        intensity: t.intensity * (0.85 + 0.3 * random()),
        sharpness: 0.55 + 0.2 * random(),
      });
    t.scheduledUntil = from + TIMING.textureChunkMs;
    const score = this.toScore({ events, curves: [] }, t.voice, from, {
      kind: 'rule',
    });
    this.mixer.track(t.voice, t.importance, score);
    return [{ op: 'play', voice: t.voice, score }];
  }

  private closeStreams(voice: string, now: number, fadeMs: number): Command[] {
    const chain = this.chains.get(voice);
    const out: Command[] = [];
    for (const stream of chain?.streams.keys() ?? [])
      out.push({ op: 'unhold', voice, stream, at: now, fadeMs });
    chain?.streams.clear();
    for (const key of [...this.textures.keys()])
      if (key.startsWith(`${voice}/`))
        out.push(...this.stopTexture(key, now, fadeMs));
    return out;
  }

  // -------------------------------------------------------------------------
  // Gauges and clocks
  // -------------------------------------------------------------------------

  private gauge(signal: GaugeSignal, now: number): Command[] {
    return this.gauges.report(signal, now).flatMap((m) => this.gaugeMoment(m));
  }

  private gaugeMoment(m: GaugeMoment): Command[] {
    const voice = `gauge:${m.gauge}`;
    let shapes: Shape[];
    let importance: number;
    let magnitude: number;
    switch (m.kind) {
      case 'warning':
        // Two soft, low knocks.
        shapes = [
          bounce({
            count: 2,
            intensity: 0.35,
            sharpness: 0.2,
            firstGapMs: 90,
            ratio: 0.8,
          }),
        ];
        importance = 0.5;
        magnitude = 0.3;
        break;
      case 'full':
        // One clear click.
        shapes = [
          strike({
            intensity: 0.55,
            sharpness: 1,
            bodyMs: 0,
            bodyIntensity: 0,
            bodySharpness: 0,
          }),
        ];
        importance = 0.4;
        magnitude = 0.3;
        break;
      case 'collapse':
        importance = 0.7;
        magnitude = 0.6;
        shapes = synthesize({
          outcome: 'broke',
          valence: m.good ? 'good' : 'bad',
          actor: 'world',
          target: m.good ? 'other' : 'self',
          magnitude,
          importance,
          texture: textureOfMaterial(resolveMaterial(undefined, []).material),
          decoration: {
            instability: 0,
            advantage: 0,
            random: seeded(hash(`${voice}|${m.at}`)),
          },
        });
        break;
    }
    const scores = shapes.map((s) =>
      this.toScore(s, voice, m.at, { kind: 'rule' })
    );
    const placed = this.mixer.place(
      voice,
      importance,
      magnitude,
      scores,
      null,
      m.at
    );
    return [...placed.others, ...this.play(voice, placed.scores)];
  }

  private clock(signal: ClockSignal, input: UpscalerInput): void {
    if (signal.clock === 'expect' && signal.chain)
      this.expected.set(signal.chain.id, {
        at: signal.at + input.gameToJs,
        importance: signal.importance,
      });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private play(voice: string, scores: readonly Score[]): Command[] {
    return scores.map((score) => ({ op: 'play', voice, score }));
  }

  /** Replaces everything the voice plays from `from` with these scores. */
  private revise(
    voice: string,
    from: number,
    scores: readonly Score[]
  ): Command[] {
    const [first, ...rest] = scores;
    const opening: Score =
      first ??
      this.toScore({ events: [], curves: [] }, voice, from, { kind: 'rule' });
    return [
      { op: 'revise', voice, from, score: opening },
      ...this.play(voice, rest),
    ];
  }

  private toScore(
    shape: Shape,
    voice: string,
    at: number,
    source: ScoreSource
  ): Score {
    return {
      id: this.nextId(voice),
      at,
      layer: 'upscale',
      source,
      events: shape.events,
      curves: shape.curves,
    };
  }

  private nextId(voice: string): string {
    this.seq += 1;
    return `${voice}#${this.seq}`;
  }

  private nextVoice(kind: string): string {
    this.seq += 1;
    return `${kind}-${this.seq}`;
  }

  private withWake(step: UpscalerStep): UpscalerStep {
    const times = [
      this.gauges.nextDeadline(),
      ...[...this.textures.values()].map(
        (t) => t.scheduledUntil - TIMING.textureRenewLeadMs
      ),
    ].filter((t): t is number => t !== undefined);
    return times.length > 0 ? { ...step, wakeAt: Math.min(...times) } : step;
  }

  private prune(now: number): void {
    for (const [voice, r] of this.recent)
      if (r.until < now) {
        this.recent.delete(voice);
        if (!this.chains.has(voice)) this.hints.delete(voice);
      }
    for (const [voice, c] of this.chains)
      if (
        c.resolvedAt !== undefined &&
        c.streams.size === 0 &&
        now - c.resolvedAt > TIMING.chainMemoryMs
      ) {
        this.chains.delete(voice);
        this.hints.delete(voice);
        this.expected.delete(voice);
      }
  }
}
