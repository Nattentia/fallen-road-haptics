import type { EventSignal } from '../../shared/haptics/signals';
import type { Command, Score } from '../../shared/upscaler/contract';
import {
  bounce,
  glide,
  grains,
  shift,
  strike,
  swell,
  type Shape,
} from '../../shared/upscaler/parts';
import { HapticUpscaler } from '../../shared/upscaler/upscaler';
import { LAB_BASE, type Trial, type Variant } from './s1Trials';

/**
 * S2 device session.
 * D1: each part laid over the base vibration — does it add a new texture,
 *     disappear under the base, or smear? And how many parts one phrase can
 *     hold before it smears.
 * D3: the real engine's balance — does a layered moment stand out more
 *     than its size says, and does size order survive the mix?
 */

let seq = 0;
const score = (at: number, shape: Shape): Score => {
  seq += 1;
  return {
    id: `s2#${seq}`,
    at,
    layer: 'upscale',
    source: { kind: 'rule' },
    ...shape,
  };
};

const baseAt = (at: number): Command => ({
  op: 'base',
  name: LAB_BASE.name,
  at,
  gain: 1,
});

const PARTS: { name: string; shape: Shape }[] = [
  {
    name: 'grains',
    shape: grains({
      count: 8,
      intervalMs: 16,
      intensity: 0.5,
      sharpness: 0.9,
      fade: 0.4,
      accel: 1,
    }),
  },
  {
    name: 'glide',
    shape: glide({ durationMs: 160, intensity: 0.5, from: 0.2, to: 1 }),
  },
  {
    name: 'strike',
    shape: strike({
      intensity: 0.9,
      sharpness: 0.85,
      bodyMs: 120,
      bodyIntensity: 0.5,
      bodySharpness: 0.3,
    }),
  },
  {
    name: 'swell',
    shape: swell({
      durationMs: 300,
      peak: 0.6,
      sharpness: 0.2,
      attack: 0.3,
      wobbleHz: 0,
      wobbleDepth: 0,
    }),
  },
  {
    name: 'wobble',
    shape: swell({
      durationMs: 300,
      peak: 0.6,
      sharpness: 0.15,
      attack: 0.1,
      wobbleHz: 7,
      wobbleDepth: 0.7,
    }),
  },
  {
    name: 'bounce',
    shape: bounce({
      count: 3,
      intensity: 0.8,
      sharpness: 0.9,
      firstGapMs: 60,
      ratio: 0.55,
    }),
  },
];

const partOverBase = (name: string, shape: Shape | null): Variant => ({
  condition: shape ? `base + ${name}` : 'base only',
  commands: (at, voice) => [
    baseAt(at),
    ...(shape ? [{ op: 'play' as const, voice, score: score(at, shape) }] : []),
  ],
});

/** Phrases of 1..4 parts, each part slightly after the previous. */
const stack = (count: number): Variant => ({
  condition: `${count} part(s)`,
  commands: (at, voice) => [
    baseAt(at),
    ...PARTS.filter((p) =>
      ['strike', 'grains', 'swell', 'bounce'].includes(p.name)
    )
      .slice(0, count)
      .map((p, i) => ({
        op: 'play' as const,
        voice,
        score: score(at, shift(p.shape, i * 20)),
      })),
  ],
});

const hitSignal = (magnitude: number): EventSignal => ({
  kind: 'event',
  t: 0,
  magnitude,
  valence: 'good',
  importance: 0.6,
  actor: 'self',
  target: 'other',
  outcome: 'landed',
  description: 'something is struck',
  base: LAB_BASE.name,
});

/** The engine's own output for a hit of this size, with its base. */
const engineHit = (magnitude: number, layered: boolean): Variant => ({
  condition: `${layered ? 'engine' : 'base only'} size ${magnitude}`,
  commands: (at, voice) => {
    if (!layered) return [baseAt(at)];
    const engine = new HapticUpscaler();
    engine.define([LAB_BASE]);
    const step = engine.consume(
      { ...hitSignal(magnitude), chain: { id: voice, step: 'resolve' } },
      { now: at, gameToJs: at, paired: true }
    );
    return [{ ...baseAt(at), gain: step.baseGain }, ...step.commands];
  },
});

export const S2_TRIALS: readonly Trial[] = [
  {
    id: 'd1-parts',
    title: 'D1 · 부품',
    question: '기본 진동과 비교해 어떻게 느껴지나요?',
    answers: ['새 질감이 더해짐', '기본과 차이 없음', '뭉개짐'],
    variants: [
      partOverBase('', null),
      ...PARTS.map((p) => partOverBase(p.name, p.shape)),
    ],
  },
  {
    id: 'd1-stack',
    title: 'D1 · 겹친 부품 수',
    question: '하나하나 구분되나요?',
    answers: ['또렷이 구분됨', '조금 섞임', '뭉개짐'],
    variants: [1, 2, 3, 4].map(stack),
  },
  ...[0.2, 0.5, 0.9].map((m): Trial => ({
    id: `d3-balance-${m}`,
    title: `D3 · 세기 균형 (${m === 0.2 ? '작은' : m === 0.5 ? '중간' : '큰'} 타격)`,
    question: '전체 세기는 어느 정도인가요?',
    answers: ['약함', '보통', '셈'],
    variants: [engineHit(m, false), engineHit(m, true)],
  })),
  {
    id: 'd3-order',
    title: 'D3 · 크기 순서',
    question: '타격의 크기가 어떻게 느껴지나요?',
    answers: ['작음', '중간', '큼'],
    variants: [0.2, 0.5, 0.9].map((m) => engineHit(m, true)),
  },
];
