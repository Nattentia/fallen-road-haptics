import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/shared/upscaler/fixtures/scenarios';
import { baseScore } from '../src/shared/upscaler/mixer';
import { plotSvg, sampleLayer } from '../src/shared/upscaler/plot';
import { HapticUpscaler } from '../src/shared/upscaler/upscaler';

/**
 * Draws every scenario's base and upscale layers as SVG in out/plots, so the
 * shapes can be checked without a phone. Runs only with PLOT=1.
 */

const PLAIN = {
  kind: 'continuous',
  intensity: 0.8,
  sharpness: 0.4,
  durationMs: 120,
};

const run = (scenario) => {
  const engine = new HapticUpscaler();
  const bases = new Map();
  const scores = [];
  const baseScores = [];
  const pendingBases = [];
  let origin = null;
  for (const r of scenario.records) {
    const now = (r.kind === 'base' ? r.t : r.signal.t) + 10_000;
    if (r.kind === 'base') {
      if (!bases.has(r.name)) {
        bases.set(r.name, { name: r.name, ...PLAIN });
        engine.define([bases.get(r.name)]);
      }
      pendingBases.push(r.name);
      continue;
    }
    const s = r.signal;
    const paired =
      s.kind === 'event' &&
      s.base !== undefined &&
      pendingBases.includes(s.base);
    if (s.kind === 'event' && s.base && !bases.has(s.base)) {
      bases.set(s.base, { name: s.base, ...PLAIN });
      engine.define([bases.get(s.base)]);
    }
    const step = engine.consume(s, { now, gameToJs: 10_000, paired });
    if (paired) {
      pendingBases.splice(pendingBases.indexOf(s.base), 1);
      baseScores.push(baseScore(bases.get(s.base), now, step.baseGain));
    } else if (s.kind === 'event' && s.base) {
      // Signal came first; its base follows in the same task.
      baseScores.push(baseScore(bases.get(s.base), now, step.baseGain));
    }
    for (const c of step.commands) {
      if (c.op !== 'play' && c.op !== 'revise') continue;
      if (c.op === 'revise')
        for (let i = scores.length - 1; i >= 0; i--)
          if (scores[i].voice === c.voice && scores[i].score.at < c.from)
            scores.splice(i, 1);
      scores.push({ voice: c.voice, score: c.score });
      origin ??= c.score.at;
    }
    if (step.commands.length > 0) origin ??= now;
  }
  return {
    scores: scores.map((s) => s.score),
    baseScores,
    origin: origin ?? 10_000,
  };
};

describe('plots', () => {
  it.runIf(process.env.PLOT)('writes one SVG per scenario', () => {
    mkdirSync('out/plots', { recursive: true });
    for (const scenario of SCENARIOS) {
      const { scores, baseScores, origin } = run(scenario);
      const from = origin - 20;
      const to = from + 1000;
      const svg = plotSvg(scenario.name, [
        {
          label: 'base',
          colour: '#888',
          samples: sampleLayer(baseScores, from, to),
        },
        {
          label: 'upscale',
          colour: '#c0392b',
          samples: sampleLayer(scores, from, to),
        },
      ]);
      writeFileSync(`out/plots/${scenario.name}.svg`, svg);
    }
    expect(true).toBe(true);
  });
});
