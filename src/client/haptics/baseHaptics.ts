import type * as Phaser from 'phaser';

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
