import type { Game } from 'phaser';
import { CONTACT_EVENT, type ContactSignal } from '../combat/contactEvents';
import { SFX_EVENT, type SfxEvent } from '../audio/sfx';

const MAX_SAMPLES = 2000;

const percentile = (sorted: readonly number[], q: number): number =>
  sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/**
 * `?probe=1` overlay: live contact events and input->signal latency
 * (pointer event timestamp to contact emission), p50/p95/max. Signals are
 * also kept on `window.__probe` for export.
 */
export const installContactProbe = (game: Game): void => {
  const params = new URLSearchParams(location.search);
  if (!params.has('probe')) return;

  const log: (ContactSignal | (SfxEvent & { kind: 'sfx'; emitTs: number }))[] = [];
  (window as unknown as { __probe?: typeof log }).__probe = log;
  const latencies: number[] = [];
  let last = '';

  game.events.on(CONTACT_EVENT, (signal: ContactSignal) => {
    if (log.length < MAX_SAMPLES) log.push(signal);
    if (signal.phase !== 'exit' && signal.inputTs > 0) latencies.push(signal.emitTs - signal.inputTs);
    last = `${signal.phase} ${signal.zoneId} ${Math.round(signal.speed)}px/s`;
  });
  game.events.on(SFX_EVENT, (event: SfxEvent) => {
    if (log.length < MAX_SAMPLES) log.push({ ...event, kind: 'sfx', emitTs: performance.now() });
  });

  const panel = document.createElement('pre');
  panel.style.cssText =
    'position:fixed;left:4px;top:4px;margin:0;padding:6px 8px;z-index:10;pointer-events:none;' +
    'font:12px/1.35 monospace;color:#fff;background:rgba(0,0,0,.6);border-radius:4px';
  document.body.appendChild(panel);
  setInterval(() => {
    const sorted = [...latencies].sort((a, b) => a - b);
    const fmt = (v: number) => (Number.isNaN(v) ? '-' : v.toFixed(1));
    panel.textContent =
      `contacts ${latencies.length}  last: ${last || '-'}\n` +
      `input->signal ms  p50 ${fmt(percentile(sorted, 0.5))}  p95 ${fmt(percentile(sorted, 0.95))}  max ${fmt(sorted[sorted.length - 1] ?? NaN)}`;
  }, 500);
};
