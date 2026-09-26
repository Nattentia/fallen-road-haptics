import type { Material as SignalMaterial } from '../haptics/signals';
import type { ContactCharacter, Hint, HintUse } from './contract';
import { DEFAULT_MATERIAL, type Material } from './phrase';

/**
 * Material of a moment: the game's own values first, the deterministic
 * default otherwise, and live hints blended in by calibrated confidence:
 * value = rule + w × (hint − rule), w = confidence above the threshold, else 0.
 */

/** Confidence below which a hint weighs nothing (calibrated in stage 4). */
export const HINT_THRESHOLD = 0.5;

/** What each contact character does to the material, at full weight. */
const CHARACTER: Record<ContactCharacter, Partial<Material>> = {
  cut: { hardness: 0.75, weight: 0.3 },
  thrust: { hardness: 0.65, weight: 0.4 },
  crush: { hardness: 0.3, weight: 0.85 },
  scrape: { roughness: 0.8 },
  shatter: { hardness: 0.8, roughness: 0.7 },
};

const clamp = (x: number): number => Math.min(1, Math.max(0, x));

export const weightOf = (h: Hint): number =>
  h.confidence >= HINT_THRESHOLD ? clamp(h.confidence) : 0;

export type ResolvedMaterial = { material: Material; used: HintUse[] };

export const resolveMaterial = (
  fromGame: SignalMaterial | undefined,
  hints: readonly Hint[]
): ResolvedMaterial => {
  const rule: Material = {
    hardness: fromGame?.hardness ?? DEFAULT_MATERIAL.hardness,
    weight: fromGame?.weight ?? DEFAULT_MATERIAL.weight,
    roughness: fromGame?.roughness ?? DEFAULT_MATERIAL.roughness,
  };
  const out = { ...rule };
  const used: HintUse[] = [];
  for (const h of hints) {
    const w = weightOf(h);
    if (w === 0) continue;
    const targets: Partial<Material> =
      h.field === 'contact' ? CHARACTER[h.value] : { [h.field]: h.value };
    let applied = false;
    for (const key of ['hardness', 'weight', 'roughness'] as const) {
      const target = targets[key];
      // A value the game gave directly is never overridden.
      if (target === undefined || fromGame?.[key] !== undefined) continue;
      out[key] = clamp(out[key] + w * (target - out[key]));
      applied = true;
    }
    if (applied)
      used.push({ field: h.field, weight: w, latencyMs: h.latencyMs });
  }
  return { material: out, used };
};
