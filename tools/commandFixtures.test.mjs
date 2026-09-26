import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCommand } from '../src/shared/upscaler/contract';
import { COMMAND_OPS, SAMPLE_COMMANDS } from '../src/shared/upscaler/samples';

/**
 * Exports one example of every player command for the Swift tests, which
 * decode the same file. Run with UPDATE_FIXTURES=1 after a contract change.
 */

const FILE = 'ios/AppTests/Fixtures/commands.json';
const text = `${JSON.stringify(SAMPLE_COMMANDS, null, 2)}\n`;

describe('command fixtures', () => {
  if (process.env.UPDATE_FIXTURES) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, text);
  }

  it('covers every command kind with a valid example', () => {
    expect(SAMPLE_COMMANDS.map((c) => c.op)).toEqual([...COMMAND_OPS]);
    for (const c of SAMPLE_COMMANDS) expect(validateCommand(c)).toEqual([]);
  });

  it('matches the file the Swift tests decode', () => {
    expect(existsSync(FILE)).toBe(true);
    expect(readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(text);
  });
});
