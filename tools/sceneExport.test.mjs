import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replay } from '../src/shared/upscaler/fixtures/replay';
import { SCENARIOS } from '../src/shared/upscaler/fixtures/scenarios';
import { exportScene, sceneFromCommands } from '../src/shared/upscaler/scene';
import { validateAhap } from '../src/shared/upscaler/score';
import { analyzeSound } from '../src/shared/upscaler/sound';

/**
 * Scene export for the README (plan units 8-1, 8-2). For each scene it
 * writes both.ahap (base + upscale, the file to tap on an iPhone), base.ahap,
 * upscale.ahap, curves.json and compare.svg into out/scenes/<name>/.
 *
 *   SCENES=1 npx vitest run tools/sceneExport.test.mjs
 *     the demo scenes, replayed from the recorded game scenarios
 *   SCENES=1 SCENE_JSONL=upscaler-….jsonl SCENE_WINDOWS=name:from-to,…
 *     windows (JS-clock ms) of a recording saved by the app
 */

/** The README's scenes, by recorded scenario. */
const DEMO = [
  'swipe-heavy-weak-point',
  'swipe-blocked',
  'swipe-boss-kill',
  'attack-blocked',
];
const WINDOW_MS = 1000;
const LEAD_MS = 20;

/**
 * The game's effects as the app analyses them at load (first variant of
 * each), so the scenes carry the sound texture. Empty without ffmpeg.
 */
const SFX_DIR = 'src/client/public/assets/sfx';
const gameSounds = () => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    return {};
  }
  const out = {};
  for (const file of readdirSync(SFX_DIR).filter((f) => f.endsWith('_1.ogg'))) {
    const buf = execFileSync(
      'ffmpeg',
      [
        '-v',
        'quiet',
        '-i',
        join(SFX_DIR, file),
        '-f',
        'f32le',
        '-ac',
        '1',
        '-ar',
        '44100',
        '-',
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    const samples = new Float32Array(
      buf.buffer,
      buf.byteOffset,
      buf.byteLength / 4
    );
    out[file.replace(/_1\.ogg$/, '')] = analyzeSound(samples, 44100);
  }
  return out;
};

const write = (name, out) => {
  const dir = join('out', 'scenes', name);
  mkdirSync(dir, { recursive: true });
  for (const [layer, ahap] of Object.entries(out.ahap))
    writeFileSync(join(dir, `${layer}.ahap`), JSON.stringify(ahap, null, 2));
  writeFileSync(join(dir, 'curves.json'), JSON.stringify(out.curves));
  writeFileSync(join(dir, 'compare.svg'), out.svg);
};

/** Commands of a recording, in the order the player got them. */
const recordedCommands = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === 'upscaler' && Array.isArray(row.commands))
    .flatMap((row) => row.commands);

const firstTime = (commands) =>
  Math.min(
    ...commands.flatMap((c) =>
      c.op === 'play' ? [c.score.at] : 'at' in c ? [c.at] : []
    )
  );

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('scene export', () => {
  it.runIf(process.env.SCENES)(
    'writes the demo scenes',
    { timeout: 60_000 },
    async () => {
      const sounds = gameSounds();
      for (const name of DEMO) {
        const scenario = SCENARIOS.find((s) => s.name === name);
        expect(scenario, name).toBeDefined();
        const { commands } = await replay(scenario, 1500, sounds);
        const from = firstTime(commands) - LEAD_MS;
        const out = exportScene(
          name,
          sceneFromCommands(commands),
          from,
          from + WINDOW_MS
        );
        for (const ahap of Object.values(out.ahap))
          expect(validateAhap(ahap)).toEqual([]);
        write(name, out);
      }
    }
  );

  it.runIf(process.env.SCENES && process.env.SCENE_JSONL)(
    'writes windows of a recording',
    () => {
      const commands = recordedCommands(process.env.SCENE_JSONL);
      const scene = sceneFromCommands(commands);
      const windows = (process.env.SCENE_WINDOWS ?? '')
        .split(',')
        .filter(Boolean)
        .map((w) => {
          const [name, range] = w.split(':');
          const [from, to] = range.split('-').map(Number);
          return { name, from, to };
        });
      if (windows.length === 0) {
        const from = firstTime(commands) - LEAD_MS;
        windows.push({ name: 'recording', from, to: from + WINDOW_MS });
      }
      for (const w of windows) {
        const out = exportScene(w.name, scene, w.from, w.to);
        for (const ahap of Object.values(out.ahap))
          expect(validateAhap(ahap)).toEqual([]);
        write(w.name, out);
      }
    }
  );
});
