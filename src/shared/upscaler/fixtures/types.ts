import type { Signal } from '../../haptics/signals';

/** One recorded moment: the game's base vibrations and signals in order. */
export type FixtureRecord =
  | { kind: 'base'; name: string; t: number }
  | { kind: 'signal'; signal: Signal };

export type FixtureScenario = { name: string; records: FixtureRecord[] };
