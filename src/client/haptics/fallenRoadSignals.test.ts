import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../../shared/balance/enemies';
import { WEAPONS } from '../../shared/balance/weapons';
import type { Signal } from '../../shared/haptics/signals';
import { FallenRoadSignals } from './fallenRoadSignals';
import { SIGNAL_EVENT } from './signalBus';

const setup = () => {
  const signals: Signal[] = [];
  const clock = { now: 0 };
  const scene = {
    time: clock,
    game: {
      events: {
        emit: (name: string, signal: Signal) => {
          if (name === SIGNAL_EVENT) signals.push(signal);
        },
      },
    },
  };
  const adapter = new FallenRoadSignals(scene);
  return { adapter, signals, clock };
};

const chainOf = (s: Signal) => ('chain' in s ? s.chain : undefined);
const sword = WEAPONS.sword;
const attack = Object.values(ENEMIES)[0]!.attacks[0]!;

describe('FallenRoadSignals', () => {
  it('ties blade contact, the landed strike and the kill into one swipe chain', () => {
    const { adapter, signals } = setup();
    adapter.contacts(
      [{ phase: 'enter', zoneId: 'head', priority: 4, speed: 1500, t: 10 }],
      sword
    );
    adapter.contacts(
      [{ phase: 'inside', zoneId: 'head', priority: 4, speed: 2400, t: 40 }],
      sword
    );
    adapter.strikeLanded(sword, 'head', true, true, 20);
    adapter.enemyFelled(false);
    adapter.swipeDone();

    const chains = signals.map(chainOf);
    const id = chains[0]?.id;
    expect(id).toMatch(/^swipe-/);
    expect(chains.map((c) => c?.id)).toEqual([id, id, id, id]);
    expect(chains.map((c) => c?.step)).toEqual([
      'start',
      'progress',
      'resolve',
      'end',
    ]);
    expect(signals[1]).toMatchObject({
      kind: 'stream',
      phase: 'update',
      value: 0.8,
    });
    expect(signals[2]).toMatchObject({
      kind: 'event',
      outcome: 'landed',
      valence: 'good',
    });
  });

  it('opens a fresh chain for the next swipe', () => {
    const { adapter, signals } = setup();
    adapter.strikeMissed();
    adapter.swipeDone();
    adapter.strikeMissed();
    const [a, b] = signals.map(chainOf);
    expect(a?.id).not.toBe(b?.id);
  });

  it('keeps burst hits on the burst chain and lets a kill end it', () => {
    const { adapter, signals } = setup();
    adapter.burstStart(sword, 200);
    adapter.burstHit(sword, 7, false);
    adapter.enemyFelled(true);
    const steps = signals.map((s) => chainOf(s)?.step);
    expect(steps).toEqual(['start', 'progress', 'progress', 'end']);
    expect(signals[1]).toMatchObject({
      kind: 'clock',
      clock: 'grid',
      interval: 180,
    });
    expect(signals[3]).toMatchObject({ magnitude: 1, importance: 1 });
  });

  it('links the enemy wind-up to how the player met the attack', () => {
    const { adapter, signals } = setup();
    adapter.enemyWindUp(attack, 600);
    adapter.playerBlocked(attack);
    adapter.attackDone();
    adapter.playerDied();
    const [windUp, block, death] = signals;
    expect(windUp).toMatchObject({ kind: 'clock', clock: 'expect', at: 600 });
    expect(chainOf(block!)).toEqual({
      id: chainOf(windUp!)?.id,
      step: 'resolve',
    });
    expect(chainOf(death!)).toBeUndefined();
  });

  it('cancels a wind-up dropped before impact', () => {
    const { adapter, signals } = setup();
    adapter.enemyWindUp(attack, 600);
    adapter.attackCalledOff();
    adapter.attackDone();
    const steps = signals.map((s) => chainOf(s)?.step);
    expect(steps).toEqual(['start', 'cancel']);
    expect(chainOf(signals[1]!)?.id).toBe(chainOf(signals[0]!)?.id);
    expect(signals[1]).toMatchObject({ magnitude: 0, outcome: 'none' });
  });

  it('does not cancel an attack that already resolved', () => {
    const { adapter, signals } = setup();
    adapter.enemyWindUp(attack, 600);
    adapter.playerCountered(attack, false);
    adapter.attackCalledOff(); // the counter staggers the enemy
    adapter.attackDone();
    expect(signals.map((s) => chainOf(s)?.step)).toEqual(['start', 'resolve']);
  });

  it('cancels the pending wind-up when the enemy is felled', () => {
    const { adapter, signals } = setup();
    adapter.enemyWindUp(attack, 600);
    adapter.strikeLanded(sword, 'head', false, false, 20);
    adapter.enemyFelled(false);
    adapter.swipeDone();
    const attackId = chainOf(signals[0]!)?.id;
    expect(
      signals
        .map(chainOf)
        .filter((c) => c?.id === attackId)
        .map((c) => c?.step)
    ).toEqual(['start', 'cancel']);
  });

  it('cancels a swipe that touched the enemy but was never resolved', () => {
    const { adapter, signals } = setup();
    adapter.contacts(
      [{ phase: 'enter', zoneId: 'head', priority: 4, speed: 1500, t: 10 }],
      sword
    );
    adapter.swipeDone();
    adapter.swipeDone();
    expect(signals.map((s) => chainOf(s)?.step)).toEqual(['start', 'cancel']);
  });

  it('cancels a burst cut short, but not one that finished', () => {
    const { adapter, signals } = setup();
    adapter.burstStart(sword, 200);
    adapter.burstHit(sword, 7, false);
    adapter.burstCutShort();
    adapter.burstCutShort();
    adapter.burstStart(sword, 200);
    adapter.burstHit(sword, 7, true);
    adapter.burstCutShort();
    expect(signals.map((s) => chainOf(s)?.step)).toEqual([
      'start',
      'progress',
      'progress',
      'cancel',
      'start',
      'progress',
      'end',
    ]);
  });

  it('reports gauges only when they change', () => {
    const { adapter, signals } = setup();
    const frame = {
      shield: 1,
      health: 1,
      enemyGuard: 0.5,
      enemyHealth: 1,
      burst: 0,
    };
    adapter.gauges(frame);
    adapter.gauges(frame);
    adapter.gauges({ ...frame, shield: 0.5 });
    expect(
      signals
        .filter((s) => s.kind === 'gauge')
        .map((s) => s.kind === 'gauge' && s.id)
    ).toEqual([
      'shield',
      'health',
      'enemy_guard',
      'enemy_health',
      'burst',
      'shield',
    ]);
  });
});
