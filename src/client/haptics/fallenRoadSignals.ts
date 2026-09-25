import { ENEMIES, FALLEN_KING, GATEKEEPER } from '../../shared/balance/enemies';
import type { EnemyAttackDefinition } from '../../shared/balance/enemies';
import {
  WEAPONS,
  type WeaponDefinition,
  type WeaponId,
} from '../../shared/balance/weapons';
import type { ContactEvent } from '../../shared/combat/contacts';
import { computeStrike } from '../../shared/combat/damage';
import {
  clamp01,
  magnitudeOf,
  type EventSignal,
} from '../../shared/haptics/signals';
import { SignalBus, chainRef, type SignalSink } from './signalBus';

/**
 * Fallen Road's side of the haptic upscaler integration: it turns this game's
 * combat into genre-agnostic signals. Game vocabulary lives only here and in
 * the description phrases; the upscaler reads the signal fields.
 */

const VERB: Record<WeaponId, string> = {
  sword: 'slashes',
  spear: 'thrusts at',
  hammer: 'smashes',
  dagger: 'stabs',
  mace: 'bashes',
};

/** Largest single strike the player can deal: a heavy blow to the head. */
const STRIKE_REFERENCE = Math.max(
  ...Object.values(WEAPONS).map((w) => computeStrike(w, 'head', true).damage)
);
/** Largest single enemy attack. */
const ATTACK_REFERENCE = Math.max(
  ...[...Object.values(ENEMIES), GATEKEEPER, FALLEN_KING].flatMap((e) =>
    e.attacks.map((a) => a.damage)
  )
);
const BLADE_SPEED_REFERENCE = 3000; // px/s

export type GaugeFrame = {
  shield: number;
  health: number;
  enemyGuard: number;
  enemyHealth: number;
  burst: number;
};

/** What the adapter needs from the scene: its clock and the game emitter. */
export type SignalHost = { time: { now: number }; game: SignalSink };

export class FallenRoadSignals {
  private readonly bus: SignalBus;
  private swipeChain: string | null = null;
  private burstChain: string | null = null;
  private attackChain: string | null = null;

  constructor(private readonly scene: SignalHost) {
    this.bus = new SignalBus(scene.game);
  }

  private get now(): number {
    return this.scene.time.now;
  }

  private event(fields: Omit<EventSignal, 'kind' | 't'>): void {
    this.bus.emit({ kind: 'event', t: this.now, ...fields });
  }

  // ------------------------------------------------------------------
  // Player swipe: blade contact → outcome → maybe the kill
  // ------------------------------------------------------------------

  contacts(events: readonly ContactEvent[], weapon: WeaponDefinition): void {
    for (const e of events) {
      const first = e.phase === 'enter' && this.swipeChain === null;
      if (first) this.swipeChain = this.bus.openChain('swipe');
      this.bus.emit({
        kind: 'stream',
        t: e.t,
        id: `blade-${e.zoneId}`,
        phase:
          e.phase === 'enter'
            ? 'start'
            : e.phase === 'inside'
              ? 'update'
              : 'end',
        value: clamp01(e.speed / BLADE_SPEED_REFERENCE),
        description: `player ${weapon.name.toLowerCase()} crosses enemy ${e.zoneId}`,
        actor: 'self',
        target: 'other',
        valence: 'neutral',
        importance: 0.2,
        ...chainRef(this.swipeChain, first ? 'start' : 'progress'),
      });
    }
  }

  /** The chain the current swipe resolves on; opens one if nothing touched. */
  private swipe(): string {
    this.swipeChain ??= this.bus.openChain('swipe');
    return this.swipeChain;
  }

  /** Called once the release has been fully handled. */
  swipeDone(): void {
    this.swipeChain = null;
  }

  strikeLanded(
    weapon: WeaponDefinition,
    zone: string,
    heavy: boolean,
    weakPoint: boolean,
    damage: number
  ): void {
    this.event({
      magnitude: magnitudeOf(damage, STRIKE_REFERENCE),
      valence: 'good',
      importance: weakPoint ? 0.7 : 0.5,
      actor: 'self',
      target: 'other',
      outcome: 'landed',
      description: `player ${heavy ? 'heavily ' : ''}${VERB[weapon.archetype]} enemy ${zone} with ${weapon.name.toLowerCase()}`,
      gauges: ['enemy_guard', 'enemy_health'],
      sound: `hit_${weapon.id}`,
      base: 'enemy_hit',
      ...chainRef(this.swipe(), 'resolve'),
    });
  }

