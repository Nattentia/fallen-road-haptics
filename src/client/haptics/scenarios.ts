import { ROAD_SOLDIER } from '../../shared/balance/enemies';
import { WEAPONS } from '../../shared/balance/weapons';
import type { ContactEvent } from '../../shared/combat/contacts';
import type { Signal } from '../../shared/haptics/signals';
import type { BaseHapticAction } from './baseHaptics';
import { FallenRoadSignals, type GaugeFrame } from './fallenRoadSignals';
import { SIGNAL_EVENT } from './signalBus';

/**
 * Scripted combat moments, replayed through the real Fallen Road adapter in
 * the same order BattleScene calls it (base vibration first, then signals).
 * They become the upscaler's signal fixtures, so its tests exercise the
 * exact signal shapes this game produces.
 */

export type ScenarioRecord =
  | { kind: 'base'; name: BaseHapticAction; t: number }
  | { kind: 'signal'; signal: Signal };

export type Scenario = { name: string; records: ScenarioRecord[] };

type Script = {
  at: (t: number) => void;
  base: (name: BaseHapticAction) => void;
  signals: FallenRoadSignals;
  contact: (
    phase: ContactEvent['phase'],
    zoneId: string,
    speed: number
  ) => void;
  gauges: (frame: Partial<GaugeFrame>) => void;
};

const sword = WEAPONS.sword;
const hammer = WEAPONS.hammer;
const slash = ROAD_SOLDIER.attacks[0]!;

const FULL: GaugeFrame = {
  shield: 1,
  health: 1,
  enemyGuard: 1,
  enemyHealth: 1,
  burst: 0,
};

const record = (name: string, play: (s: Script) => void): Scenario => {
  const records: ScenarioRecord[] = [];
  const clock = { now: 0 };
  const signals = new FallenRoadSignals({
    time: clock,
    game: {
      events: {
        emit: (event: string, signal: Signal) => {
          if (event === SIGNAL_EVENT)
            records.push({ kind: 'signal', signal: structuredClone(signal) });
        },
      },
    },
  });
  let frame = FULL;
  const script: Script = {
    at: (t) => {
      clock.now = t;
    },
    base: (baseName) =>
      records.push({ kind: 'base', name: baseName, t: clock.now }),
    signals,
    contact: (phase, zoneId, speed) =>
      signals.contacts(
        [{ phase, zoneId, priority: 1, speed, t: clock.now }],
        sword
      ),
    gauges: (change) => {
      frame = { ...frame, ...change };
      signals.gauges(frame);
    },
  };
  script.gauges({});
  play(script);
  return { name, records };
};

/** A blade pass over one zone at rising then falling speed. */
const pass = (s: Script, zone: string, from: number) => {
  s.at(from);
  s.contact('enter', zone, 900);
  s.at(from + 16);
  s.contact('inside', zone, 2100);
  s.at(from + 33);
  s.contact('inside', zone, 2700);
  s.at(from + 50);
  s.contact('exit', zone, 1800);
};

