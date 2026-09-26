import type { Outcome, Party, Valence } from '../haptics/signals';
import {
  bounce,
  glide,
  grains,
  shift,
  strike,
  swell,
  type Shape,
} from './parts';

/**
 * Phrase synthesis: one resolved moment becomes a few parts laid out in time.
 *
 * - skeleton: which parts and in what timing pattern, from the outcome and whether it
 *   was good or bad for the player. Carries the information; never varies.
 * - size: intensities and lengths grow with magnitude, always monotonically.
 * - texture: tap and body sharpness, body length and shape, grain. From the
 *   sound played with the moment, else from material (texture.ts, v5 3.2).
 * - decoration: gauge state and tiny seeded variation, on extras only.
 *
 * All numbers are first guesses to be tuned by D1–D3 on a device.
 */

export type Material = { hardness: number; weight: number; roughness: number };

export const DEFAULT_MATERIAL: Material = {
  hardness: 0.5,
  weight: 0.5,
  roughness: 0.3,
};

/** How a phrase feels, apart from its skeleton and size (texture.ts). */
export type Texture = {
  /** 0..1 */
  tapSharpness: number;
  /** 0..1 */
  bodySharpness: number;
  /** Body length factor, 0.6..1.4. */
  bodyScale: number;
  /** 0..1; above 0.4 a landed hit scatters grains. */
  grain: number;
  /** Tap strength factor, 0.7..1: a slow attack softens the tap… */
  tapScale: number;
  /** …and a slow attack or a bassy sound fills the body: 1..1.6. */
  bodyLevelScale: number;
  /** Shape of the ringing body: `at` is a fraction of its length. */
  bodyCurve?: readonly { at: number; value: number }[] | undefined;
};

export type Decoration = {
  /** 0..1: a gauge that matters to the player is running low. */
  instability: number;
  /** 0..1: the opponent's gauge is in the player's favour. */
  advantage: number;
  /** Deterministic 0..1 random source for tiny variation. */
  random: () => number;
};

export type PhraseInput = {
  outcome: Outcome;
  valence: Valence;
  actor: Party;
  target: Party;
  magnitude: number;
  importance: number;
  texture: Texture;
  decoration: Decoration;
};

const clamp = (x: number, lo = 0, hi = 1): number =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;

/** Below both of these a moment gets no extra layer at all. */
export const PHRASE_FLOOR = { importance: 0.15, magnitude: 0.05 };

/** Size of a moment turned into the numbers every skeleton shares. */
const sizing = (m: number, texture: Texture, decoration: Decoration) => {
  const tail = 1 - 0.3 * decoration.instability;
  return {
    tap: (0.45 + 0.55 * m) * texture.tapScale,
    body: (30 + 170 * m) * texture.bodyScale * tail,
    bodyLevel: clamp((0.3 + 0.4 * m) * texture.bodyLevelScale),
    bodySharp: clamp(texture.bodySharpness),
    bodyCurve: texture.bodyCurve,
    tapSharp: clamp(texture.tapSharpness + 0.1 * decoration.advantage),
    grainCount: 2 + 8 * m,
  };
};

/** Rough texture laid over a body when a gauge that matters runs low. */
const unrest = (d: Decoration, from: number): Shape[] =>
  d.instability > 0.05
    ? [
        shift(
          grains({
            count: 3 + 5 * d.instability,
            intervalMs: 18 + 4 * d.random(),
            intensity: (0.2 + 0.2 * d.instability) * (0.97 + 0.06 * d.random()),
            sharpness: 0.3,
            fade: 0.5,
            accel: 1,
          }),
          from
        ),
      ]
    : [];

/** Debris for grainy textures. */
const debris = (
  t: Texture,
  d: Decoration,
  size: number,
  from: number
): Shape[] =>
  t.grain > 0.4
    ? [
        shift(
          grains({
            count: 2 + 4 * t.grain * size,
            intervalMs: 16 + 4 * d.random(),
            intensity: (0.2 + 0.25 * t.grain) * (0.97 + 0.06 * d.random()),
            sharpness: 0.7,
            fade: 0.4,
            accel: 1.1,
          }),
          from
        ),
      ]
    : [];