  strikeBlocked(weapon: WeaponDefinition, zone: string, damage: number): void {
    this.event({
      magnitude: magnitudeOf(damage, STRIKE_REFERENCE),
      valence: 'bad',
      importance: 0.5,
      actor: 'other',
      target: 'self',
      outcome: 'blocked',
      description: `enemy guard blocks player ${weapon.name.toLowerCase()} at ${zone}`,
      gauges: ['enemy_guard'],
      sound: 'enemy_block',
      base: 'enemy_block',
      ...chainRef(this.swipe(), 'resolve'),
    });
  }

  strikeMissed(): void {
    this.event({
      magnitude: 0,
      valence: 'neutral',
      importance: 0.1,
      actor: 'self',
      target: 'other',
      outcome: 'missed',
      description: 'player blade misses enemy',
      ...chainRef(this.swipe(), 'resolve'),
    });
  }

  /** The enemy's counter stance catches the strike (the swipe, if any). */
  parried(): void {
    this.event({
      magnitude: 0.6,
      valence: 'bad',
      importance: 0.7,
      actor: 'other',
      target: 'self',
      outcome: 'deflected',
      description: 'enemy counter stance parries player blade',
      sound: 'parried',
      base: 'parried',
      ...chainRef(this.swipeChain, 'resolve'),
    });
  }

  // ------------------------------------------------------------------
  // Burst: start → timed hits → last hit
  // ------------------------------------------------------------------

  burstStart(weapon: WeaponDefinition, firstHitAt: number): void {
    this.burstChain = this.bus.openChain('burst');
    const burst = weapon.burst;
    this.event({
      magnitude: 0.7,
      valence: 'good',
      importance: 0.8,
      actor: 'self',
      target: 'other',
      outcome: 'none',
      description: `player unleashes ${burst.name.toLowerCase()}`,
      base: 'burst_start',
      ...chainRef(this.burstChain, 'start'),
    });
    this.bus.emit({
      kind: 'clock',
      clock: 'grid',
      t: this.now,
      interval: burst.hitIntervalMs,
      until: firstHitAt + (burst.hits - 1) * burst.hitIntervalMs,
      ...chainRef(this.burstChain, 'progress'),
    });
  }

  burstHit(weapon: WeaponDefinition, damage: number, last: boolean): void {
    this.event({
      magnitude: magnitudeOf(damage, STRIKE_REFERENCE),
      valence: 'good',
      importance: last ? 0.7 : 0.4,
      actor: 'self',
      target: 'other',
      outcome: 'landed',
      description: `player ${weapon.burst.name.toLowerCase()} hits enemy with ${weapon.name.toLowerCase()}`,
      gauges: ['enemy_health'],
      sound: `hit_${weapon.id}`,
      base: 'enemy_hit',
      ...chainRef(this.burstChain, last ? 'end' : 'progress'),
    });
    if (last) this.burstChain = null;
  }

  // ------------------------------------------------------------------
  // Kill: ends whichever player action delivered it
  // ------------------------------------------------------------------

  enemyFelled(boss: boolean): void {
    const chain = this.burstChain ?? this.swipeChain;
    this.event({
      magnitude: boss ? 1 : 0.6,
      valence: 'good',
      importance: boss ? 1 : 0.8,
      actor: 'self',
      target: 'other',
      outcome: 'broke',
      description: boss ? 'player fells the boss' : 'player fells the enemy',
      sound: 'felled',
      base: boss ? 'boss_kill' : 'enemy_kill',
      ...chainRef(chain, 'end'),
    });
    if (chain === this.burstChain) this.burstChain = null;
  }

  enemyGuardBroken(openUntil: number): void {
    this.event({
      magnitude: 0.7,
      valence: 'good',
      importance: 0.8,
      actor: 'self',
      target: 'other',
      outcome: 'broke',
      description: 'enemy guard breaks',
      gauges: ['enemy_guard'],
      sound: 'guard_break',
      base: 'enemy_guard_break',
    });
    this.bus.emit({
      kind: 'clock',
      clock: 'window',
      t: this.now,
      until: openUntil,
      description: 'enemy is open to attack',
    });
  }

  // ------------------------------------------------------------------
  // Enemy attack: wind-up (expected impact) → how the player met it
  // ------------------------------------------------------------------

  enemyWindUp(attack: EnemyAttackDefinition, impactAt: number): void {
    this.attackChain = this.bus.openChain('attack');
    this.bus.emit({
      kind: 'clock',
      clock: 'expect',
      t: this.now,
      at: impactAt,
      description: `enemy winds up a ${attack.style} attack`,
      importance: clamp01(
        0.4 + 0.6 * magnitudeOf(attack.damage, ATTACK_REFERENCE)
      ),
      ...chainRef(this.attackChain, 'start'),
    });
  }

