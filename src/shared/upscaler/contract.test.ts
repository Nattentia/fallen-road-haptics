import { describe, expect, it } from 'vitest';
import {
  validateBase,
  validateCommand,
  validateScore,
  type BaseVibration,
  type Command,
  type Score,
} from './contract';

const score = (overrides: Partial<Score> = {}): Score => ({
  id: 'v1#1',
  at: 1000,
  layer: 'upscale',
  source: { kind: 'rule' },
  events: [
    { kind: 'transient', t: 0, intensity: 0.9, sharpness: 0.8 },
    {
      kind: 'continuous',
      t: 10,
      duration: 120,
      intensity: 0.6,
      sharpness: 0.3,
    },
  ],
  curves: [
    {
      control: 'intensity',
      points: [
        { t: 10, value: 1 },
        { t: 130, value: 0.2 },
        { t: 131, value: 1 },
      ],
    },
  ],
  ...overrides,
});

const base: BaseVibration = {
  name: 'hit',
  kind: 'continuous',
  intensity: 0.8,
  sharpness: 0.4,
  durationMs: 120,
};

describe('contract', () => {
  it('accepts a well-formed score and survives a JSON round trip', () => {
    const s = score();
    expect(validateScore(s)).toEqual([]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('rejects out-of-range values, bad durations and unsorted curves', () => {
    const issues = validateScore(
      score({
        events: [
          { kind: 'transient', t: -1, intensity: 1.2, sharpness: 0.5 },
          {
            kind: 'continuous',
            t: 0,
            duration: 0,
            intensity: 0.5,
            sharpness: -0.1,
          },
        ],
        curves: [
          {
            control: 'sharpness',
            points: [
              { t: 50, value: 0 },
              { t: 20, value: 1.5 },
            ],
          },
        ],
      })
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/events\[0\]\.t/),
        expect.stringMatching(/events\[0\]\.intensity/),
        expect.stringMatching(/events\[1\]\.duration/),
        expect.stringMatching(/events\[1\]\.sharpness/),
        expect.stringMatching(/curves\[0\]\.points\[1\]\.t/),
        expect.stringMatching(/curves\[0\]\.points\[1\]\.value/),
      ])
    );
  });

  it('caps curve length and continuous duration at the device limits', () => {
    const points = Array.from({ length: 17 }, (_, i) => ({ t: i, value: 1 }));
    const issues = validateScore(
      score({
        events: [
          {
            kind: 'continuous',
            t: 0,
            duration: 30_001,
            intensity: 0.5,
            sharpness: 0.5,
          },
        ],
        curves: [{ control: 'intensity', points }],
      })
    );
    expect(issues.some((i) => i.includes('duration'))).toBe(true);
    expect(issues.some((i) => i.includes('points'))).toBe(true);
  });

  it('allows sharpness control to go negative, not intensity control', () => {
    const ok = score({
      curves: [
        {
          control: 'sharpness',
          points: [
            { t: 0, value: -1 },
            { t: 5, value: 0 },
          ],
        },
      ],
    });
    const bad = score({
      curves: [
        {
          control: 'intensity',
          points: [
            { t: 0, value: -0.1 },
            { t: 5, value: 1 },
          ],
        },
      ],
    });
    expect(validateScore(ok)).toEqual([]);
    expect(validateScore(bad)).not.toEqual([]);
  });

  it('checks mixed-source weights', () => {
    const bad = score({
      source: {
        kind: 'mix',
        hints: [{ field: 'hardness', weight: 1.5, latencyMs: 20 }],
      },
    });
    expect(validateScore(bad)).not.toEqual([]);
  });

  it('validates base registrations', () => {
    expect(validateBase(base)).toEqual([]);
    expect(validateBase({ ...base, durationMs: 0 })).not.toEqual([]);
    expect(validateBase({ ...base, name: '' })).not.toEqual([]);
    expect(validateBase({ ...base, kind: 'transient', durationMs: 0 })).toEqual(
      []
    );
  });

  it('validates every command kind and survives a JSON round trip', () => {
    const commands: Command[] = [
      { op: 'defineBase', base },
      { op: 'base', name: 'hit', at: 1000, gain: 0.85 },
      { op: 'play', voice: 'swipe-1', score: score() },
      {
        op: 'revise',
        voice: 'swipe-1',
        from: 1050,
        score: score({ at: 1050 }),
      },
      {
        op: 'hold',
        voice: 'swipe-1',
        stream: 'blade-a',
        at: 1000,
        intensity: 0.3,
        sharpness: 0.6,
      },
      {
        op: 'drive',
        voice: 'swipe-1',
        stream: 'blade-a',
        at: 1016,
        intensity: 0.5,
        sharpness: 0.6,
        rampMs: 16,
      },
      {
        op: 'unhold',
        voice: 'swipe-1',
        stream: 'blade-a',
        at: 1100,
        fadeMs: 30,
      },
      { op: 'release', voice: 'swipe-1', at: 1200, fadeMs: 40 },
      {
        op: 'ask',
        voice: 'swipe-1',
        state: ['blade meets something hard.'],
        questions: [
          {
            id: 'hardness',
            kind: 'score',
            prompt: 'How hard is it?',
            options: ['soft', 'firm', 'hard'],
          },
        ],
      },
    ];
    for (const c of commands) expect(validateCommand(c)).toEqual([]);
    expect(JSON.parse(JSON.stringify(commands))).toEqual(commands);
  });

  it('rejects base gain outside 0.7..1 and drives without a voice', () => {
    expect(
      validateCommand({ op: 'base', name: 'hit', at: 0, gain: 0.5 })
    ).not.toEqual([]);
    expect(
      validateCommand({
        op: 'drive',
        voice: '',
        stream: 's',
        at: 0,
        intensity: 0.5,
        sharpness: 0.5,
        rampMs: 0,
      })
    ).not.toEqual([]);
  });
});
