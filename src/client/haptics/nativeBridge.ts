import type { Game } from 'phaser';
import { CONTACT_EVENT, type ContactSignal } from '../combat/contactEvents';
import { SFX_EVENT, type SfxEvent } from '../audio/sfx';
import { BASE_HAPTIC_EVENT, type BaseHapticEvent } from './baseHaptics';
import { SIGNAL_EVENT } from './signalBus';
import type { Signal } from '../../shared/haptics/signals';
import type { Command } from '../../shared/upscaler/contract';

/**
 * Bridge to the iOS wrapper app (ios/). Inside the app, game signals are
 * posted to the Swift haptic player; in a plain browser this is a no-op.
 *
 * Clocks: JS timestamps use performance.now(). The app answers periodic
 * pings so both sides can convert Swift times into the JS clock.
 */
type NativeHandler = { postMessage: (message: unknown) => void };
type NativeWindow = Window & {
  webkit?: { messageHandlers?: { hs?: NativeHandler } };
  __hsPong?: (sentAt: number, swiftMs: number) => void;
};

const SYNC_INTERVAL_MS = 2000;

let seq = 0;

/** Posts to the app, or returns false in a plain browser. */
export const postNative = (message: Record<string, unknown>): boolean => {
  const native = (window as NativeWindow).webkit?.messageHandlers?.hs;
  if (!native) return false;
  seq += 1;
  native.postMessage({ seq, ...message });
  return true;
};

/** Sends one batch of upscaler commands to the native player. */
export const sendCommands = (commands: Command[]): void => {
  postNative({ type: 'upscaler', commands, t1: performance.now() });
};

/** Starts the clock sync the native side needs to place commands in time. */
const startClockSync = (post: (message: Record<string, unknown>) => void) => {
  const w = window as NativeWindow;
  // Clock sync: keep the estimate from the lowest round trip seen recently.
  let best: { rtt: number; offset: number; at: number } | null = null;
  w.__hsPong = (sentAt, swiftMs) => {
    const now = performance.now();
    const rtt = now - sentAt;
    const offset = swiftMs - (sentAt + rtt / 2);
    if (!best || rtt <= best.rtt || now - best.at > 10_000) {
      best = { rtt, offset, at: now };
      post({ type: 'sync', offset, rtt });
    }
  };
  const ping = () => post({ type: 'ping', t: performance.now() });
  ping();
  setInterval(ping, SYNC_INTERVAL_MS);
};

let syncing = false;

/** Clock sync on its own, for pages without the game (the Lab). */
export const installClockSync = (): boolean => {
  if (syncing) return true;
  const ok = postNative({ type: 'hello' });
  if (ok) {
    syncing = true;
    startClockSync(postNative);
  }
  return ok;
};

export const installNativeBridge = (game: Game): boolean => {
  if (!installClockSync()) return false;
  const post = postNative;

  game.events.on(CONTACT_EVENT, (s: ContactSignal) => {
    post({
      type: 'contact',
      phase: s.phase,
      zone: s.zoneId,
      speed: Math.round(s.speed),
      t0: s.inputTs,
      t1: s.emitTs,
    });
  });
  game.events.on(SFX_EVENT, (e: SfxEvent) => {
    post({ type: 'sfx', key: e.key, volume: e.volume, t1: performance.now() });
  });
  game.events.on(BASE_HAPTIC_EVENT, (e: BaseHapticEvent) => {
    post({ type: 'base', action: e.action, t1: performance.now() });
  });
  game.events.on(SIGNAL_EVENT, (signal: Signal) => {
    post({ type: 'signal', signal, t1: performance.now() });
  });
  return true;
};
