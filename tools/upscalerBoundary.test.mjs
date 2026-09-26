import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../src/shared/balance/weapons';
import {
  ENEMIES,
  GATEKEEPER,
  FALLEN_KING,
} from '../src/shared/balance/enemies';
import { HIT_ZONE_BALANCE } from '../src/shared/balance/hitZones';
import * as gambits from '../src/shared/run/gambits';

/**
 * The upscaler body must not know any game. Its vocabulary list is pulled
 * from the demo game's own data (every id, name and label string), so the
 * check grows with the game instead of relying on a hand-kept list.
 */

const BODY_DIRS = ['src/shared/upscaler', 'src/shared/haptics'];

/** Everyday words the game data happens to use and the body may use too. */
const GENERIC = new Set([
  'full',
  'high',
  'open',
  'edge',
  'last',
  'long',
  'quick',
  'second',
  'center',
  'break',
  'focus',
  'thrust',
]);

const words = (text) =>
  text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4);

const LABEL_KEYS = new Set([
  'id',
  'name',
  'archetype',
  'style',
  'label',
  'title',
]);

const collect = (value, out, key = '') => {
  if (typeof value === 'string') {
    if (LABEL_KEYS.has(key)) for (const w of words(value)) out.add(w);
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, out, key);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collect(v, out, k);
  }
};

export const gameVocabulary = () => {
  const out = new Set();
  collect([WEAPONS, ENEMIES, GATEKEEPER, FALLEN_KING, gambits], out);
  for (const zone of Object.keys(HIT_ZONE_BALANCE))
    for (const w of words(zone)) out.add(w);
  for (const g of GENERIC) out.delete(g);
  return out;
};

const bodyFiles = () =>
  BODY_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(dir, f))
  );

const leaks = (text, vocabulary) => {
  const found = new Set();
  for (const w of words(text)) if (vocabulary.has(w)) found.add(w);
  return [...found];
};

describe('upscaler boundary', () => {
  const vocabulary = gameVocabulary();

  it('pulls a non-trivial vocabulary from the game data', () => {
    expect(vocabulary.size).toBeGreaterThan(40);
    for (const w of ['sword', 'duelist', 'torso', 'riposte'])
      expect(vocabulary.has(w)).toBe(true);
  });

  it('finds game words when they are present', () => {
    expect(leaks('const swordHit = torsoZone;', vocabulary)).toEqual([
      'sword',
      'torso',
    ]);
  });

  it('keeps every game word out of the upscaler body', () => {
    const files = bodyFiles();
    expect(files.length).toBeGreaterThan(2);
    const report = files
      .map((f) => [f, leaks(readFileSync(f, 'utf8'), vocabulary)])
      .filter(([, found]) => found.length > 0);
    expect(report).toEqual([]);
  });
});
