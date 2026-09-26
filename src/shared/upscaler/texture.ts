import type { Material as SignalMaterial } from '../haptics/signals';
import type { SoundFeatures } from './contract';
import type { Material, Texture } from './phrase';

export type { Texture } from './phrase';

/**
 * Texture of a phrase (v5 3.2): the sound played with a moment, turned
 * straight into vibration numbers. No judgement of what the object is.
 * - onset brightness → tap sharpness; mean brightness → body sharpness;
 * - length → body length; noisiness → grain; loudness envelope → body shape.
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
};

const clamp = (x: number): number =>
  Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;

/** The v4 mapping from material; used when no sound is known. */
export const textureOfMaterial = (m: Material): Texture => ({
  tapSharpness: clamp(0.35 + 0.6 * m.hardness),
  bodySharpness: clamp(0.5 - 0.4 * m.weight),
  bodyScale: 0.6 + 0.8 * clamp(m.weight),
  grain: clamp(m.roughness),
});

const usable = (f: SoundFeatures | undefined): f is SoundFeatures =>
  f !== undefined && f.durationMs > 0 && f.brightness.length > 0;

export const textureOfSound = (f: SoundFeatures): Texture => {
  const mean =
    f.brightness.reduce((s, p) => s + p.value, 0) /
    Math.max(1, f.brightness.length);
  const onset = f.brightness[0]?.value ?? mean;
  const span = SOUND_TEXTURE.longMs - SOUND_TEXTURE.shortMs;
  const length = clamp((f.durationMs - SOUND_TEXTURE.shortMs) / span);
  return {
    tapSharpness: clamp(0.35 + 0.6 * onset),
    bodySharpness: clamp(0.1 + 0.4 * mean),
    bodyScale: 0.6 + 0.8 * length,
    grain: clamp(f.noisiness / SOUND_TEXTURE.noisyAt),
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
      ...(heard.bodyCurve ? { bodyCurve: heard.bodyCurve } : {}),
    },
    fromSound: true,
  };
};
