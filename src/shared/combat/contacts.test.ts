import { describe, expect, it } from 'vitest';
import { EMPTY_CONTACTS, releaseContacts, segmentSpeed, stepContacts } from './contacts';
import type { ActiveHitZone, GesturePoint } from './types';

const head: ActiveHitZone = {
  id: 'head',
  shape: { type: 'circle', x: 100, y: 100, radius: 20 },
  priority: 4,
};
const torso: ActiveHitZone = {
  id: 'torso',
  shape: { type: 'rect', x: 100, y: 200, halfWidth: 40, halfHeight: 60 },
  priority: 1,
};
const zones = [head, torso];
const p = (x: number, y: number, t: number): GesturePoint => ({ x, y, t });

describe('segmentSpeed', () => {
  it('reports px/s over the segment', () => {
    expect(segmentSpeed(p(0, 0, 0), p(30, 40, 50))).toBeCloseTo(1000);
  });

  it('guards against zero duration', () => {
    expect(Number.isFinite(segmentSpeed(p(0, 0, 5), p(10, 0, 5)))).toBe(true);
  });
});

describe('stepContacts', () => {
  it('reports nothing for a segment clear of every zone', () => {
    const { state, events } = stepContacts(EMPTY_CONTACTS, p(0, 0, 0), p(10, 0, 10), zones);
    expect(events).toEqual([]);
    expect(state.touching.size).toBe(0);
  });

  it('walks enter -> inside -> exit through the torso', () => {
    const s1 = stepContacts(EMPTY_CONTACTS, p(0, 200, 0), p(70, 200, 10), zones);
    expect(s1.events.map((e) => [e.phase, e.zoneId])).toEqual([['enter', 'torso']]);

    const s2 = stepContacts(s1.state, p(70, 200, 10), p(120, 200, 20), zones);
    expect(s2.events.map((e) => [e.phase, e.zoneId])).toEqual([['inside', 'torso']]);

    const s3 = stepContacts(s2.state, p(120, 200, 20), p(200, 200, 30), zones);
    expect(s3.events.map((e) => [e.phase, e.zoneId])).toEqual([['inside', 'torso']]);

    const s4 = stepContacts(s3.state, p(200, 200, 30), p(260, 200, 40), zones);
    expect(s4.events.map((e) => [e.phase, e.zoneId])).toEqual([['exit', 'torso']]);
    expect(s4.state.touching.size).toBe(0);
  });

  it('opens and closes a zone crossed within one fast segment', () => {
    const s1 = stepContacts(EMPTY_CONTACTS, p(50, 100, 0), p(150, 100, 10), zones);
    expect(s1.events.map((e) => e.phase)).toEqual(['enter']);
    expect(s1.events[0]!.speed).toBeCloseTo(10000);
    const s2 = stepContacts(s1.state, p(150, 100, 10), p(200, 100, 20), zones);
    expect(s2.events.map((e) => [e.phase, e.zoneId])).toEqual([['exit', 'head']]);
  });

  it('tracks overlapping zones independently', () => {
    const s1 = stepContacts(EMPTY_CONTACTS, p(100, 60, 0), p(100, 160, 10), zones);
    expect(s1.events.map((e) => e.zoneId).sort()).toEqual(['head', 'torso']);
  });

  it('closes a contact whose zone disappeared mid-swipe', () => {
    const s1 = stepContacts(EMPTY_CONTACTS, p(0, 200, 0), p(70, 200, 10), zones);
    const s2 = stepContacts(s1.state, p(70, 200, 10), p(90, 200, 20), []);
    expect(s2.events.map((e) => [e.phase, e.zoneId])).toEqual([['exit', 'torso']]);
  });
});

describe('releaseContacts', () => {
  it('exits every open contact at release time', () => {
    const s1 = stepContacts(EMPTY_CONTACTS, p(100, 60, 0), p(100, 160, 10), zones);
    const events = releaseContacts(s1.state, 42);
    expect(events.map((e) => [e.phase, e.t])).toEqual([
      ['exit', 42],
      ['exit', 42],
    ]);
  });
});
