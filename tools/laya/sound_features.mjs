// Sound features for the D5 sound experiment: runs the upscaler's own
// analysis (src/shared/upscaler/sound.ts) on every .ogg/.wav in a folder.
// Usage: node --experimental-strip-types tools/laya/sound_features.mjs <dir> <out.json>
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeSound } from '../../src/shared/upscaler/sound.ts';

const RATE = 44100;
const [dir, out] = process.argv.slice(2);

const decode = (file) => {
  const buf = execFileSync(
    'ffmpeg',
    ['-v', 'quiet', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-'],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

const mean = (curve) => curve.reduce((s, p) => s + p.value, 0) / Math.max(1, curve.length);

const rows = {};
for (const name of readdirSync(dir).filter((f) => /\.(ogg|wav)$/.test(f)).sort()) {
  const samples = decode(join(dir, name));
  const f = analyzeSound(samples, RATE);
  // Absolute level is not part of the upscaler features (curves are relative
  // to the sound's own peak); keep the file's peak for reference only.
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  const below = f.loudness.find((p, i) => i > 0 && p.value < 0.25);
  rows[name] = {
    durationMs: f.durationMs,
    decayMs: below ? below.t : f.durationMs,
    brightness: +mean(f.brightness).toFixed(3),
    brightnessStart: f.brightness[0]?.value ?? 0,
    noisiness: +f.noisiness.toFixed(3),
    peakDb: +(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(1),
  };
}
writeFileSync(out, JSON.stringify(rows, null, 2) + '\n');
console.table(rows);
