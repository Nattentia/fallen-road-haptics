import type { SoundFeatures } from '../../shared/upscaler/contract';
import { analyzeSound } from '../../shared/upscaler/sound';

/**
 * Analyses the game's loaded sound effects for the upscaler, one sound per
 * task so the frame never stalls. Signals name sounds by effect key; the
 * first variant stands for its key.
 */

/** What Web Audio's AudioBuffer offers, and all this needs. */
export type DecodedSound = {
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
};

export const isDecodedSound = (x: unknown): x is DecodedSound =>
  typeof x === 'object' &&
  x !== null &&
  'getChannelData' in x &&
  'numberOfChannels' in x &&
  'sampleRate' in x;

/** Averages the channels into one. */
export const mixdown = (sound: DecodedSound): Float32Array => {
  const first = sound.getChannelData(0);
  if (sound.numberOfChannels === 1) return first;
  const out = new Float32Array(first.length);
  for (let c = 0; c < sound.numberOfChannels; c++) {
    const data = sound.getChannelData(c);
    for (let i = 0; i < out.length; i++)
      out[i]! += (data[i] ?? 0) / sound.numberOfChannels;
  }
  return out;
};

export const analyzeLoaded = (
  sounds: ReadonlyArray<{ id: string; sound: unknown }>,
  done: (features: Record<string, SoundFeatures>) => void,
  next: (step: () => void) => void = (step) => setTimeout(step, 0)
): void => {
  const out: Record<string, SoundFeatures> = {};
  let i = 0;
  const step = () => {
    const item = sounds[i];
    if (!item) {
      done(out);
      return;
    }
    i += 1;
    if (isDecodedSound(item.sound))
      out[item.id] = analyzeSound(mixdown(item.sound), item.sound.sampleRate);
    next(step);
  };
  next(step);
};