export const synthesize = (p: PhraseInput): Shape[] => {
  const m = clamp(p.magnitude);
  if (p.importance < PHRASE_FLOOR.importance && m < PHRASE_FLOOR.magnitude)
    return [];
  const s = sizing(m, p.texture, p.decoration);
  const good = p.valence === 'good';
  const bad = p.valence === 'bad';
  const bright = good ? 0.1 : bad ? -0.1 : 0;

  switch (p.outcome) {
    case 'landed':
      if (bad)
        return [
          strike({
            intensity: s.tap,
            sharpness: clamp(s.tapSharp - 0.25),
            bodyMs: s.body,
            bodyIntensity: s.bodyLevel,
            bodySharpness: clamp(s.bodySharp - 0.15),
            bodyCurve: s.bodyCurve,
          }),
          // The body shakes: a wobbling swell after the hit.
          shift(
            swell({
              durationMs: 120 + 200 * m,
              peak: 0.25 + 0.35 * m,
              sharpness: 0.15,
              attack: 0.1,
              wobbleHz: 7,
              wobbleDepth: 0.7,
            }),
            10
          ),
          ...unrest(p.decoration, 30),
        ];
      return [
        strike({
          intensity: s.tap,
          sharpness: clamp(s.tapSharp + bright),
          bodyMs: s.body,
          bodyIntensity: s.bodyLevel,
          bodySharpness: s.bodySharp,
          bodyCurve: s.bodyCurve,
        }),
        ...debris(p.texture, p.decoration, m, 12),
        ...unrest(p.decoration, 30),
      ];

    case 'blocked':
      if (good)
        // A hard, short clack and a small rebound: the defence held.
        return [
          strike({
            intensity: s.tap,
            sharpness: clamp(s.tapSharp + 0.25),
            bodyMs: s.body * 0.35,
            bodyIntensity: s.bodyLevel * 0.7,
            bodySharpness: 0.6,
            bodyCurve: s.bodyCurve,
          }),
          shift(
            bounce({
              count: 2,
              intensity: s.tap * 0.45,
              sharpness: 0.9,
              firstGapMs: 45,
              ratio: 0.55,
            }),
            40
          ),
          ...unrest(p.decoration, 30),
        ];
      // Recoil: the impact bounces back.
      return [
        shift(
          bounce({
            count: 3,
            intensity: s.tap,
            sharpness: clamp(0.75 + bright),
            firstGapMs: 55 + 30 * m,
            ratio: 0.55,
          }),
          0
        ),
        ...unrest(p.decoration, 30),
      ];

    case 'deflected':
      if (good)
        // A quick bright rise ending in a click: the timing was right.
        return [
          glide({
            durationMs: 50 + 30 * m,
            intensity: 0.4 + 0.3 * m,
            from: 0.3,
            to: 1,
          }),
          shift(
            strike({
              intensity: s.tap,
              sharpness: 1,
              bodyMs: 0,
              bodyIntensity: 0,
              bodySharpness: 0,
            }),
            50 + 30 * m
          ),
        ];
      // A bright catch that sinks away.
      return [
        strike({
          intensity: s.tap,
          sharpness: 0.85,
          bodyMs: 0,
          bodyIntensity: 0,
          bodySharpness: 0,
        }),
        shift(
          glide({
            durationMs: 100 + 120 * m,
            intensity: 0.35 + 0.35 * m,
            from: 0.8,
            to: 0.1,
          }),
          8
        ),
        ...unrest(p.decoration, 30),
      ];

    case 'missed':
      if (!good || p.importance < 0.3) return [];
      // A near miss: a light swish of grains; a crucial one ends in a click.
      return [
        ...(p.importance >= 0.8
          ? [
              shift(
                strike({
                  intensity: 0.5 + 0.4 * m,
                  sharpness: 1,
                  bodyMs: 0,
                  bodyIntensity: 0,
                  bodySharpness: 0,
                }),
                70
              ),
            ]
          : []),
        grains({
          count: 3 + 3 * m + 2 * p.importance,
          intervalMs: 22,
          intensity: 0.2 + 0.2 * m + 0.1 * p.importance,
          sharpness: 0.6,
          fade: 0.3,
          accel: 1,
        }),
      ];

    case 'broke':
      if (good)
        // Crack, scatter, and a low collapse.
        return [
          strike({
            intensity: s.tap,
            sharpness: clamp(s.tapSharp + 0.2),
            bodyMs: s.body * 0.5,
            bodyIntensity: s.bodyLevel,
            bodySharpness: s.bodySharp,
            bodyCurve: s.bodyCurve,
          }),
          shift(
            grains({
              count: 4 + 10 * m,
              intervalMs: 16 + 4 * p.decoration.random(),
              intensity: 0.3 + 0.35 * m,
              sharpness: 0.9,
              fade: 0.2,
              accel: 1.15,
            }),
            15
          ),
          shift(
            swell({
              durationMs: 200 + 400 * m,
              peak: 0.35 + 0.45 * m,
              sharpness: 0.1,
              attack: 0.15,
              wobbleHz: 0,
              wobbleDepth: 0,
            }),
            40
          ),
        ];
      {
        // Cracks that speed up, then a heavy thud that fades out.
        const cracks = grains({
          count: 3 + 3 * m,
          intervalMs: 45,
          intensity: 0.45 + 0.2 * m,
          sharpness: 0.9,
          fade: 1,
          accel: 0.6,
        });
        const thudAt = cracks.events.at(-1)?.t ?? 0;
        return [
          cracks,
          shift(
            strike({
              intensity: s.tap,
              sharpness: clamp(s.tapSharp - 0.3),
              bodyMs: s.body * 1.4,
              bodyIntensity: s.bodyLevel,
              bodySharpness: clamp(s.bodySharp - 0.2),
              bodyCurve: s.bodyCurve,
            }),
            thudAt + 20
          ),
          shift(
            swell({
              durationMs: 250 + 450 * m,
              peak: 0.2 + 0.4 * m,
              sharpness: 0.05,
              attack: 0.1,
              wobbleHz: 3,
              wobbleDepth: 0.5,
            }),
            thudAt + 40
          ),
        ];
      }

    case 'none':
      if (good && p.actor === 'self')
        // Gathering: a swell that rises to its peak.
        return [
          swell({
            durationMs: 150 + 150 * m,
            peak: 0.45 + 0.45 * m,
            sharpness: clamp(0.5 + bright),
            attack: 0.8,
            wobbleHz: 0,
            wobbleDepth: 0,
          }),
        ];
      return [
        strike({
          intensity: s.tap * 0.7,
          sharpness: s.tapSharp,
          bodyMs: 0,
          bodyIntensity: 0,
          bodySharpness: 0,
        }),
      ];
  }
};

// ---------------------------------------------------------------------------
// Streams: a sensation held while it lasts
// ---------------------------------------------------------------------------

export type StreamLevels = {
  intensity: number;
  sharpness: number;
  /** Grains per second laid over the hold for rough materials; 0 for none. */
  grainRateHz: number;
  grainIntensity: number;
};

/** The held vibration for a stream at value `v` (0..1). */
export const streamLevels = (v: number, material: Material): StreamLevels => {
  const value = clamp(v);
  const rough = clamp((material.roughness - 0.2) / 0.8);
  return {
    intensity: clamp(0.12 + 0.3 * value),
    sharpness: clamp(0.25 + 0.6 * material.hardness),
    grainRateHz: rough * value * 40,
    grainIntensity: clamp(0.15 + 0.3 * rough * value),
  };
};
