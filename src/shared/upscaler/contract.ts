/**
 * Contracts between the haptic upscaler and everything around it. They are
 * fixed before the synthesizer is built so later stages (live Laya hints,
 * sound analysis, AHAP export, a second genre) plug in without changing the
 * core. Nothing in here knows any game's vocabulary.
 *
 * Units: milliseconds and 0..1 values. Absolute times are JS clock times
 * (`performance.now()`); the native player converts them to its own clock.
 */

import type { Signal } from '../haptics/signals';

// ---------------------------------------------------------------------------
// Device limits (Apple documentation values; confirmed on device in S1)
// ---------------------------------------------------------------------------

/** Control points a single Core Haptics parameter curve may hold. */
export const MAX_CURVE_POINTS = 16;
/** Longest continuous event Core Haptics accepts. */
export const MAX_CONTINUOUS_MS = 30_000;
/** Range the upscaler may scale a game's base vibration by (user decision). */
export const BASE_GAIN_MIN = 0.7;
export const BASE_GAIN_MAX = 1;

// ---------------------------------------------------------------------------
// Base vibration registration
// ---------------------------------------------------------------------------

/**
 * A game's own vibration, registered once at start-up. Event signals name it
 * in their `base` field; the upscaler uses the shape to balance energy and
 * never changes it beyond a gain within BASE_GAIN_MIN..BASE_GAIN_MAX.
 */
