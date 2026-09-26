import { describe, expect, it } from 'vitest';
import { validateCommand } from './contract';
import { decidedness, LIVE_QUESTIONS, toHint } from './questions';

describe('live questions', () => {
  it('are valid ask commands with one value per option', () => {
    const ask = {
      op: 'ask' as const,
      voice: 'v',
      state: ['x.'],
      questions: LIVE_QUESTIONS.map((q) => q.question),
    };
    expect(validateCommand(ask)).toEqual([]);
    for (const q of LIVE_QUESTIONS) {
      expect(q.values).toHaveLength(q.question.options.length);
      expect(q.question.kind).toBe('choice');
      expect(q.question.id).toBe(q.field);
    }
  });

  it('measures how decided an answer is', () => {
    expect(decidedness([1, 0, 0])).toBe(1);
    expect(decidedness([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(0);
    expect(decidedness([0.7, 0.2, 0.1])).toBeGreaterThan(
      decidedness([0.4, 0.3, 0.3])
    );
  });

  it('reads scales as expected values and the contact as the likeliest', () => {
    const hardness = LIVE_QUESTIONS.find((q) => q.field === 'hardness')!;
    const h = toHint(hardness, 'v', [0, 0, 0, 0.5, 0.5], 12);
    expect(h).toMatchObject({ field: 'hardness', value: 0.875, latencyMs: 12 });
    const contact = LIVE_QUESTIONS.find((q) => q.field === 'contact')!;
    expect(toHint(contact, 'v', [0.1, 0.6, 0.1, 0.1, 0.1], 5)).toMatchObject({
      field: 'contact',
      value: 'thrust',
    });
    expect(toHint(contact, 'v', [0.5, 0.5], 5)).toBeNull();
  });
});