  private attackEvent(
    attack: EnemyAttackDefinition,
    fields: Pick<
      EventSignal,
      'valence' | 'importance' | 'outcome' | 'description'
    > &
      Partial<Pick<EventSignal, 'magnitude' | 'gauges' | 'sound' | 'base'>>
  ): void {
    this.event({
      magnitude: magnitudeOf(attack.damage, ATTACK_REFERENCE),
      actor: 'other',
      target: 'self',
      ...fields,
      ...chainRef(this.attackChain, 'resolve'),
    });
  }

  playerHit(attack: EnemyAttackDefinition): void {
    this.attackEvent(attack, {
      valence: 'bad',
      importance: 0.8,
      outcome: 'landed',
      description: `enemy ${attack.style} attack hits player`,
      gauges: ['health'],
      sound: 'player_hit',
      base: 'player_hit',
    });
  }

  playerBlocked(attack: EnemyAttackDefinition): void {
    this.attackEvent(attack, {
      valence: 'good',
      importance: 0.6,
      outcome: 'blocked',
      description: `player shield blocks enemy ${attack.style} attack`,
      gauges: ['shield'],
      sound: 'player_block',
      base: 'player_block',
    });
  }

  playerCountered(attack: EnemyAttackDefinition, byDodge: boolean): void {
    this.attackEvent(attack, {
      valence: 'good',
      importance: 0.9,
      outcome: byDodge ? 'missed' : 'deflected',
      description: byDodge
        ? `player dodges enemy ${attack.style} attack at the last instant`
        : `player shield perfectly counters enemy ${attack.style} attack`,
      sound: 'counter',
      base: 'counter',
    });
  }

  playerEvaded(attack: EnemyAttackDefinition): void {
    this.attackEvent(attack, {
      valence: 'good',
      importance: 0.4,
      outcome: 'missed',
      description: `player dodges enemy ${attack.style} attack`,
    });
  }

  /** Called once the attack's impact has been fully handled. */
  attackDone(): void {
    this.attackChain = null;
  }

  playerShieldBroken(): void {
    this.event({
      magnitude: 0.8,
      valence: 'bad',
      importance: 0.9,
      actor: 'other',
      target: 'self',
      outcome: 'broke',
      description: 'player shield breaks',
      gauges: ['shield'],
      sound: 'guard_break',
      base: 'player_guard_break',
      ...chainRef(this.attackChain, 'end'),
    });
  }

  playerDied(): void {
    this.event({
      magnitude: 1,
      valence: 'bad',
      importance: 1,
      actor: 'other',
      target: 'self',
      outcome: 'broke',
      description: 'player falls',
      base: 'player_death',
      ...chainRef(this.attackChain, 'end'),
    });
  }

  // ------------------------------------------------------------------
  // Time and gauges
  // ------------------------------------------------------------------

  hitStop(until: number, scale: number): void {
    this.bus.emit({
      kind: 'clock',
      clock: 'timescale',
      t: this.now,
      value: scale,
      until,
    });
  }

  gauges(frame: GaugeFrame): void {
    const t = this.now;
    this.bus.emit({
      kind: 'gauge',
      t,
      id: 'shield',
      value: clamp01(frame.shield),
      goodWhen: 'high',
      owner: 'self',
      thresholds: [0.34],
      description: 'player shield durability',
    });
    this.bus.emit({
      kind: 'gauge',
      t,
      id: 'health',
      value: clamp01(frame.health),
      goodWhen: 'high',
      owner: 'self',
      thresholds: [0.3],
      description: 'player health',
    });
    this.bus.emit({
      kind: 'gauge',
      t,
      id: 'enemy_guard',
      value: clamp01(frame.enemyGuard),
      goodWhen: 'low',
      owner: 'other',
      thresholds: [0.25],
      description: 'enemy guard',
    });
    this.bus.emit({
      kind: 'gauge',
      t,
      id: 'enemy_health',
      value: clamp01(frame.enemyHealth),
      goodWhen: 'low',
      owner: 'other',
      thresholds: [0.25],
      description: 'enemy health',
    });
    this.bus.emit({
      kind: 'gauge',
      t,
      id: 'burst',
      value: clamp01(frame.burst),
      goodWhen: 'high',
      owner: 'self',
      description: 'player burst charge',
    });
  }
}