export type BaseVibration = {
  name: string;
  kind: 'transient' | 'continuous';
  intensity: number;
  sharpness: number;
  /** Length of a continuous base; 0 for a transient. */
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Score: one block of vibration as data (maps 1:1 onto AHAP)
// ---------------------------------------------------------------------------

export type ScoreEvent =
  | { kind: 'transient'; t: number; intensity: number; sharpness: number }
  | {
      kind: 'continuous';
      t: number;
      duration: number;
      intensity: number;
      sharpness: number;
    };

/**
 * Intensity control multiplies (0..1); sharpness control adds (-1..1).
 * Curves act on every event of the score while they run, so builders start
 * and end each curve at the neutral value (1 or 0).
 */
export type CurveControl = 'intensity' | 'sharpness';
export type CurvePoint = { t: number; value: number };
export type ScoreCurve = { control: CurveControl; points: CurvePoint[] };

/** A decision about meaning that a live model contributed, and how much. */
export type HintUse = { field: HintField; weight: number; latencyMs: number };
export type ScoreSource = { kind: 'rule' } | { kind: 'mix'; hints: HintUse[] };

export type Score = {
  /** Unique within a session, for logs and export. */
  id: string;
  /** Absolute JS time of the score's zero. */
  at: number;
  layer: 'base' | 'upscale';
  source: ScoreSource;
  /** Times relative to `at`. */
  events: ScoreEvent[];
  /** Times relative to `at`. */
  curves: ScoreCurve[];
};

// ---------------------------------------------------------------------------
// Player commands (JS → native)
// ---------------------------------------------------------------------------

/**
 * A voice is one chain of signals, or one unchained event. Streams inside a
 * voice each hold their own sustained vibration.
 */
export type Command =
  | { op: 'defineBase'; base: BaseVibration }
  /** Play the named base vibration now, scaled by `gain`. */
  | { op: 'base'; name: string; at: number; gain: number }
  | { op: 'play'; voice: string; score: Score }
  /** Replace everything the voice would play from `from` on. */
  | { op: 'revise'; voice: string; from: number; score: Score }
  /** Start a sustained vibration for a stream. */
  | {
      op: 'hold';
      voice: string;
      stream: string;
      at: number;
      intensity: number;
      sharpness: number;
    }
  /** Move a held vibration to new absolute values over `rampMs`. */
  | {
      op: 'drive';
      voice: string;
      stream: string;
      at: number;
      intensity: number;
      sharpness: number;
      rampMs: number;
    }
  | { op: 'unhold'; voice: string; stream: string; at: number; fadeMs: number }
  /** End the voice: every held and scheduled vibration fades out. */
  | { op: 'release'; voice: string; at: number; fadeMs: number }
  /** Ask the live decision model; answers come back as `Hint`s. */
  | { op: 'ask'; voice: string; state: string[]; questions: Question[] };

export type Question = {
  id: string;
  kind: 'choice' | 'score' | 'noul';
  prompt: string;
  options: string[];
};

// ---------------------------------------------------------------------------
// Meaning hints (native → JS, stage 4)
// ---------------------------------------------------------------------------

export type MaterialField = 'hardness' | 'weight' | 'roughness';
/** Physical character of a contact, independent of any game. */
export const CONTACT_CHARACTERS = [
  'cut',
  'thrust',
  'crush',
  'scrape',
  'shatter',
] as const;
export type ContactCharacter = (typeof CONTACT_CHARACTERS)[number];
export type HintField = MaterialField | 'contact';

export type Hint = {
  voice: string;
  questionId: string;
  /** Calibrated 0..1; below the question's threshold it weighs nothing. */
  confidence: number;
  latencyMs: number;
} & (
  | { field: MaterialField; value: number }
  | { field: 'contact'; value: ContactCharacter }
);

// ---------------------------------------------------------------------------
// Sound features (stage 5)
// ---------------------------------------------------------------------------

/** What analysing a sound effect yields; all values 0..1, times in ms. */
export type SoundFeatures = {
  durationMs: number;
  /** Spectral brightness over time, the source of sharpness trajectories. */
  brightness: CurvePoint[];
  /** Loudness envelope over time. */
  loudness: CurvePoint[];
  /** How noise-like the sound is overall, the source of grain density. */
  noisiness: number;
  /** Start of the sound to its loudest moment (v5 A): a slow one pushes. */
  attackMs?: number;
  /** Loudest moment to 20 dB below it (v5 A): how long it rings. */
  decayMs?: number;
  /** Shares of the sound's energy below 150 Hz, 150–1000 Hz, above 3 kHz. */
  bands?: { low: number; mid: number; high: number };
};

// ---------------------------------------------------------------------------
// The upscaler as the bridge sees it
// ---------------------------------------------------------------------------

export type UpscalerInput = {
  /** JS clock now. */
  now: number;
  /** Add to a game time (`t`, `at`, `until`) to get JS clock time. */
  gameToJs: number;
  /** Whether the game played the base vibration this signal names. */
  paired: boolean;
};

export type UpscalerStep = {
  /** Gain for the base vibration paired with the signal (1 when unpaired). */
  baseGain: number;
  commands: Command[];
  /** JS time to be woken at even if no signal arrives. */
  wakeAt?: number;
};

export type UpscalerEngine = {
  define(bases: readonly BaseVibration[]): Command[];
  /** Features of the game's sound effects, by the id signals name. */
  defineSounds(sounds: Readonly<Record<string, SoundFeatures>>): void;
  consume(signal: Signal, input: UpscalerInput): UpscalerStep;
  hint(hint: Hint, now: number): UpscalerStep;
  wake(now: number): UpscalerStep;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const finite = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x);
const in01 = (x: unknown): boolean => finite(x) && x >= 0 && x <= 1;

export const validateBase = (b: BaseVibration): string[] => {
  const out: string[] = [];
  if (!b.name) out.push('base.name is empty');
  if (!in01(b.intensity)) out.push('base.intensity outside 0..1');
  if (!in01(b.sharpness)) out.push('base.sharpness outside 0..1');
  if (b.kind === 'continuous') {
    if (
      !finite(b.durationMs) ||
      b.durationMs <= 0 ||
      b.durationMs > MAX_CONTINUOUS_MS
    )
      out.push('base.durationMs must be > 0 for a continuous base');
  } else if (b.durationMs !== 0) {
    out.push('base.durationMs must be 0 for a transient base');
  }
  return out;
};

const validateCurve = (c: ScoreCurve, path: string): string[] => {
  const out: string[] = [];
  if (c.points.length < 2) out.push(`${path}.points needs at least 2`);
  if (c.points.length > MAX_CURVE_POINTS)
    out.push(`${path}.points exceeds ${MAX_CURVE_POINTS}`);
  const [lo, hi] = c.control === 'intensity' ? [0, 1] : [-1, 1];
  c.points.forEach((p, i) => {
    const prev = c.points[i - 1];
    if (!finite(p.t) || p.t < 0 || (prev && p.t < prev.t))
      out.push(`${path}.points[${i}].t out of order or negative`);
    if (!finite(p.value) || p.value < lo || p.value > hi)
      out.push(`${path}.points[${i}].value outside ${lo}..${hi}`);
  });
  return out;
};

export const validateScore = (s: Score): string[] => {
  const out: string[] = [];
  if (!s.id) out.push('score.id is empty');
  if (!finite(s.at)) out.push('score.at is not a number');
  s.events.forEach((e, i) => {
    const path = `events[${i}]`;
    if (!finite(e.t) || e.t < 0) out.push(`${path}.t negative`);
    if (!in01(e.intensity)) out.push(`${path}.intensity outside 0..1`);
    if (!in01(e.sharpness)) out.push(`${path}.sharpness outside 0..1`);
    if (
      e.kind === 'continuous' &&
      (!finite(e.duration) || e.duration <= 0 || e.duration > MAX_CONTINUOUS_MS)
    )
      out.push(`${path}.duration outside 0..${MAX_CONTINUOUS_MS}`);
  });
  s.curves.forEach((c, i) => out.push(...validateCurve(c, `curves[${i}]`)));
  if (s.source.kind === 'mix')
    s.source.hints.forEach((h, i) => {
      if (!in01(h.weight)) out.push(`source.hints[${i}].weight outside 0..1`);
      if (!finite(h.latencyMs) || h.latencyMs < 0)
        out.push(`source.hints[${i}].latencyMs negative`);
    });
  return out;
};

export const validateCommand = (c: Command): string[] => {
  const out: string[] = [];
  if ('voice' in c && !c.voice) out.push(`${c.op}.voice is empty`);
  if ('stream' in c && !c.stream) out.push(`${c.op}.stream is empty`);
  if ('at' in c && !finite(c.at)) out.push(`${c.op}.at is not a number`);
  switch (c.op) {
    case 'defineBase':
      out.push(...validateBase(c.base));
      break;
    case 'base':
      if (!c.name) out.push('base.name is empty');
      if (!finite(c.gain) || c.gain < BASE_GAIN_MIN || c.gain > BASE_GAIN_MAX)
        out.push(`base.gain outside ${BASE_GAIN_MIN}..${BASE_GAIN_MAX}`);
      break;
    case 'play':
      out.push(...validateScore(c.score));
      break;
    case 'revise':
      if (!finite(c.from)) out.push('revise.from is not a number');
      out.push(...validateScore(c.score));
      break;
    case 'hold':
      if (!in01(c.intensity)) out.push('hold.intensity outside 0..1');
      if (!in01(c.sharpness)) out.push('hold.sharpness outside 0..1');
      break;
    case 'drive':
      if (!in01(c.intensity)) out.push('drive.intensity outside 0..1');
      if (!in01(c.sharpness)) out.push('drive.sharpness outside 0..1');
      if (!finite(c.rampMs) || c.rampMs < 0) out.push('drive.rampMs negative');
      break;
    case 'unhold':
    case 'release':
      if (!finite(c.fadeMs) || c.fadeMs < 0)
        out.push(`${c.op}.fadeMs negative`);
      break;
    case 'ask':
      if (c.questions.length === 0) out.push('ask.questions is empty');
      c.questions.forEach((q, i) => {
        if (!q.id) out.push(`ask.questions[${i}].id is empty`);
        if (q.options.length < 2)
          out.push(`ask.questions[${i}].options needs at least 2`);
      });
      break;
  }
  return out;
};
