import * as Phaser from 'phaser';

/**
 * Combat sound effects. Files live in public/assets/sfx as `<key>_<n>.ogg|.m4a`
 * (Kenney CC0 packs, see ASSETS.md). Each play picks a random variant and
 * nudges the pitch so repeated hits don't sound machine-gunned.
 */
const SFX = {
  swing_light: { variants: 3, volume: 0.45 },
  swing_heavy: { variants: 3, volume: 0.6 },
  hit_sword: { variants: 2, volume: 0.8 },
  hit_dagger: { variants: 3, volume: 0.7 },
  hit_spear: { variants: 3, volume: 0.75 },
  hit_hammer: { variants: 3, volume: 0.9 },
  hit_mace: { variants: 3, volume: 0.9 },
  hit_weak: { variants: 3, volume: 0.7 },
  enemy_block: { variants: 3, volume: 0.75 },
  parried: { variants: 2, volume: 0.85 },
  player_block: { variants: 3, volume: 0.8 },
  player_hit: { variants: 2, volume: 0.85 },
  counter: { variants: 2, volume: 0.7 },
  guard_break: { variants: 2, volume: 0.9 },
  dodge: { variants: 3, volume: 0.6 },
  telegraph: { variants: 3, volume: 0.5 },
  felled: { variants: 1, volume: 0.9 },
  ui_tap: { variants: 2, volume: 0.5 },
} as const;

export type SfxKey = keyof typeof SFX;

/** Fired on `game.events` for every sound played — the haptics tap point. */
export const SFX_EVENT = 'sfx';
export type SfxEvent = { key: SfxKey; variant: number; volume: number; t: number };

const variantKey = (key: SfxKey, n: number): string => `sfx_${key}_${n}`;

export const queueSfxLoads = (
  scene: Phaser.Scene,
  assetUrl: (path: string) => string
): void => {
  for (const [key, def] of Object.entries(SFX) as [SfxKey, (typeof SFX)[SfxKey]][]) {
    for (let n = 1; n <= def.variants; n++) {
      const cacheKey = variantKey(key, n);
      // Phaser picks the first format the browser can decode; iOS WebKit
      // may lack Ogg Vorbis, so every sound also ships as AAC.
      if (!scene.cache.audio.exists(cacheKey))
        scene.load.audio(cacheKey, [
          assetUrl(`assets/sfx/${key}_${n}.ogg`),
          assetUrl(`assets/sfx/${key}_${n}.m4a`),
        ]);
    }
  }
};

export const playSfx = (
  scene: Phaser.Scene,
  key: SfxKey,
  options: { volume?: number; detune?: number } = {}
): void => {
  const def = SFX[key];
  const variant = Phaser.Math.Between(1, def.variants);
  const cacheKey = variantKey(key, variant);
  // A missing or failed file stays silent rather than throwing mid-fight.
  if (!scene.cache.audio.exists(cacheKey)) return;
  const volume = def.volume * (options.volume ?? 1);
  scene.sound.play(cacheKey, {
    volume,
    detune: (options.detune ?? 0) + Phaser.Math.Between(-60, 60),
  });
  const event: SfxEvent = { key, variant, volume, t: scene.time.now };
  scene.game.events.emit(SFX_EVENT, event);
};
