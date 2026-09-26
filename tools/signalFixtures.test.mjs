import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/client/haptics/scenarios';

/**
 * Keeps the upscaler's signal fixtures in step with the game adapter. The
 * fixtures are generated from scripted scenarios; run with
 * UPDATE_FIXTURES=1 to rewrite them after an intended adapter change.
 */

const DIR = 'src/shared/upscaler/fixtures';
const file = (name) => join(DIR, `${name}.json`);
const text = (scenario) => `${JSON.stringify(scenario, null, 2)}\n`;

describe('signal fixtures', () => {
  if (process.env.UPDATE_FIXTURES) {
    mkdirSync(DIR, { recursive: true });
    for (const s of SCENARIOS) writeFileSync(file(s.name), text(s));
  }

  it.each(SCENARIOS.map((s) => [s.name, s]))(
    '%s matches the adapter',
    (name, s) => {
      expect(existsSync(file(name))).toBe(true);
      expect(readFileSync(file(name), 'utf8').replace(/\r\n/g, '\n')).toBe(
        text(s)
      );
    }
  );

  it('every scenario closes every chain it opens', () => {
    for (const s of SCENARIOS) {
      const open = new Map();
      for (const r of s.records) {
        const chain = r.kind === 'signal' ? r.signal.chain : undefined;
        if (!chain) continue;
        if (chain.step === 'start') open.set(chain.id, true);
        if (['end', 'cancel'].includes(chain.step)) open.delete(chain.id);
        if (chain.step === 'resolve') open.set(chain.id, false);
      }
      const dangling = [...open]
        .filter(([, unresolved]) => unresolved)
        .map(([id]) => id);
      expect({ scenario: s.name, dangling }).toEqual({
        scenario: s.name,
        dangling: [],
      });
    }
  });

  it('pairs every base vibration with a signal naming it', () => {
    for (const s of SCENARIOS) {
      const bases = s.records
        .filter((r) => r.kind === 'base')
        .map((r) => r.name)
        .sort();
      const named = s.records
        .filter(
          (r) =>
            r.kind === 'signal' && r.signal.kind === 'event' && r.signal.base
        )
        .map((r) => r.signal.base)
        .sort();
      expect({ scenario: s.name, bases }).toEqual({
        scenario: s.name,
        bases: named,
      });
    }
  });
});
