import * as Phaser from 'phaser';
import { AUTO, Game } from 'phaser';
import { BootScene } from './scenes/BootScene';
import { PreloaderScene } from './scenes/PreloaderScene';
import { HomeScene } from './scenes/HomeScene';
import { BattleScene } from './scenes/BattleScene';
import { RewardScene } from './scenes/RewardScene';
import { installContactProbe } from './debug/contactProbe';

/**
 * Fixed logical resolution of 1280x720, scaled to fit the web view while
 * preserving aspect ratio. All gameplay coordinates (gesture thresholds, hit
 * zones, HUD layout) are expressed in this logical space.
 */
const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  parent: 'game-container',
  backgroundColor: '#141008',
  disableContextMenu: true,
  input: {
    activePointers: 3,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1280,
    height: 720,
  },
  scene: [BootScene, PreloaderScene, HomeScene, BattleScene, RewardScene],
};

document.addEventListener('DOMContentLoaded', () => {
  const game = new Game(config);
  // Debug handle for local preview tooling (synthetic DOM events don't reach
  // Phaser's input manager reliably); harmless in the Reddit webview.
  (window as unknown as { __game?: Game }).__game = game;
  installContactProbe(game);
});
