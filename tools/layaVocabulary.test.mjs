import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gameVocabulary } from '../src/client/haptics/vocabulary';
import { stateVocabulary } from '../src/shared/haptics/signals';
import { LIVE_QUESTIONS } from '../src/shared/upscaler/questions';

/**
 * Exports what the phone's Laya inputs are assembled from: the live
 * questions (tokenized whole) and every state phrase (tokenized one by one,
 * joined on the device). tools/laya/prepare.py reads it on CI and proves the
 * joined tokens equal real tokenization. Run with UPDATE_FIXTURES=1 after a
 * change to the questions or to what the game can describe.
 */

const FILE = 'tools/laya/vocabulary.json';

const build = () => {
  const { descriptions, gauges } = gameVocabulary();
  return {
    questions: LIVE_QUESTIONS.map(({ question }) => ({
      id: question.id,
      type: question.kind,
      instructions: question.prompt,
      criteria: question.options,
    })),
    pieces: stateVocabulary(descriptions, gauges),
  };
};

const text = () => `${JSON.stringify(build(), null, 2)}\n`;

describe('laya vocabulary', () => {
  if (process.env.UPDATE_FIXTURES) writeFileSync(FILE, text());

  it('matches the exported file', () => {
    expect(existsSync(FILE)).toBe(true);
    expect(readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(text());
  });
});
