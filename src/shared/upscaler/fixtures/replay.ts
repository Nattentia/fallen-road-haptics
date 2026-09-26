import { vi } from 'vitest';
import type { BaseVibration, Command, SoundFeatures } from '../contract';
import { UpscalerLink } from '../link';
import { HapticUpscaler } from '../upscaler';
import type { FixtureRecord, FixtureScenario } from './types';

/**
 * Replays a recorded scenario through the link and the upscaler on a fake
 * clock, task by task, as the game would. For tests and tools running under
 * vitest with fake setTimeout (`vi.useFakeTimers`).
 */

type Record = FixtureRecord;
type Scenario = FixtureScenario;

/** The same base for every action, as the demo game registers it. */
export const PLAIN: Omit<BaseVibration, 'name'> = {
  kind: 'continuous',
  intensity: 0.8,
  sharpness: 0.4,
  durationMs: 120,
};
export const BASE_NAMES = [
  'player_hit',
  'player_block',
  'player_guard_break',
  'player_death',
  'enemy_hit',
  'enemy_block',
  'parried',
  'enemy_guard_break',
  'counter',
  'burst_start',
  'enemy_kill',
  'boss_kill',
];

/** JS clock = game time + this. */
export const OFFSET = 50_000;

export const timeOf = (r: Record) => (r.kind === 'base' ? r.t : r.signal.t);

/** Replays a scenario task by task (records sharing a time form one task). */
export const replay = async (
  scenario: Scenario,
  extraMs = 1500,
  sounds?: Readonly<{ [id: string]: SoundFeatures }>
) => {
  let now = OFFSET;
  const batches: { at: number; commands: Command[] }[] = [];
  const engine = new HapticUpscaler();
  const link = new UpscalerLink(
    engine,
    (c) => batches.push({ at: now, commands: c }),
    () => now
  );
  link.define(BASE_NAMES.map((name) => ({ name, ...PLAIN })));
  if (sounds) link.defineSounds(sounds);
  const advance = async (to: number) => {
    if (to <= now) return;
    await vi.advanceTimersByTimeAsync(to - now);
    now = to;
  };
  let i = 0;
  const records = scenario.records;
  while (i < records.length) {
    const t = timeOf(records[i]!);
    // Timers fire at their own times: step there first.
    while (true) {
      const next = vi.getTimerCount() > 0 ? now + 1 : Infinity;
      if (next > t + OFFSET) break;
      await advance(Math.min(t + OFFSET, now + 5));
      if (now >= t + OFFSET) break;
    }
    await advance(t + OFFSET);
    now = Math.max(now, t + OFFSET);
    while (i < records.length && timeOf(records[i]!) === t) {
      const r = records[i]!;
      if (r.kind === 'base') link.base(r.name);
      else link.signal(r.signal);
      i += 1;
    }
    await Promise.resolve();
  }
  for (let k = 0; k < extraMs; k += 5) await advance(now + 5);
  return {
    batches,
    commands: batches.flatMap((b) => b.commands),
    engine,
    link,
  };
};

