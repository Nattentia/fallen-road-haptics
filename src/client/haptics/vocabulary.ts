import {
  ENEMIES,
  FALLEN_KING,
  GATEKEEPER,
  type AttackStyle,
} from '../../shared/balance/enemies';
import { WEAPONS } from '../../shared/balance/weapons';
import type { Signal } from '../../shared/haptics/signals';
import { FallenRoadSignals } from './fallenRoadSignals';
import { SIGNAL_EVENT } from './signalBus';

/**
 * Every description and gauge description Fallen Road can send, found by
 * driving the real adapter over every weapon, zone and attack style. The
 * live model's inputs are tokenized ahead of time from this list, so it
 * must cover everything the game can say (a test checks the fixtures).
 */

const STYLES: readonly AttackStyle[] = ['slash', 'bash', 'thrust'];

const zones = (): string[] => {
  const ids = new Set<string>();
  for (const e of [...Object.values(ENEMIES), GATEKEEPER, FALLEN_KING])
    for (const z of e.hitZones) ids.add(z.id);
  return [...ids];
};

const attackOf = (style: AttackStyle) => {
  const any = Object.values(ENEMIES)[0]!.attacks[0]!;
  return { ...any, style };
};

export const gameVocabulary = (): {
  descriptions: string[];
  gauges: string[];
} => {
  const signals: Signal[] = [];
  const adapter = new FallenRoadSignals({
    time: { now: 0 },
    game: {
      events: {
        emit: (event: string, signal: Signal) => {
          if (event === SIGNAL_EVENT) signals.push(signal);
        },
      },
    },
  });

  for (const weapon of Object.values(WEAPONS)) {
    for (const zone of zones()) {
      adapter.contacts(
        [{ phase: 'enter', zoneId: zone, priority: 1, speed: 1000, t: 0 }],
        weapon
      );
      adapter.strikeBlocked(weapon, zone, 5);
      for (const heavy of [false, true])
        adapter.strikeLanded(weapon, zone, heavy, false, 5);
      adapter.swipeDone();
    }
    adapter.burstStart(weapon, 0);
    adapter.burstHit(weapon, 5, true);
  }
  adapter.strikeMissed();
  adapter.parried();
  adapter.swipeDone();
  for (const boss of [false, true]) adapter.enemyFelled(boss);
  adapter.enemyGuardBroken(0);
  for (const style of STYLES) {
    const attack = attackOf(style);
    adapter.enemyWindUp(attack, 0);
    adapter.playerHit(attack);
    adapter.playerBlocked(attack);
    adapter.playerCountered(attack, false);
    adapter.playerCountered(attack, true);
    adapter.playerEvaded(attack);
    adapter.attackDone();
  }
  adapter.playerShieldBroken();
  adapter.playerDied();
  // Actions dropped before an outcome close with their own descriptions.
  const sword = WEAPONS.sword;
  adapter.contacts(
    [{ phase: 'enter', zoneId: 'torso', priority: 1, speed: 1000, t: 0 }],
    sword
  );
  adapter.swipeDone();
  adapter.enemyWindUp(attackOf('slash'), 0);
  adapter.attackCalledOff();
  adapter.burstStart(sword, 0);
  adapter.burstCutShort();
  adapter.gauges({
    shield: 1,
    health: 1,
    enemyGuard: 1,
    enemyHealth: 1,
    burst: 1,
  });

  const descriptions = new Set<string>();
  const gauges = new Set<string>();
  for (const s of signals) {
    if (s.kind === 'gauge') {
      if (s.description) gauges.add(s.description);
      continue;
    }
    // Events, streams and timed expectations all describe what happens.
    if ('description' in s && s.description) descriptions.add(s.description);
  }
  return { descriptions: [...descriptions].sort(), gauges: [...gauges].sort() };
};
