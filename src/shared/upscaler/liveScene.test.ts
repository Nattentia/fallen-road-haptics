import { describe, expect, it } from 'vitest';
import type { EventSignal } from '../haptics/signals';
import { HapticUpscaler } from './upscaler';

const event = (infer?: EventSignal['infer']): EventSignal => ({
  kind: 'event', t: 1000, chain: { id: 'swing', step: 'resolve' },
  outcome: 'landed', description: 'enemy slash attack hits player',
  magnitude: 0.8, importance: 0.8, valence: 'neutral',
  actor: 'world', target: 'world', ...(infer ? { infer } : {}),
});

describe('reduced input live decisions', () => {
  it('plays a deterministic first score, then asks only for hidden fields', () => {
    const engine = new HapticUpscaler();
    const step = engine.consume(event(['valence', 'actor', 'target']), {
      now: 1000, gameToJs: 0, paired: false,
    });
    const first = step.commands.find((command) => command.op === 'play' || command.op === 'revise');
    const ask = step.commands.find((command) => command.op === 'ask');
    expect(first).toBeDefined();
    expect(ask?.op).toBe('ask');
    if (ask?.op !== 'ask') return;
    expect(ask.questions.map((question) => question.id)).toEqual([
      'valence', 'valence~rev', 'actor', 'actor~rev',
    ]);
    expect(ask.state).toContain('enemy slash attack hits player.');
    expect(ask.state.some((phrase) => phrase.startsWith('for player:') || phrase.startsWith('by:'))).toBe(false);
    expect(ask.requestId).toBeTruthy();
    if (!ask.requestId) return;

    const update = engine.hint({
      voice: 'swing', questionId: 'valence', requestId: ask.requestId,
      field: 'valence', value: 'bad', confidence: 0.8, latencyMs: 35,
    }, 1040);
    expect(update.commands.some((command) => command.op === 'revise')).toBe(true);
    expect(update.commands.filter((command) => command.op === 'play' || command.op === 'revise')
      .some((command) => command.score.source.kind === 'mix')).toBe(true);
  });

  it('ignores an answer to an old moment and never asks when the game supplied fields', () => {
    const engine = new HapticUpscaler();
    const full = engine.consume(event(), { now: 1000, gameToJs: 0, paired: false });
    expect(full.commands.some((command) => command.op === 'ask')).toBe(false);
    expect(engine.hint({
      voice: 'swing', questionId: 'valence', requestId: 'old',
      field: 'valence', value: 'bad', confidence: 1, latencyMs: 20,
    }, 1040).commands).toEqual([]);
  });
});
