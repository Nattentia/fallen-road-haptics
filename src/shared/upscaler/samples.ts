import type { BaseVibration, Command, Score } from './contract';

/**
 * One valid example of every command kind. The native player's tests decode
 * these (exported as JSON by tools/commandFixtures.test.mjs), so a change to
 * the contract on either side fails a test before it reaches a phone.
 */

export const COMMAND_OPS = [
  'defineBase',
  'base',
  'play',
  'revise',
  'hold',
  'drive',
  'unhold',
  'release',
  'ask',
] as const satisfies readonly Command['op'][];

type MissingOps = Exclude<Command['op'], (typeof COMMAND_OPS)[number]>;
/** Fails to compile when a command kind is added without a sample. */
export const COMMAND_OPS_COMPLETE: [MissingOps] extends [never] ? true : never =
  true;

const base: BaseVibration = {
  name: 'plain',
  kind: 'continuous',
  intensity: 0.8,
  sharpness: 0.4,
  durationMs: 120,
};

const score: Score = {
  id: 'voice-1#1',
  at: 1000,
  layer: 'upscale',
  source: {
    kind: 'mix',
    hints: [{ field: 'hardness', weight: 0.4, latencyMs: 18 }],
  },
  events: [
    { kind: 'transient', t: 0, intensity: 0.9, sharpness: 0.8 },
    { kind: 'continuous', t: 5, duration: 90, intensity: 0.6, sharpness: 0.3 },
  ],
  curves: [
    {
      control: 'sharpness',
      points: [
        { t: 5, value: 0 },
        { t: 95, value: -0.3 },
        { t: 96, value: 0 },
      ],
    },
  ],
};

export const SAMPLE_COMMANDS: readonly Command[] = [
  { op: 'defineBase', base },
  { op: 'base', name: 'plain', at: 1000, gain: 0.85 },
  { op: 'play', voice: 'voice-1', score },
  {
    op: 'revise',
    voice: 'voice-1',
    from: 1040,
    score: { ...score, id: 'voice-1#2', at: 1040, source: { kind: 'rule' } },
  },
  {
    op: 'hold',
    voice: 'voice-1',
    stream: 'stream-a',
    at: 990,
    intensity: 0.3,
    sharpness: 0.7,
  },
  {
    op: 'drive',
    voice: 'voice-1',
    stream: 'stream-a',
    at: 1006,
    intensity: 0.45,
    sharpness: 0.7,
    rampMs: 16,
  },
  { op: 'unhold', voice: 'voice-1', stream: 'stream-a', at: 1040, fadeMs: 20 },
  { op: 'release', voice: 'voice-1', at: 1200, fadeMs: 40 },
  {
    op: 'ask',
    voice: 'voice-1',
    state: ['something hard is struck.', 'size: high.'],
    questions: [
      {
        id: 'hardness',
        kind: 'choice',
        prompt: 'How hard is what was touched?',
        options: ['soft', 'firm', 'hard'],
      },
    ],
  },
];
