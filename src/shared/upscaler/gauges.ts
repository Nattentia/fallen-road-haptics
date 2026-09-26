import {
  GaugeTracker,
  type GaugeCrossing,
  type GaugeSignal,
} from '../haptics/signals';

/**
 * Gauges never vibrate by themselves. They colour related moments
 * (instability when the player's resource runs low, brightness when the
 * opponent's does) and turn threshold crossings into small moments.
 *
 * Rule (a): a gauge reaching 0 becomes a collapse only when the game has not
 * reported an event naming that gauge within COLLAPSE_WINDOW_MS, in either
 * order: the game's own event wins. A reported break never doubles, a gauge
 * the player spends on purpose (reported as the action that spends it) never
 * collapses, and games that only report gauges still feel the collapse.
 */

export const COLLAPSE_WINDOW_MS = 100;
/** Below this favourable share a player's own gauge feels unstable. */
const LOW = 0.35;
/** Above this favourable share an opponent's gauge gives an advantage. */
const HIGH = 0.65;

export type GaugeMoment = {
  gauge: string;
  kind: 'warning' | 'collapse' | 'full';
  /** Whether the moment is good for the player. */
  good: boolean;
  at: number;
};

/** How favourable a gauge's value is for the player, 0..1. */
const favourable = (g: GaugeSignal, value: number): number =>
  g.goodWhen === 'high' ? value : 1 - value;

/** Whether the player owns the thing this gauge measures. */
const mine = (g: GaugeSignal): boolean => g.owner === 'self';

export class Gauges {
  private readonly tracker = new GaugeTracker();
  private readonly meta = new Map<string, GaugeSignal>();
  private readonly explained = new Map<string, number>();
  private readonly pending = new Map<string, number>();

  /** A gauge report; returns the moments it causes right away. */
  report(signal: GaugeSignal, now: number): GaugeMoment[] {
    this.meta.set(signal.id, signal);
    const out: GaugeMoment[] = [];
    for (const c of this.tracker.update(signal)) {
      const moment = this.crossing(c, signal, now);
      if (moment) out.push(moment);
    }
    return out;
  }

  private crossing(
    c: GaugeCrossing,
    g: GaugeSignal,
    now: number
  ): GaugeMoment | null {
    if (c.kind === 'below' && mine(g) && g.goodWhen === 'high')
      return { gauge: g.id, kind: 'warning', good: false, at: now };
    if (c.kind === 'full' && mine(g) && g.goodWhen === 'high')
      return { gauge: g.id, kind: 'full', good: true, at: now };
    if (c.kind !== 'empty') return null;
    const told = this.explained.get(g.id);
    if (told !== undefined && now - told <= COLLAPSE_WINDOW_MS) return null;
    this.pending.set(g.id, now + COLLAPSE_WINDOW_MS);
    return null;
  }

  /** The game reported an event naming these gauges. */
  explain(gauges: readonly string[], now: number): void {
    for (const id of gauges) {
      this.explained.set(id, now);
      this.pending.delete(id);
    }
  }

  /** Collapses whose window has passed without a reported break. */
  due(now: number): GaugeMoment[] {
    const out: GaugeMoment[] = [];
    for (const [id, deadline] of this.pending) {
      if (deadline > now) continue;
      this.pending.delete(id);
      const g = this.meta.get(id);
      const value = this.tracker.value(id);
      if (g && value !== undefined)
        out.push({
          gauge: id,
          kind: 'collapse',
          good: favourable(g, value) > 0.5,
          at: now,
        });
    }
    return out;
  }

  /** Earliest pending collapse deadline. */
  nextDeadline(): number | undefined {
    const times = [...this.pending.values()];
    return times.length > 0 ? Math.min(...times) : undefined;
  }

  /** Decoration from the gauges a moment names. */
  decoration(ids: readonly string[] = []): {
    instability: number;
    advantage: number;
  } {
    let instability = 0;
    let advantage = 0;
    for (const id of ids) {
      const g = this.meta.get(id);
      const value = this.tracker.value(id);
      if (!g || value === undefined) continue;
      const f = favourable(g, value);
      if (mine(g) && f < LOW)
        instability = Math.max(instability, (LOW - f) / LOW);
      if (!mine(g) && f > HIGH)
        advantage = Math.max(advantage, (f - HIGH) / (1 - HIGH));
    }
    return { instability, advantage };
  }
}
