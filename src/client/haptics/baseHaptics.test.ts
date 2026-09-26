import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../../shared/upscaler/fixtures/scenarios';
import { validateBase } from '../../shared/upscaler/contract';
import { BASE_VIBRATIONS } from './baseHaptics';

describe('base vibrations', () => {
  it('registers one valid, identical plain buzz per action', () => {
    expect(BASE_VIBRATIONS).toHaveLength(12);
    for (const b of BASE_VIBRATIONS) expect(validateBase(b)).toEqual([]);
    const shapes = new Set(
      BASE_VIBRATIONS.map(
        (b) => `${b.kind}/${b.intensity}/${b.sharpness}/${b.durationMs}`
      )
    );
    expect(shapes.size).toBe(1);
  });

  it('covers every base the game plays in the recorded moments', () => {
    const names = new Set(BASE_VIBRATIONS.map((b) => b.name));
    for (const s of SCENARIOS)
      for (const r of s.records)
        if (r.kind === 'base') expect(names.has(r.name)).toBe(true);
  });
});
