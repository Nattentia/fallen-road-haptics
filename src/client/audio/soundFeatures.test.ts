import { describe, expect, it } from 'vitest';
import { analyzeLoaded, mixdown } from './soundFeatures';

const tone = (channels: number) => {
  const data = Array.from({ length: channels }, (_, c) => {
    const d = new Float32Array(4410);
    for (let i = 0; i < d.length; i++)
      d[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * (c + 1) * 0.2;
    return d;
  });
  return {
    numberOfChannels: channels,
    sampleRate: 44100,
    getChannelData: (c: number) => data[c]!,
  };
};

describe('loaded sound analysis', () => {
  it('mixes channels down by averaging', () => {
    const m = mixdown(tone(2));
    expect(m[100]).toBeCloseTo(
      (tone(2).getChannelData(0)[100]! + tone(2).getChannelData(1)[100]!) / 2
    );
    const mono = tone(1);
    expect(mixdown(mono)).toBe(mono.getChannelData(0));
  });

  it('analyses every decoded sound, one per step, and skips the rest', () => {
    const steps: (() => void)[] = [];
    let result: Record<string, unknown> | null = null;
    analyzeLoaded(
      [
        { id: 'a', sound: tone(1) },
        { id: 'missing', sound: undefined },
        { id: 'b', sound: tone(2) },
      ],
      (f) => {
        result = f;
      },
      (s) => steps.push(s)
    );
    let n = 0;
    while (steps.length > 0) {
      steps.shift()!();
      n += 1;
    }
    expect(n).toBe(4);
    expect(Object.keys(result ?? {})).toEqual(['a', 'b']);
  });
});
