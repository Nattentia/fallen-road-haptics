import { describe, expect, it } from 'vitest';
import { seeded } from './rng';
import { analyzeSound, SOUND } from './sound';

const RATE = 44100;

const make = (ms: number, sample: (t: number, i: number) => number) => {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = sample(i / RATE, i);
  return out;
};

const sine = (hz: number, ms = 300, decay = 0) =>
  make(ms, (t) => Math.sin(2 * Math.PI * hz * t) * Math.exp(-decay * t) * 0.5);

const noise = (ms = 300) => {
  const r = seeded(5);
  return make(ms, () => (r() * 2 - 1) * 0.5);
};

describe('sound analysis', () => {
  it('tells a pure tone from noise', () => {
    expect(analyzeSound(sine(440), RATE).noisiness).toBeLessThan(0.1);
    expect(analyzeSound(noise(), RATE).noisiness).toBeGreaterThan(0.5);
  });

  it('places brightness on a log scale between 200 Hz and 8 kHz', () => {
    const mean = (hz: number) => {
      const b = analyzeSound(sine(hz), RATE).brightness;
      return b.reduce((s, p) => s + p.value, 0) / b.length;
    };
    expect(mean(300)).toBeLessThan(0.25);
    expect(mean(6000)).toBeGreaterThan(0.8);
    expect(mean(1500)).toBeGreaterThan(mean(300));
  });

  it('follows a decaying sound and ends where it fades out', () => {
    const f = analyzeSound(sine(800, 1000, 12), RATE);
    const l = f.loudness;
    expect(l[0]!.value).toBeGreaterThan(l.at(-1)!.value);
    // −40 dB at a decay of 12/s is about 380 ms.
    expect(f.durationMs).toBeGreaterThan(300);
    expect(f.durationMs).toBeLessThan(500);
  });

  it('keeps curves short, ordered and within 0..1', () => {
    for (const s of [sine(440), noise(), sine(3000, 800, 4)]) {
      const f = analyzeSound(s, RATE);
      for (const curve of [f.loudness, f.brightness]) {
        expect(curve.length).toBeGreaterThanOrEqual(2);
        expect(curve.length).toBeLessThanOrEqual(SOUND.curvePoints);
        curve.forEach((p, i) => {
          expect(p.value).toBeGreaterThanOrEqual(0);
          expect(p.value).toBeLessThanOrEqual(1);
          if (i > 0) expect(p.t).toBeGreaterThan(curve[i - 1]!.t);
        });
      }
    }
  });

  it('trims leading silence and handles pure silence', () => {
    const late = new Float32Array(RATE);
    late.set(sine(1000, 200), RATE / 2);
    const f = analyzeSound(late, RATE);
    expect(f.loudness[0]!.t).toBe(0);
    expect(f.durationMs).toBeLessThan(300);
    expect(analyzeSound(new Float32Array(1000), RATE)).toEqual({
      durationMs: 0,
      brightness: [],
      loudness: [],
      noisiness: 0,
    });
  });

  it('works at other sample rates', () => {
    const at48 = new Float32Array(48000 * 0.3);
    for (let i = 0; i < at48.length; i++)
      at48[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
    expect(analyzeSound(at48, 48000).noisiness).toBeLessThan(0.1);
  });
});
