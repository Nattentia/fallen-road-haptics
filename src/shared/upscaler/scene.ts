import type { BaseVibration, Command, Score } from './contract';
import { baseScore } from './mixer';
import { plotSvg, sampleLayer, type Sample } from './plot';
import { clipScore, mergeToAhap, truncateScore, type Ahap } from './score';

/**
 * Scene export (plan units 8-1, 8-2): the commands the player received,
 * from a recording (the app's `upscaler-*.jsonl`) or a replayed scenario,
 * rebuilt into what was felt, per layer. A window of it becomes AHAP files
 * (both layers, base alone, upscale alone), sampled curves and a graph.
 */

export type Scene = { base: Score[]; upscale: Score[] };

const held = (
  voice: string,
  from: number,
  until: number,
  intensity: number,
  sharpness: number
): Score => ({
  id: `${voice}@${from}`,
  at: from,
  layer: 'upscale',
  source: { kind: 'rule' },
  events: [
    { kind: 'continuous', t: 0, duration: until - from, intensity, sharpness },
  ],
  curves: [],
});

export const sceneFromCommands = (commands: readonly Command[]): Scene => {
  const bases = new Map<string, BaseVibration>();
  const base: Score[] = [];
  const voices = new Map<string, Score[]>();
  const holds = new Map<
    string,
    { voice: string; at: number; intensity: number; sharpness: number }
  >();
  const done: Score[] = [];
  let last = 0;

  const cutVoice = (voice: string, at: number) => {
    const kept = (voices.get(voice) ?? [])
      .map((s) => (s.at >= at ? null : truncateScore(s, at)))
      .filter((s): s is Score => s !== null && s.events.length > 0);
    voices.set(voice, kept);
  };
  const closeHold = (key: string, at: number) => {
    const h = holds.get(key);
    if (!h) return;
    holds.delete(key);
    if (at > h.at) done.push(held(h.voice, h.at, at, h.intensity, h.sharpness));
  };

  for (const c of commands) {
    switch (c.op) {
      case 'defineBase':
        bases.set(c.base.name, c.base);
        break;
      case 'base': {
        const def = bases.get(c.name);
        if (def) base.push(baseScore(def, c.at, c.gain));
        last = Math.max(last, c.at);
        break;
      }
      case 'play':
        voices.set(c.voice, [...(voices.get(c.voice) ?? []), c.score]);
        last = Math.max(last, c.score.at);
        break;
      case 'revise':
        cutVoice(c.voice, c.from);
        voices.set(c.voice, [...(voices.get(c.voice) ?? []), c.score]);
        last = Math.max(last, c.from);
        break;
      case 'hold':
        holds.set(`${c.voice}/${c.stream}`, {
          voice: c.voice,
          at: c.at,
          intensity: c.intensity,
          sharpness: c.sharpness,
        });
        last = Math.max(last, c.at);
        break;
      case 'drive': {
        const key = `${c.voice}/${c.stream}`;
        if (!holds.has(key)) break;
        closeHold(key, c.at);
        holds.set(key, {
          voice: c.voice,
          at: c.at,
          intensity: c.intensity,
          sharpness: c.sharpness,
        });
        last = Math.max(last, c.at);
        break;
      }
      case 'unhold':
        closeHold(`${c.voice}/${c.stream}`, c.at);
        last = Math.max(last, c.at);
        break;
      case 'release':
        cutVoice(c.voice, c.at);
        for (const [key, h] of [...holds])
          if (h.voice === c.voice) closeHold(key, c.at);
        last = Math.max(last, c.at);
        break;
      case 'ask':
        break;
    }
  }
  // Holds still open at the end of the recording last until its end.
  for (const key of [...holds.keys()]) closeHold(key, last);
  return { base, upscale: [...[...voices.values()].flat(), ...done] };
};

/** The part of each score inside [from, to). */
const within = (scores: readonly Score[], from: number, to: number): Score[] =>
  scores
    .filter((s) => s.at < to)
    .map((s) => truncateScore(s.at < from ? clipScore(s, from, s.id) : s, to))
    .filter((s) => s.events.length > 0);

export type SceneExport = {
  ahap: { both: Ahap; base: Ahap; upscale: Ahap };
  /** Samples every 2 ms, t in ms from the window start. */
  curves: { base: Sample[]; upscale: Sample[] };
  svg: string;
};

export const exportScene = (
  title: string,
  scene: Scene,
  from: number,
  to: number
): SceneExport => {
  const base = within(scene.base, from, to);
  const upscale = within(scene.upscale, from, to);
  // sampleLayer already counts t from the window start.
  const curves = {
    base: sampleLayer(base, from, to),
    upscale: sampleLayer(upscale, from, to),
  };
  return {
    ahap: {
      both: mergeToAhap([...base, ...upscale], from),
      base: mergeToAhap(base, from),
      upscale: mergeToAhap(upscale, from),
    },
    curves,
    svg: plotSvg(title, [
      { label: 'base', colour: '#888', samples: curves.base },
      { label: 'upscale', colour: '#c0392b', samples: curves.upscale },
    ]),
  };
};
