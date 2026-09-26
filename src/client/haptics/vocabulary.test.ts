import { describe, expect, it } from 'vitest';
import { stateVocabulary, statePhrases } from '../../shared/haptics/signals';
import { SCENARIOS } from '../../shared/upscaler/fixtures/scenarios';
import { gameVocabulary } from './vocabulary';

describe('game vocabulary', () => {
  const { descriptions, gauges } = gameVocabulary();
  const pieces = new Set(stateVocabulary(descriptions, gauges));

  it('finds every description the recorded moments use', () => {
    const missing: string[] = [];
    for (const s of SCENARIOS)
      for (const r of s.records) {
        if (r.kind !== 'signal') continue;
        const sig = r.signal;
        if (!('description' in sig) || !sig.description) continue;
        const known = sig.kind === 'gauge' ? gauges : descriptions;
        if (!known.includes(sig.description)) missing.push(sig.description);
      }
    expect(missing).toEqual([]);
  });

  it('covers every phrase the live state can be made of', () => {
    for (const s of SCENARIOS)
      for (const r of s.records) {
        if (r.kind !== 'signal') continue;
        const sig = r.signal;
        if (sig.kind !== 'event' && sig.kind !== 'stream') continue;
        const withGauges = gauges.map((description, i) => ({
          description,
          value: i / Math.max(1, gauges.length - 1),
        }));
        for (const p of statePhrases(sig, withGauges))
          expect(pieces.has(p)).toBe(true);
      }
  });

  it('has clean pieces: no leading, trailing or doubled spaces', () => {
    for (const p of pieces) expect(p).toMatch(/^\S+( \S+)*$/);
  });
});
