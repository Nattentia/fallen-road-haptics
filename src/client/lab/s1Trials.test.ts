import { describe, expect, it } from 'vitest';
import { validateCommand } from '../../shared/upscaler/contract';
import { S1_TRIALS } from './s1Trials';

describe('S1 trials', () => {
  it('only send commands the contract accepts', () => {
    for (const trial of S1_TRIALS)
      for (const variant of trial.variants)
        for (const command of variant.commands(1000, 'lab-1'))
          expect({
            trial: trial.id,
            condition: variant.condition,
            issues: validateCommand(command),
          }).toEqual({
            trial: trial.id,
            condition: variant.condition,
            issues: [],
          });
  });

  it('never schedule anything before the start time', () => {
    for (const trial of S1_TRIALS)
      for (const variant of trial.variants)
        for (const command of variant.commands(1000, 'lab-1'))
          if ('at' in command) expect(command.at).toBeGreaterThanOrEqual(1000);
  });

  it('give every trial at least two answers and unique conditions', () => {
    for (const trial of S1_TRIALS) {
      expect(trial.answers.length).toBeGreaterThanOrEqual(2);
      const conditions = trial.variants.map((v) => v.condition);
      expect(new Set(conditions).size).toBe(conditions.length);
    }
  });
});
