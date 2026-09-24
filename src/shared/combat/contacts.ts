import { segmentIntersectsZone } from './hitDetection';
import type { ActiveHitZone, GesturePoint } from './types';

/**
 * Blade-contact tracking while a swipe is still in flight. Purely sensory:
 * it reports which zones the blade is touching segment by segment, and never
 * decides damage — the strike itself still resolves on release.
 */
export type ContactPhase = 'enter' | 'inside' | 'exit';

export type ContactEvent = {
  phase: ContactPhase;
  zoneId: string;
  priority: number;
  /** Blade speed over the segment that produced this event, px/s. */
  speed: number;
  /** Game time of the segment end. */
  t: number;
};

export type ContactState = {
  /** Zone ids the previous segment touched. */
  touching: ReadonlySet<string>;
};

export const EMPTY_CONTACTS: ContactState = { touching: new Set() };

export const segmentSpeed = (a: GesturePoint, b: GesturePoint): number => {
  const dt = Math.max(1, b.t - a.t);
  return (Math.hypot(b.x - a.x, b.y - a.y) / dt) * 1000;
};

/**
 * Advance contact state by one path segment. A zone the segment touches is
 * `enter` if the previous segment did not touch it, else `inside`; a zone
 * the previous segment touched but this one does not is `exit`. A zone
 * crossed within a single segment reports `enter` now and `exit` next step.
 */
export const stepContacts = (
  state: ContactState,
  a: GesturePoint,
  b: GesturePoint,
  zones: readonly ActiveHitZone[]
): { state: ContactState; events: ContactEvent[] } => {
  const speed = segmentSpeed(a, b);
  const touching = new Set<string>();
  const events: ContactEvent[] = [];
  for (const zone of zones) {
    if (!segmentIntersectsZone(a, b, zone)) continue;
    touching.add(zone.id);
    events.push({
      phase: state.touching.has(zone.id) ? 'inside' : 'enter',
      zoneId: zone.id,
      priority: zone.priority,
      speed,
      t: b.t,
    });
  }
  for (const id of state.touching) {
    if (touching.has(id)) continue;
    const priority = zones.find((z) => z.id === id)?.priority ?? 0;
    // A zone that vanished (enemy died mid-swipe) still closes its contact.
    events.push({ phase: 'exit', zoneId: id, priority, speed, t: b.t });
  }
  return { state: { touching }, events };
};

/** Close every open contact, e.g. when the pointer lifts. */
export const releaseContacts = (
  state: ContactState,
  t: number
): ContactEvent[] =>
  [...state.touching].map((zoneId) => ({
    phase: 'exit' as const,
    zoneId,
    priority: 0,
    speed: 0,
    t,
  }));
