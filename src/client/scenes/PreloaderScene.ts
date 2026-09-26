import * as Phaser from 'phaser';
import { queueSfxLoads, SFX_LOADED_EVENT } from '../audio/sfx';

type ManifestImage = { key: string; file: string };

const assetUrl = (path: string): string => {
  const version = import.meta.env.VITE_ASSET_VERSION;
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
};

/**
 * Entries from public/assets/manifest.json — the drop-in art pipeline
 * described in ASSETS.md. Malformed or missing manifests yield no entries.
 */
const manifestImages = (raw: unknown): ManifestImage[] => {
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' &&
        raw !== null &&
        'images' in raw &&
        Array.isArray(raw.images)
      ? raw.images
      : [];
  const out: ManifestImage[] = [];
  for (const entry of entries) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'key' in entry &&
      'file' in entry &&
      typeof entry.key === 'string' &&
      typeof entry.file === 'string'
    ) {
      out.push({ key: entry.key, file: entry.file });
    }
  }
  return out;
};

/**
 * Loads any art listed in assets/manifest.json, then generates procedural
 * fallback textures for whatever wasn't supplied (dusk sky gradient, fog,
 * grain, vignette). Supplied art that uses the ASSETS.md keys replaces the
 * matching fallback automatically.
 */
export class PreloaderScene extends Phaser.Scene {
  constructor() {
    super('Preloader');
  }

  preload(): void {
    this.load.json('asset-manifest', assetUrl('assets/manifest.json'));
  }

  create(): void {
    for (const { key, file } of manifestImages(
      this.cache.json.get('asset-manifest')
    )) {
      if (!this.textures.exists(key))
        this.load.image(key, assetUrl(`assets/${file}`));
    }
    queueSfxLoads(this, assetUrl);
    if (this.load.list.size > 0) {
      // A missing file logs a load error and simply keeps its fallback.
      this.load.once(Phaser.Loader.Events.COMPLETE, () => this.finishBoot());
      this.load.start();
    } else {
      this.finishBoot();
    }
  }

  private finishBoot(): void {
    // Supplied sky art is panoramic and drawn aspect-preserving; the
    // procedural gradient below is meant to be stretched full-screen.
    this.registry.set('skyIsArt', this.textures.exists('sky_painting'));
    this.makeSkyTexture();
    this.makeFogTexture();
    this.makeGrainTexture();
    this.makeVignetteTexture();
    this.game.events.emit(SFX_LOADED_EVENT);
    this.scene.start('Home');
  }

  /** Vertical twilight gradient: deep indigo down to a burning horizon. */
  private makeSkyTexture(): void {
    if (this.textures.exists('sky_painting')) return;
    const w = 16;
    const h = 512;
    const canvas = this.textures.createCanvas('sky_painting', w, h);
    if (!canvas) return;
    const ctx = canvas.getContext();
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, '#171226');
    gradient.addColorStop(0.42, '#453054');
    gradient.addColorStop(0.6, '#8a4a3c');
    gradient.addColorStop(0.66, '#b05c33');
    gradient.addColorStop(0.74, '#3a2a40');
    gradient.addColorStop(1, '#1a1428');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    canvas.refresh();
  }

  /** Soft horizontal fog band with faded top and bottom edges. */
  private makeFogTexture(): void {
    if (this.textures.exists('fog_band')) return;
    const w = 256;
    const h = 64;
    const canvas = this.textures.createCanvas('fog_band', w, h);
    if (!canvas) return;
    const ctx = canvas.getContext();
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(138, 122, 154, 0)');
    gradient.addColorStop(0.5, 'rgba(138, 122, 154, 0.55)');
    gradient.addColorStop(1, 'rgba(138, 122, 154, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    canvas.refresh();
  }

  /** Tiled speckle noise that reads as film grain. */
  private makeGrainTexture(): void {
    if (this.textures.exists('grain_tile')) return;
    const size = 256;
    const canvas = this.textures.createCanvas('grain_tile', size, size);
    if (!canvas) return;
    const ctx = canvas.getContext();
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const dark = Math.random() < 0.5;
      const alpha = 0.04 + Math.random() * 0.08;
      ctx.fillStyle = dark
        ? `rgba(0, 0, 0, ${alpha})`
        : `rgba(232, 224, 216, ${alpha})`;
      const s = Math.random() < 0.85 ? 1 : 2;
      ctx.fillRect(x, y, s, s);
    }
    canvas.refresh();
  }

  /** Soft radial darkening toward the screen edges. */
  private makeVignetteTexture(): void {
    if (this.textures.exists('vignette_tile')) return;
    const w = 320;
    const h = 180;
    const canvas = this.textures.createCanvas('vignette_tile', w, h);
    if (!canvas) return;
    const ctx = canvas.getContext();
    const gradient = ctx.createRadialGradient(
      w / 2,
      h / 2,
      h * 0.42,
      w / 2,
      h / 2,
      w * 0.62
    );
    gradient.addColorStop(0, 'rgba(5, 3, 10, 0)');
    gradient.addColorStop(1, 'rgba(5, 3, 10, 0.55)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    canvas.refresh();
  }
}
