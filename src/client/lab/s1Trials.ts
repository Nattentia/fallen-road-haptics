import type {
  BaseVibration,
  Command,
  Score,
  ScoreEvent,
} from '../../shared/upscaler/contract';

/**
 * S1 device session: feel checks that fix the player's numbers (T2). Every
 * trial plays hand-made scores through the real bridge and player; nothing
 * here is synthesized by the upscaler, which does not exist yet.
 */

export const LAB_BASE: BaseVibration = {
  name: 'plain',
  kind: 'continuous',
  intensity: 0.8,
  sharpness: 0.4,
  durationMs: 120,
};

/** Lead time so scheduled commands are never in the past on arrival. */
const LEAD_MS = 40;

export type Variant = {
  /** Condition, stored with the answer; never shown to the tester. */
  condition: string;
  /** Settings to apply before playing (Lab-only knobs). */
  settings?: { reviseFadeMs?: number; holdLoopSeconds?: number };
  commands: (at: number, voice: string) => Command[];
};

export type Trial = {
  id: string;
  title: string;
  question: string;
  answers: string[];
  variants: Variant[];
};

let scoreSeq = 0;
const score = (at: number, events: ScoreEvent[]): Score => {
  scoreSeq += 1;
  return {
    id: `lab#${scoreSeq}`,
    at,
    layer: 'upscale',
    source: { kind: 'rule' },
    events,
    curves: [],
  };
};

const cont = (
  t: number,
  duration: number,
  intensity: number,
  sharpness: number
): ScoreEvent => ({ kind: 'continuous', t, duration, intensity, sharpness });

const tap = (t: number, intensity: number, sharpness: number): ScoreEvent => ({
  kind: 'transient',
  t,
  intensity,
  sharpness,
});

const grains = (interval: number): Variant => ({
  condition: `interval ${interval}ms`,
  commands: (at, voice) => [
    {
      op: 'play',
      voice,
      score: score(
        at,
        Array.from({ length: 8 }, (_, i) => tap(i * interval, 0.6, 0.9))
      ),
    },
  ],
});

const seam = (fade: number): Variant => ({
  condition: `revise fade ${fade}ms`,
  settings: { reviseFadeMs: fade },
  commands: (at, voice) => [
    { op: 'play', voice, score: score(at, [cont(0, 400, 0.6, 0.2)]) },
    {
      op: 'revise',
      voice,
      from: at + 150,
      score: score(at + 150, [cont(0, 250, 0.6, 0.8)]),
    },
  ],
});

const drive = (rampMs: number): Variant => ({
  condition: `drive ramp ${rampMs}ms`,
  commands: (at, voice) => {
    const out: Command[] = [
      { op: 'hold', voice, stream: 's', at, intensity: 0.2, sharpness: 0.5 },
    ];
    for (let i = 1; i <= 90; i++) {
      const phase = (i / 90) * Math.PI * 4;
      out.push({
        op: 'drive',
        voice,
        stream: 's',
        at: at + i * 16.7,
        intensity: 0.5 + 0.3 * Math.sin(phase),
        sharpness: 0.5,
        rampMs,
      });
    }
    out.push({ op: 'unhold', voice, stream: 's', at: at + 1550, fadeMs: 30 });
    return out;
  },
});

const loop = (seconds: number): Variant => ({
  condition: `hold loop ${seconds}s`,
  settings: { holdLoopSeconds: seconds },
  commands: (at, voice) => [
    { op: 'hold', voice, stream: 's', at, intensity: 0.5, sharpness: 0.5 },
    { op: 'unhold', voice, stream: 's', at: at + 3500, fadeMs: 30 },
  ],
});

const strike = (at: number) =>
  score(at, [tap(0, 1, 0.9), cont(2, 60, 0.5, 0.3)]);

const layered = (delay: number | null): Variant => ({
  condition: delay === null ? 'base only' : `base + layer at +${delay}ms`,
  commands: (at, voice) => [
    { op: 'base', name: LAB_BASE.name, at, gain: 1 },
    ...(delay === null
      ? []
      : [{ op: 'play' as const, voice, score: strike(at + delay) }]),
  ],
});

const release = (fade: number): Variant => ({
  condition: `release fade ${fade}ms`,
  commands: (at, voice) => [
    { op: 'play', voice, score: score(at, [cont(0, 500, 0.7, 0.4)]) },
    { op: 'release', voice, at: at + 150, fadeMs: fade },
  ],
});

export const S1_TRIALS: readonly Trial[] = [
  {
    id: 'base',
    title: '기본 진동',
    question: '짧은 "윙"이 한 번 느껴지나요?',
    answers: ['한 번, 또렷함', '한 번, 약함', '두 번 이상'],
    variants: [
      {
        condition: 'base only',
        commands: (at) => [{ op: 'base', name: LAB_BASE.name, at, gain: 1 }],
      },
    ],
  },
  {
    id: 'grains',
    title: '입자 간격',
    question: '톡톡 소리가 어떻게 느껴지나요?',
    answers: ['하나하나 셀 수 있음', '거친 떨림', '한 덩어리 진동'],
    variants: [8, 12, 16, 24, 32].map(grains),
  },
  {
    id: 'seam',
    title: '진동 바꾸기 이음새',
    question: '중간에 결이 바뀔 때 끊김이 느껴지나요?',
    answers: ['끊김 없음', '살짝 끊김', '뚜렷이 끊김'],
    variants: [
      ...[0, 8, 20].map(seam),
      {
        condition: 'reference: one score, no revise',
        commands: (at, voice) => [
          {
            op: 'play',
            voice,
            score: score(at, [
              cont(0, 150, 0.6, 0.2),
              cont(150, 250, 0.6, 0.8),
            ]),
          },
        ],
      },
    ],
  },
  {
    id: 'drive',
    title: '실시간 조절',
    question: '세기가 오르내릴 때 어떻게 느껴지나요?',
    answers: ['부드러움', '약간 계단 같음', '계단처럼 끊김'],
    variants: [0, 16].map(drive),
  },
  {
    id: 'loop',
    title: '긴 진동 이음새',
    question: '3.5초 동안 중간에 튀거나 끊기는 순간이 있나요?',
    answers: ['없음', '있음'],
    variants: [1, 30].map(loop),
  },
  {
    id: 'layered',
    title: '기본 진동 + 추가 층',
    question: '어떻게 느껴지나요?',
    answers: ['한 번의 진동', '두 번으로 갈림', '기본과 같음'],
    variants: [null, 0, 20].map(layered),
  },
  {
    id: 'release',
    title: '끝내기',
    question: '진동이 멈출 때 어떻게 느껴지나요?',
    answers: ['뚝 끊김', '부드럽게 사라짐'],
    variants: [0, 40].map(release),
  },
];

export const LEAD = LEAD_MS;