export const SCENARIOS: readonly Scenario[] = [
  record('swipe-landed', (s) => {
    pass(s, 'torso', 1000);
    s.at(1080);
    s.base('enemy_hit');
    s.signals.strikeLanded(sword, 'torso', false, false, 12);
    s.signals.swipeDone();
    s.gauges({ enemyHealth: 0.8, enemyGuard: 0.9 });
  }),
  record('swipe-heavy-weak-point', (s) => {
    pass(s, 'head', 1000);
    s.at(1090);
    s.base('enemy_hit');
    s.signals.strikeLanded(hammer, 'head', true, true, 40);
    s.signals.swipeDone();
    s.gauges({ enemyHealth: 0.4 });
  }),
  record('swipe-kill', (s) => {
    s.gauges({ enemyHealth: 0.1 });
    pass(s, 'head', 1000);
    s.at(1080);
    s.base('enemy_hit');
    s.signals.strikeLanded(sword, 'head', false, true, 18);
    s.base('enemy_kill');
    s.signals.enemyFelled(false);
    s.signals.swipeDone();
    s.gauges({ enemyHealth: 0 });
  }),
  record('swipe-boss-kill', (s) => {
    s.gauges({ enemyHealth: 0.05 });
    pass(s, 'torso', 1000);
    s.at(1080);
    s.base('enemy_hit');
    s.signals.strikeLanded(sword, 'torso', true, false, 20);
    s.base('boss_kill');
    s.signals.enemyFelled(true);
    s.signals.swipeDone();
    s.gauges({ enemyHealth: 0 });
  }),
  record('swipe-blocked', (s) => {
    pass(s, 'torso', 1000);
    s.at(1080);
    s.base('enemy_block');
    s.signals.strikeBlocked(sword, 'torso', 12);
    s.signals.swipeDone();
    s.gauges({ enemyGuard: 0.6, enemyHealth: 0.97 });
  }),
  record('swipe-missed', (s) => {
    s.at(1000);
    s.signals.strikeMissed();
    s.signals.swipeDone();
  }),
  record('swipe-parried', (s) => {
    pass(s, 'torso', 1000);
    s.at(1080);
    s.base('parried');
    s.signals.parried();
    s.signals.enemyWindUp(slash, 1480);
    s.signals.swipeDone();
    s.at(1480);
    s.signals.playerHit(slash);
    s.base('player_hit');
    s.signals.attackDone();
    s.gauges({ health: 0.8 });
  }),
  record('swipe-held-back', (s) => {
    s.at(1000);
    s.contact('enter', 'torso', 1200);
    s.at(1016);
    s.contact('exit', 'torso', 1100);
    s.signals.swipeDone();
  }),
  record('burst-full', (s) => {
    s.gauges({ burst: 1 });
    s.at(1000);
    s.base('burst_start');
    s.signals.burstStart(sword, 1200);
    s.gauges({ burst: 0 });
    for (let i = 0; i < sword.burst.hits; i++) {
      s.at(1200 + i * sword.burst.hitIntervalMs);
      s.base('enemy_hit');
      s.signals.burstHit(sword, 8, i === sword.burst.hits - 1);
    }
  }),
  record('burst-kill', (s) => {
    s.gauges({ burst: 1, enemyHealth: 0.1 });
    s.at(1000);
    s.base('burst_start');
    s.signals.burstStart(sword, 1200);
    s.at(1200);
    s.base('enemy_hit');
    s.signals.burstHit(sword, 8, false);
    s.at(1380);
    s.base('enemy_hit');
    s.signals.burstHit(sword, 8, false);
    s.base('enemy_kill');
    s.signals.enemyFelled(false);
    s.gauges({ enemyHealth: 0 });
  }),
  record('burst-cut-short', (s) => {
    s.at(1000);
    s.base('burst_start');
    s.signals.burstStart(sword, 1200);
    s.at(1200);
    s.base('enemy_hit');
    s.signals.burstHit(sword, 8, false);
    s.at(1380);
    s.signals.burstCutShort();
  }),
  record('attack-hit', (s) => {
    s.at(1000);
    s.signals.enemyWindUp(slash, 1500);
    s.at(1500);
    s.signals.playerHit(slash);
    s.base('player_hit');
    s.signals.attackDone();
    s.gauges({ health: 0.8 });
  }),
  record('attack-blocked', (s) => {
    s.at(1000);
    s.signals.enemyWindUp(slash, 1500);
    s.at(1500);
    s.signals.playerBlocked(slash);
    s.base('player_block');
    s.signals.attackDone();
    s.gauges({ shield: 0.6, health: 0.97 });
  }),
  record('attack-shield-breaks', (s) => {
    s.gauges({ shield: 0.2 });
    s.at(1000);
    s.signals.enemyWindUp(slash, 1500);
    s.at(1500);
    s.signals.playerBlocked(slash);
    s.base('player_block');
    s.base('player_guard_break');
    s.signals.playerShieldBroken();
    s.signals.attackDone();
    s.gauges({ shield: 0 });
  }),
  record('attack-countered', (s) => {
    s.at(1000);
    s.signals.enemyWindUp(slash, 1500);
    s.at(1500);
    s.signals.playerCountered(slash, false);
    s.base('counter');
    s.signals.attackCalledOff();
    s.signals.attackDone();
    s.gauges({ enemyGuard: 0.5 });
  }),
  record('attack-dodge-countered', (s) => {
    s.at(1000);
    s.signals.enemyWindUp(slash, 1500);
    s.at(1500);
    s.signals.playerCountered(slash, true);
    s.base('counter');
    s.signals.attackCalledOff();
    s.signals.attackDone();
  }),
  record('attack-evaded', (s) => {
    s.at(1000);
    s.signals.enemyWindUp(slash, 1500);
    s.at(1500);
    s.signals.playerEvaded(slash);
    s.signals.attackDone();
  }),
  record('attack-interrupted', (s) => {
    s.at(1000);
    s.signals.enemyWindUp(slash, 1500);
    pass(s, 'weaponHand', 1100);
    s.at(1180);
    s.base('enemy_hit');
    s.signals.strikeLanded(sword, 'weaponHand', false, false, 11);
    s.signals.attackCalledOff();
    s.signals.swipeDone();
  }),
  record('enemy-guard-break', (s) => {
    s.gauges({ enemyGuard: 0.1 });
    pass(s, 'torso', 1000);
    s.at(1080);
    s.base('enemy_block');
    s.signals.strikeBlocked(sword, 'torso', 12);
    s.base('enemy_guard_break');
    s.signals.enemyGuardBroken(1080 + 2500);
    s.signals.swipeDone();
    s.gauges({ enemyGuard: 0 });
  }),
  record('player-death', (s) => {
    s.gauges({ health: 0.1 });
    s.at(1000);
    s.signals.enemyWindUp(slash, 1500);
    s.at(1500);
    s.signals.playerHit(slash);
    s.base('player_hit');
    s.base('player_death');
    s.signals.playerDied();
    s.signals.attackDone();
    s.gauges({ health: 0 });
  }),
];
