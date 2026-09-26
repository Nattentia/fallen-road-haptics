import type { CurvePoint, SoundFeatures } from './contract';

/**
 * Sound effect analysis (v4 5, stage 5): what a sound gives the decoration.
 * - loudness: RMS envelope, relative to the sound's own peak;
 * - brightness: spectral centroid on a log scale (200 Hz → 0, 8 kHz → 1),
 *   the source of sharpness trajectories;
 * - noisiness: spectral flatness weighted by loudness, the source of grain
 *   density (a pure tone is 0, white noise is near 1).
 * Runs once per sound at load time; works on raw samples, so any decoder
 * (Web Audio in the game, ffmpeg in tests) can feed it.
 */

export const SOUND = {
  hopMs: 10,
  /** The sound ends where it stays this far below its peak (dB). */
  floorDb: -40,
  /** Curves are thinned to this many points (under the Core Haptics limit). */
  curvePoints: 12,
  brightLowHz: 200,
  brightHighHz: 8000,
  /** Band for noisiness (spectral flatness). */
  flatLowHz: 100,
  flatHighHz: 8000,
};

const clamp01 = (x: number): number =>
  Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;

/** In-place iterative radix-2 FFT; re and im have a power-of-two length. */
const fft = (re: Float64Array, im: Float64Array): void => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
};

type Frame = { t: number; rms: number; centroidHz: number; flatness: number };

const frames = (samples: Float32Array, sampleRate: number): Frame[] => {
  const hop = Math.max(1, Math.round((sampleRate * SOUND.hopMs) / 1000));
  let size = 1;
  while (size < hop * 2) size <<= 1;
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++)
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const out: Frame[] = [];
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let start = 0; start < samples.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const x = samples[start + i] ?? 0;
      energy += x * x;
      re[i] = x * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    // Centroid over magnitudes (power weighting lets the bass dominate);
    // flatness over the band where effect sounds carry energy, so empty
    // bins above a codec's low-pass do not read as a pure tone.
    let magnitude = 0;
    let weighted = 0;
    let bandPower = 0;
    let logSum = 0;
    let bandBins = 0;
    const bins = size / 2;
    for (let k = 1; k < bins; k++) {
      const hz = (k * sampleRate) / size;
      const p = re[k]! * re[k]! + im[k]! * im[k]! + 1e-20;
      const m = Math.sqrt(p);
      magnitude += m;
      weighted += m * hz;
      if (hz >= SOUND.flatLowHz && hz <= SOUND.flatHighHz) {
        bandPower += p;
        logSum += Math.log(p);
        bandBins += 1;
      }
    }
    out.push({
      t: (start / sampleRate) * 1000,
      rms: Math.sqrt(energy / size),
      centroidHz: magnitude > 0 ? weighted / magnitude : 0,
      flatness:
        bandBins > 0 ? Math.exp(logSum / bandBins) / (bandPower / bandBins) : 0,
    });
  }
  return out;
};

const brightnessOf = (hz: number): number =>
  clamp01(
    Math.log2(Math.max(hz, 1) / SOUND.brightLowHz) /
      Math.log2(SOUND.brightHighHz / SOUND.brightLowHz)
  );

/** Evenly spaced points (by time) of a per-frame series. */
const thin = (fs: Frame[], value: (f: Frame) => number): CurvePoint[] => {
  if (fs.length === 0) return [];
  const n = Math.min(SOUND.curvePoints, fs.length);
  const points: CurvePoint[] = [];
  for (let i = 0; i < n; i++) {
    const f = fs[Math.round((i * (fs.length - 1)) / Math.max(1, n - 1))]!;
    points.push({ t: Math.round(f.t), value: clamp01(value(f)) });
  }
  return points.filter((p, i) => i === 0 || p.t > points[i - 1]!.t);
};

export const analyzeSound = (
  samples: Float32Array,
  sampleRate: number
): SoundFeatures => {
  const all = frames(samples, sampleRate);
  const peak = Math.max(0, ...all.map((f) => f.rms));
  if (peak <= 0)
    return { durationMs: 0, brightness: [], loudness: [], noisiness: 0 };
  const floor = peak * 10 ** (SOUND.floorDb / 20);
  let last = 0;
  all.forEach((f, i) => {
    if (f.rms >= floor) last = i;
  });
  const first = all.findIndex((f) => f.rms >= floor);
  const live = all.slice(first, last + 1);
  const origin = live[0]!.t;
  const shifted = live.map((f) => ({ ...f, t: f.t - origin }));
  const weight = shifted.reduce((s, f) => s + f.rms, 0);
  const noisiness =
    weight > 0
      ? shifted.reduce((s, f) => s + f.rms * f.flatness, 0) / weight
      : 0;
  return {
    durationMs: Math.round(shifted.at(-1)!.t + SOUND.hopMs),
    loudness: thin(shifted, (f) => f.rms / peak),
    brightness: thin(shifted, (f) => brightnessOf(f.centroidHz)),
    noisiness: clamp01(noisiness),
  };
};
