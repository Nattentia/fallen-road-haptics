import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeSound } from '../src/shared/upscaler/sound';

/**
 * T3: analysis cost and whether features separate the game's sounds. Decodes
 * the shipped .ogg files with ffmpeg (skipped when it is missing) and runs
 * the same analysis the game runs on Web Audio buffers.
 */

const DIR = 'src/client/public/assets/sfx';
const RATE = 44100;

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const decode = (file) => {
  const out = execFileSync(
    'ffmpeg',
    ['-v', 'quiet', '-i', `${DIR}/${file}`, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-'],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
};

const mean = (curve) => curve.reduce((s, p) => s + p.value, 0) / Math.max(1, curve.length);

describe.runIf(hasFfmpeg)('T3: the game sounds', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ogg')).sort();
  const rows = files.map((file) => {
    const samples = decode(file);
    const started = performance.now();
    const f = analyzeSound(samples, RATE);
    return {
      file,
      key: file.replace(/_\d+\.ogg$/, ''),
      ms: performance.now() - started,
      durationMs: f.durationMs,
      brightness: mean(f.brightness),
      noisiness: f.noisiness,
    };
  });

  it('analyses each sound quickly enough to run at load', () => {
    if (process.env.T3_REPORT)
      console.table(
        rows.map((r) => ({
          file: r.file,
          ms: r.ms.toFixed(1),
          durationMs: r.durationMs,
          brightness: r.brightness.toFixed(2),
          noisiness: r.noisiness.toFixed(2),
        }))
      );
    const total = rows.reduce((s, r) => s + r.ms, 0);
    expect(total).toBeLessThan(2000);
    for (const r of rows) expect(r.durationMs).toBeGreaterThan(0);
  });

  it('gives different sounds different features', () => {
    const keys = [...new Set(rows.map((r) => r.key))];
    const centre = (k) => {
      const rs = rows.filter((r) => r.key === k);
      const avg = (f) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
      return [avg((r) => r.brightness), avg((r) => r.noisiness), avg((r) => Math.min(1, r.durationMs / 800))];
    };
    const c = new Map(keys.map((k) => [k, centre(k)]));
    let apart = 0;
    let pairs = 0;
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const a = c.get(keys[i]);
        const b = c.get(keys[j]);
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        pairs += 1;
        if (d > 0.05) apart += 1;
      }
    if (process.env.T3_REPORT) console.log(`apart ${apart}/${pairs}`);
    expect(apart / pairs).toBeGreaterThan(0.8);
  });
});
