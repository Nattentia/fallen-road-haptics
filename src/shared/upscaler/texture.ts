import type { Material as SignalMaterial } from '../haptics/signals';
import type { SoundFeatures } from './contract';
import type { Material, Texture } from './phrase';

export type { Texture } from './phrase';

/**
 * Texture of a phrase (v5 3.2): the sound played with a moment, turned
 * straight into vibration numbers. No judgement of what the object is.
 * - onset brightness → tap sharpness; mean brightness → body sharpness;
 * - decay (else length) → body length; noisiness, high band → grain;
 * - slow attack → softer tap, fuller body (a push); low band → thicker,
 *   duller body; loudness envelope → body shape.
 * Order, field by field: the game's material, then the sound, then the rule.
 * The skeleton and the size order never depend on the sound.
 */

/** Sound → texture ranges. First guesses, to be tuned on a device (S3). */
export const SOUND_TEXTURE = {
  /** Sounds this short or shorter get the shortest body. */
  shortMs: 100,
  /** Sounds this long or longer get the longest body. */
  longMs: 600,
  /** Noisiness at which grain is full (hit sounds measured 0–0.2). */
  noisyAt: 0.25,
  /** Points kept from the loudness envelope for the body curve. */
  curvePoints: 6,
  /** Decays this short or shorter get the shortest body (hits: 25–130 ms). */
  decayShortMs: 20,
  decayLongMs: 140,
  /** Attacks this slow or slower push fully (hits: 5–25 ms). */
  attackSnapMs: 5,
  attackPushMs: 30,
  /** High-band share where grain starts, and where it is full. */
  hissFrom: 0.3,
  hissFull: 0.8,
};

const clamp = (x: number): number =>
  Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;

/** The v4 mapping from material; used when no sound is known. */
export const textureOfMaterial = (m: Material): Texture => ({
  tapSharpness: clamp(0.35 + 0.6 * m.hardness),
  bodySharpness: clamp(0.5 - 0.4 * m.weight),
  bodyScale: 0.6 + 0.8 * clamp(m.weight),
  grain: clamp(m.roughness),
  tapScale: 1,
  bodyLevelScale: 1,
});

const usable = (f: SoundFeatures | undefined): f is SoundFeatures =>
  f !== undefined && f.durationMs > 0 && f.brightness.length > 0;

export const textureOfSound = (f: SoundFeatures): Texture => {
  const mean =
    f.brightness.reduce((s, p) => s + p.value, 0) /
    Math.max(1, f.brightness.length);
  const onset = f.brightness[0]?.value ?? mean;
  const T = SOUND_TEXTURE;
  const length =
    f.decayMs !== undefined
      ? clamp((f.decayMs - T.decayShortMs) / (T.decayLongMs - T.decayShortMs))
      : clamp((f.durationMs - T.shortMs) / (T.longMs - T.shortMs));
  const push =
    f.attackMs !== undefined
      ? clamp((f.attackMs - T.attackSnapMs) / (T.attackPushMs - T.attackSnapMs))
      : 0;
  const low = clamp(f.bands?.low ?? 0);
  const hiss = clamp(
    ((f.bands?.high ?? 0) - T.hissFrom) / (T.hissFull - T.hissFrom)
  );
  return {
    tapSharpness: clamp(0.35 + 0.6 * onset),
    bodySharpness: clamp((0.1 + 0.4 * mean) * (1 - 0.4 * low)),
    bodyScale: 0.6 + 0.8 * length,
    grain: Math.max(clamp(f.noisiness / T.noisyAt), hiss),
    tapScale: 1 - 0.3 * push,
    bodyLevelScale: 1 + 0.4 * push + 0.2 * low,
    bodyCurve: curveOf(f),
  };
};

/** The loudness envelope as fractions of the sound's length. */
const curveOf = (f: SoundFeatures): Texture['bodyCurve'] => {
  const points = f.loudness;
  if (points.length < 2 || f.durationMs <= 0) return undefined;
  const n = Math.min(SOUND_TEXTURE.curvePoints, points.length);
  const out: { at: number; value: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[Math.round((i * (points.length - 1)) / (n - 1))]!;
    const at = clamp(p.t / f.durationMs);
    if (out.length === 0 || at > out.at(-1)!.at)
      out.push({ at, value: clamp(p.value) });
  }
  return out;
};

export type ResolvedTexture = { texture: Texture; fromSound: boolean };

/**
 * `material` is the resolved material (game values, else the rule);
 * `fromGame` tells which of its fields the game set itself.
 */
export const resolveTexture = (
  fromGame: SignalMaterial | undefined,
  material: Material,
  sound: SoundFeatures | undefined
): ResolvedTexture => {
  const rule = textureOfMaterial(material);
  if (!usable(sound)) return { texture: rule, fromSound: false };
  const heard = textureOfSound(sound);
  const weightGiven = fromGame?.weight !== undefined;
  return {
    texture: {
      tapSharpness:
        fromGame?.hardness !== undefined
          ? rule.tapSharpness
          : heard.tapSharpness,
      bodySharpness: weightGiven ? rule.bodySharpness : heard.bodySharpness,
      bodyScale: weightGiven ? rule.bodyScale : heard.bodyScale,
      grain: fromGame?.roughness !== undefined ? rule.grain : heard.grain,
      tapScale: heard.tapScale,
      bodyLevelScale: weightGiven ? rule.bodyLevelScale : heard.bodyLevelScale,
      ...(heard.bodyCurve ? { bodyCurve: heard.bodyCurve } : {}),
    },
    fromSound: true,
  };
};
