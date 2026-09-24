import type { Game } from 'phaser';
import { CONTACT_EVENT, type ContactSignal } from '../combat/contactEvents';
import { SFX_EVENT, type SfxEvent } from '../audio/sfx';

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

export const installNativeBridge = (game: Game): boolean => {
  const w = window as NativeWindow;
  const native = w.webkit?.messageHandlers?.hs;
  if (!native) return false;

  let seq = 0;
  const post = (message: Record<string, unknown>) => {
    seq += 1;
    native.postMessage({ seq, ...message });
  };

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
  return true;
};
