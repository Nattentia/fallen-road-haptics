import type * as Phaser from 'phaser';
import type { BaseVibration } from '../../shared/upscaler/contract';

/**
 * The game's own vibration, as a typical mobile game ships it: one plain
 * buzz, identical for every action. It is the low-resolution input the
 * haptic upscaler starts from, so it deliberately carries no texture.
 * The action name travels with it so the native side can log it.
 */
export type BaseHapticAction =
  | 'player_hit' // an enemy attack lands in full
  | 'player_block' // the shield takes an enemy attack
  | 'player_guard_break' // the shield is destroyed
  | 'player_death'
  | 'enemy_hit' // a strike or burst hit lands
  | 'enemy_block' // the enemy guards a strike
  | 'parried' // the enemy's counter stance catches a strike
  | 'enemy_guard_break'
  | 'counter' // perfect block or perfect dodge
  | 'burst_start'
  | 'enemy_kill'
  | 'boss_kill';

/** Fired on `game.events` for every base vibration — the haptics tap point. */
export const BASE_HAPTIC_EVENT = 'baseHaptic';
export type BaseHapticEvent = { action: BaseHapticAction; t: number };

export const playBaseHaptic = (
  scene: Phaser.Scene,
  action: BaseHapticAction
): void => {
  const event: BaseHapticEvent = { action, t: scene.time.now };
  scene.game.events.emit(BASE_HAPTIC_EVENT, event);
};

/** The one plain buzz every action plays: any vibration motor could do it. */
const PLAIN_BUZZ = {
  kind: 'continuous',
  intensity: 0.8,
  sharpness: 0.4,
  durationMs: 120,
} as const;

const ACTIONS: readonly BaseHapticAction[] = [
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

/** The game's base vibrations as it registers them with the upscaler. */
export const BASE_VIBRATIONS: readonly BaseVibration[] = ACTIONS.map(
  (name) => ({ name, ...PLAIN_BUZZ })
);
