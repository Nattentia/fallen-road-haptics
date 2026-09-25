import * as Phaser from 'phaser';
import {
  DailyRunCompletionResponseSchema,
  DailyRunSubmissionSchema,
  FallenRivalAvengeResponseSchema,
  FallenRivalAvengeSubmissionSchema,
  type FallenRival,
  type DailyRunStartResponse,
  type DailyScoreStats,
} from '../../shared/api';
import { PLAYER_BALANCE } from '../../shared/balance/player';
import { playSfx } from '../audio/sfx';
import { playBaseHaptic } from '../haptics/baseHaptics';
import type { WeaponId } from '../../shared/balance/weapons';
import {
  ENEMIES,
  FALLEN_KING,
  GATEKEEPER,
  GAUNTLET_ORDER,
  ROAD_FIGHTS_BEFORE_BOSS,
  ROAD_SOLDIER,
  randomizedRoadRoute,
  type EnemyAttackDefinition,
  type EnemyDefinition,
} from '../../shared/balance/enemies';
import { zoneBalance } from '../../shared/balance/hitZones';
import { resolveHit } from '../../shared/combat/hitDetection';
import {
  EMPTY_CONTACTS,
  releaseContacts,
  stepContacts,
  type ContactEvent,
  type ContactState,
} from '../../shared/combat/contacts';
import { CONTACT_EVENT, type ContactSignal } from '../combat/contactEvents';
import { computeStrike, blockedDamage, guardBrokenDamage } from '../../shared/combat/damage';
import {
  applyGuardDamage,
  createGuardMeter,
  isGuardBroken,
  regenGuard,
} from '../../shared/combat/guard';
import { resolveDefense } from '../../shared/combat/counter';
import {
  createDodgeState,
  dodgeReadyFraction,
  isDodgeActive,
  isPerfectDodge,
  startDodge,
} from '../../shared/combat/dodge';
import {
  burstGainFor,
  canActivateBurst,
  classifyHitBurstEvent,
} from '../../shared/combat/burst';
import { isStrikeBlocked } from '../../shared/combat/directionalGuard';
import { PlayerPatternTracker } from '../../shared/combat/patterns';
import { blockedHitGuardCost } from '../../shared/combat/playerGuard';
import { EnemyBrain } from '../../shared/combat/EnemyBrain';
import {
  addCoins,
  advanceFrozenRhythm,
  claimGambit,
  createRunState,
  equipWeapon,
  MERCHANT_OFFERS,
  modifiersForRun,
  modifyStrikeForRun,
  rewardGambitsForRun,
  shuffledGambitDeck,
  spendCoins,
  weaponForRun,
  type MerchantOffer,
  type RunState,
} from '../../shared/run/state';
import { GAMBITS, type GambitId } from '../../shared/run/gambits';
import { encounterSeed, seededRandom } from '../../shared/run/daily';
import { createFallenRivalDefinition } from '../../shared/balance/rivals';
import type {
  ActiveHitZone,
  BurstEvent,
  DodgeState,
  GestureClassification,
  GesturePoint,
  GuardMeter,
} from '../../shared/combat/types';
import { SwipeInput } from '../combat/SwipeInput';
import { PaperEnemyView } from '../entities/PaperEnemyView';
import { PlayerRigView } from '../entities/PlayerRigView';
import { Hud } from '../ui/Hud';
import {
  buildBackdrop,
  buildCastleBackdrop,
  spawnRoadMark,
  spawnRoadsideDrift,
  type BackdropHandles,
} from '../ui/backdrop';
import { damageVignette, drawSlashTrail, spawnPaperFragments } from '../ui/effects';
import { DODGE_TEXT, FONT, MUTED_TEXT, PAPER, PARCHMENT_TEXT } from '../ui/theme';
import {
  REWARD_SCENE_KEY,
  type RewardChoice,
  type RewardChoices,
  type RewardSceneData,
} from './RewardScene';

const ENEMY_POSITION = { x: 700, y: 600 };
const FIRST_TRAVEL_MS = 2400;
const TRAVEL_MS = 4200;
const HEAL_PER_KILL = 18;
const COINS_PER_ROAD_FOE = 10;
const ROAD_REWARD_FIGHTS: readonly number[] = [1, 3];
const MERCHANT_FIGHTS: readonly number[] = [2, 4];
const FROZEN_RHYTHM_SLOW = { durationMs: 1100, factor: 0.72 };

type Mode = 'travel' | 'fight' | 'over';

/** The road leads to the gates; past them, the throne room and the King. */
type Stage = 'road' | 'castle' | 'rival';

type RunStats = DailyScoreStats;

/** Run state that survives the scene restart when stepping into the castle. */
type CarriedRun = {
  playerHealth: number;
  playerBurst: number;
  stats: RunStats;
  runStartAt: number;
  run: RunState;
  dailyRun: DailyRunStartResponse | null;
  fallenRival: FallenRival | null;
};

type BattleStartData = {
  stage?: Stage;
  carry?: CarriedRun;
  dailyRun?: DailyRunStartResponse;
  rival?: FallenRival;
};

/**
 * The road itself: one continuous scene. The player walks toward the tower;
 * enemies step out of the fog one after another; the run ends only in death.
 */
export class BattleScene extends Phaser.Scene {
  private mode: Mode;
  private stage: Stage;
  private carried: CarriedRun | null;
  private encounterNumber: number;

  private def: EnemyDefinition | null;
  private enemyView: PaperEnemyView | null;
  private brain: EnemyBrain | null;
  private enemyHealth: number;
  private enemyGuard: GuardMeter;
  private enemyGuardBrokenState: boolean;

  private backdrop: BackdropHandles;
  private rig: PlayerRigView;
  private hud: Hud;
  private tracker: PlayerPatternTracker;
  private contacts: ContactState = EMPTY_CONTACTS;

  private playerHealth: number;
  private playerGuard: GuardMeter;
  private playerBurst: number;
  private playerDodge: DodgeState;
  private holdingBlock: boolean;
  private lastShieldPressAt: number | null;
  private nextAttackReadyAt: number;

  private hitStopUntil: number;
  private burstActive: boolean;
  private secondWindUsed: boolean;
  private nextSpawnAt: number;
  private runStartAt: number;
  private stats: RunStats;
  private run: RunState;
  private roadEnemyIds: readonly string[];
  private dailyRun: DailyRunStartResponse | null;
  private fallenRival: FallenRival | null;

  constructor() {
    super('Battle');
  }

  init(data?: BattleStartData): void {
    this.stage = data?.stage === 'castle' || data?.stage === 'rival' ? data.stage : 'road';
    this.carried = data?.carry ?? null;
    this.dailyRun = data?.dailyRun ?? data?.carry?.dailyRun ?? null;
    this.fallenRival = data?.rival ?? data?.carry?.fallenRival ?? null;
  }

  create(): void {
    this.tweens.timeScale = 1;
    this.cameras.main.setZoom(1).setScroll(0, 0);
    this.mode = 'travel';
    this.encounterNumber = 1;
    this.def = null;
    this.enemyView = null;
    this.brain = null;
    this.enemyHealth = 0;
    this.enemyGuard = createGuardMeter(1);
    this.enemyGuardBrokenState = false;
    this.playerHealth = this.carried?.playerHealth ?? PLAYER_BALANCE.maxHealth;
    this.run =
      this.carried?.run ??
      createRunState({
        gambitDeck: this.dailyRun
          ? this.dailyRun.daily.gambitDeck
          : shuffledGambitDeck(Math.random),
      });
    this.roadEnemyIds = this.dailyRun?.daily.roadEnemyIds ?? randomizedRoadRoute(Math.random);
    this.playerGuard = createGuardMeter(this.playerMaxGuard());
    this.playerBurst = this.carried?.playerBurst ?? 0;
    this.playerDodge = createDodgeState();
    this.holdingBlock = false;
    this.lastShieldPressAt = null;
    this.nextAttackReadyAt = 0;
    this.hitStopUntil = 0;
    this.burstActive = false;
    this.secondWindUsed = false;
    this.runStartAt = this.carried?.runStartAt ?? this.time.now;
    this.stats = this.carried?.stats ?? {
      foesFelled: 0,
      damageDealt: 0,
      damageTaken: 0,
      weakPointHits: 0,
      perfectCounters: 0,
      dodgeCounters: 0,
      attacksEvaded: 0,
    };
    this.tracker = new PlayerPatternTracker();

    this.backdrop =
      this.stage === 'castle'
        ? buildCastleBackdrop(this)
        : buildBackdrop(this);
    this.rig = new PlayerRigView(this);
    this.rig.setWeapon(this.run.weaponId);
    this.hud = new Hud(this, {
      onShieldDown: () => this.pressShield(),
      onShieldUp: () => this.releaseShield(),
      onDodgePressed: () => this.pressDodge(),
      onBurstPressed: () => this.tryActivateBurst(),
    });
    this.hud.setEnemyActive(null);
    this.syncRunHud();

    new SwipeInput(this, {
      isBlockedAt: (x, y) => this.hud.isPointOverUi(x, y),
      onGesture: (gesture) => this.onGesture(gesture),
      onSegment: (a, b, inputTs) => this.onSwipeSegment(a, b, inputTs),
      onRelease: (t) => this.closeContacts(t, performance.now()),
    });

    // Desktop controls: Space or right mouse to block, Shift to dodge, Q for burst.
    this.input.keyboard?.on('keydown-SPACE', (event: KeyboardEvent) => {
      if (!event.repeat) this.pressShield();
    });
    this.input.keyboard?.on('keyup-SPACE', () => this.releaseShield());
    this.input.keyboard?.on('keydown-SHIFT', (event: KeyboardEvent) => {
      if (!event.repeat) this.pressDodge();
    });
    this.input.keyboard?.on('keydown-Q', () => this.tryActivateBurst());
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) this.pressShield();
    });
    this.input.on(Phaser.Input.Events.POINTER_UP, (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonReleased()) this.releaseShield();
    });

    // Roadside silhouettes rush past while walking.
    this.time.addEvent({
      delay: 640,
      loop: true,
      callback: () => {
        if (this.mode === 'travel' && this.stage === 'road') {
          const intensity = Math.min(
            1,
            (this.encounterNumber - 1) / ROAD_FIGHTS_BEFORE_BOSS
          );
          spawnRoadsideDrift(this, intensity);
        }
      },
    });
    this.time.addEvent({
      delay: 230,
      loop: true,
      callback: () => {
        if (this.mode === 'travel' && this.stage === 'road') {
          const intensity = Math.min(
            1,
            (this.encounterNumber - 1) / ROAD_FIGHTS_BEFORE_BOSS
          );
          spawnRoadMark(this, intensity);
          if (intensity > 0.5 && Math.random() < intensity * 0.32) {
            spawnRoadMark(this, intensity);
          }
        }
      },
    });

    if (this.stage === 'castle') {
      this.cameras.main.fadeIn(700, 0, 0, 0);
      this.hud.showMessage('THE THRONE ROOM OF THE FALLEN KING', '#8fd8ff', 26);
      this.nextSpawnAt = this.time.now + 1800;
    } else {
      this.hud.showMessage('THE ROAD TO THE TOWER', '#ffb347', 30);
      this.nextSpawnAt = this.time.now + FIRST_TRAVEL_MS;
    }
  }

  override update(time: number, delta: number): void {
    const inHitStop = time < this.hitStopUntil;
    this.tweens.timeScale = inHitStop ? 0.05 : 1;

    // Player stamina does not regenerate — it refills only on a won duel.
    if (this.mode === 'fight' && this.brain && this.def && this.enemyView && !inHitStop) {
      this.brain.update(time, {
        healthFraction: this.enemyHealth / this.def.maxHealth,
        signals: this.tracker.signals(),
      });
      this.enemyView.updateIdle(time);
      this.enemyGuard = regenGuard(this.enemyGuard, time, delta, this.brain.isBlocking(), {
        regenPerSecond: this.def.guardRegenPerSecond,
        regenDelayMs: this.def.guardRegenDelayMs,
      });
    }

    if (this.mode === 'travel' && time >= this.nextSpawnAt) {
      this.spawnEnemy();
    }

    this.hud.update({
      playerHealth: this.playerHealth,
      playerMaxHealth: PLAYER_BALANCE.maxHealth,
      playerGuard: this.playerGuard.current,
      playerMaxGuard: this.playerGuard.max,
      playerGuardBroken: isGuardBroken(this.playerGuard, time),
      dodgeReady01: dodgeReadyFraction(this.playerDodge, time, PLAYER_BALANCE.dodgeCooldownMs),
      burst: this.playerBurst,
      burstMax: PLAYER_BALANCE.burstMax,
      enemyHealth: this.enemyHealth,
      enemyMaxHealth: this.def?.maxHealth ?? 1,
      enemyGuard: this.enemyGuard.current,
      enemyMaxGuard: this.enemyGuard.max,
    });
  }

  // ------------------------------------------------------------------
  // Encounter flow
  // ------------------------------------------------------------------

  private spawnEnemy(): void {
    const bossFight = this.stage === 'castle' || this.encounterNumber > ROAD_FIGHTS_BEFORE_BOSS;
    const id =
      this.roadEnemyIds[this.encounterNumber - 1] ??
      GAUNTLET_ORDER[(this.encounterNumber - 1) % GAUNTLET_ORDER.length]!;
    const rivalDefinition =
      this.stage === 'rival' && this.fallenRival
        ? createFallenRivalDefinition(this.fallenRival)
        : null;
    const def =
      rivalDefinition ??
      (this.stage === 'castle'
        ? FALLEN_KING
        : bossFight
          ? GATEKEEPER
          : (ENEMIES[id] ?? ROAD_SOLDIER));
    this.def = def;
    this.enemyHealth = def.maxHealth;
    this.enemyGuard = createGuardMeter(def.maxGuard);
    this.enemyGuardBrokenState = false;
    this.secondWindUsed = false;

    const view = new PaperEnemyView(this, ENEMY_POSITION.x, ENEMY_POSITION.y, def);
    view.playSpawn();
    this.enemyView = view;

    this.brain = new EnemyBrain(
      def,
      {
        onTelegraphStart: (attack, impactAt) => {
          playSfx(this, 'telegraph');
          view.playTelegraph(
            Math.max(1, impactAt - this.time.now),
            PLAYER_BALANCE.counterWindowMs,
            attack.style
          );
        },
        onAttackImpact: (attack) => this.onEnemyAttackImpact(attack),
        onRecoverStart: () => view.playRecover(),
        onBlockStart: (stance) => view.playBlock(stance),
        onBlockEnd: () => view.endBlock(),
        onDodgeStart: (direction) =>
          view.playDodge(direction, def.behavior.dodgeDurationMs, def.behavior.dodgeDistance),
        onDodgeEnd: () => {},
        onCounterStanceStart: (totalMs) => view.showCounterStance(totalMs),
        onCounterStanceEnd: () => view.hideCounterStance(),
        onParry: () => this.onParried(),
        onStaggerStart: () => view.playStagger(),
        onGuardBreakStart: () => this.onEnemyGuardBreak(),
        onVulnerableEnd: () => this.onEnemyVulnerableEnd(),
        onPhaseChange: (phase) => {
          view.playPhaseChange();
          const phaseMessages: Record<string, string> = {
            enraged: 'THE DUELIST IS ENRAGED!',
            'gate-fury': "THE GATEKEEPER'S FURY RISES!",
            'last-stand': 'THE GATEKEEPER MAKES A LAST STAND!',
          };
          this.hud.showMessage(phaseMessages[phase.id] ?? 'THE FOE CHANGES STANCE!', '#d94f3d');
          this.cameras.main.shake(120, 0.005);
        },
      },
      this.dailyRun && this.stage !== 'rival'
        ? seededRandom(encounterSeed(this.dailyRun.daily.seed, this.stage, this.encounterNumber))
        : Math.random,
      this.time.now + 700
    );

    this.hud.setEnemyActive(def.name);
    if (this.stage === 'castle') {
      this.hud.showMessage('THE FALLEN KING RISES', '#8fd8ff', 34);
      this.cameras.main.shake(260, 0.007);
    } else if (this.stage === 'rival' && this.fallenRival) {
      this.hud.showMessage(`u/${this.fallenRival.username.toUpperCase()} STIRS AGAIN`, '#8fd8ff', 29);
      this.cameras.main.shake(180, 0.006);
    } else if (bossFight) {
      this.hud.showMessage('THE GATEKEEPER BARS THE GATES', '#ffd75e', 30);
      this.cameras.main.shake(200, 0.006);
    } else {
      this.hud.showMessage(`A ${def.name.toUpperCase()} BLOCKS THE ROAD`, '#d94f3d', 26);
    }
    this.mode = 'fight';
  }

  private onEnemyFelled(): void {
    if (!this.enemyView || this.mode !== 'fight') return;
    const felled = this.def;
    const view = this.enemyView;
    const completedEncounter = this.encounterNumber;
    this.mode = 'travel';
    this.stats.foesFelled += 1;
    playSfx(this, 'felled');
    playBaseHaptic(this, felled?.tier === 'boss' ? 'boss_kill' : 'enemy_kill');
    this.encounterNumber += 1;
    this.gainPlayerBurst('kill');
    this.healPlayer(HEAL_PER_KILL);
    // Winning the duel is the only thing that repairs the shield.
    this.playerGuard = createGuardMeter(this.playerMaxGuard());
    if (this.stage === 'road' && felled?.tier !== 'boss') {
      this.run = addCoins(this.run, COINS_PER_ROAD_FOE);
      this.syncRunHud();
    }
    this.holdingBlock = false;
    this.lastShieldPressAt = null;
    this.rig.restoreShield();
    this.brain?.notifyDied();
    this.hud.setEnemyActive(null);

    const torso = view.getHitZones().find((z) => z.id === 'torso');
    if (torso) spawnPaperFragments(this, torso.shape.x, torso.shape.y, 18);
    view.playDeath(() => {
      view.destroy();
      if (this.enemyView === view) {
        this.enemyView = null;
        this.brain = null;
        this.def = null;
      }
    });

    if (this.stage === 'rival') {
      this.handleTriumph();
      void this.recordVictory();
      return;
    }

    if (felled?.tier === 'boss') {
      if (felled.id === GATEKEEPER.id && this.stage === 'road') {
        this.openFinalBossReward();
      } else {
        this.handleTriumph();
      }
    } else {
      const gatesNext = this.encounterNumber > ROAD_FIGHTS_BEFORE_BOSS;
      const hasInterlude = this.hasInterludeAfterRoadFight(completedEncounter);
      if (!hasInterlude) {
        this.time.delayedCall(900, () => {
          if (this.mode !== 'over') {
            this.hud.showMessage(
              gatesNext ? 'THE CASTLE GATES LOOM AHEAD' : 'THE ROAD CONTINUES',
              '#ffb347',
              28
            );
          }
        });
      }
      const travelMs = gatesNext ? TRAVEL_MS + 1000 : TRAVEL_MS;
      this.nextSpawnAt = this.time.now + travelMs;
      if (gatesNext) {
        this.approachGates(travelMs - 400);
      } else {
        this.approachTower(travelMs - 400);
      }
      if (hasInterlude) this.openInterludeAfterRoadFight(completedEncounter);
    }
    void this.recordVictory();
  }

  /**
   * Each stretch of road walked brings the castle visibly closer: the tower
   * grows from its distant 0.38 up toward ~0.87 across the road fights.
   */
  private approachTower(durationMs: number): void {
    const { tower, towerAura, roadGlow } = this.backdrop;
    const progress = Math.min(1, (this.encounterNumber - 1) / ROAD_FIGHTS_BEFORE_BOSS);
    if (tower) {
      this.tweens.add({
        targets: tower,
        scale: 0.38 * Math.pow(2.3, progress),
        alpha: 0.88 + progress * 0.12,
        duration: durationMs,
        ease: 'Sine.easeInOut',
      });
    }
    if (towerAura) {
      this.tweens.add({
        targets: towerAura,
        scaleX: 1 + progress * 0.85,
        scaleY: 1 + progress * 0.45,
        alpha: 0.48 + progress * 0.22,
        duration: durationMs,
        ease: 'Sine.easeInOut',
      });
    }
    if (roadGlow) {
      this.tweens.add({
        targets: roadGlow,
        alpha: 0.05 + progress * 0.09,
        duration: durationMs,
        ease: 'Sine.easeInOut',
      });
    }
  }

  /**
   * The Gatekeeper falls and the gates swing open: fade to black and restart
   * this scene inside the castle, carrying the run's health/burst/stats.
   */
  private enterCastle(): void {
    if (this.mode === 'over') return;
    this.nextSpawnAt = Number.POSITIVE_INFINITY;
    this.hud.showMessage('THE GATES OPEN', '#ffd75e', 40);
    this.time.delayedCall(1200, () => {
      if (this.mode === 'over') return;
      this.cameras.main.fadeOut(800, 0, 0, 0);
      this.cameras.main.once(
        Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE,
        () => {
          this.scene.restart({
            stage: 'castle',
            carry: {
              playerHealth: this.playerHealth,
              playerBurst: this.playerBurst,
              stats: this.stats,
              runStartAt: this.runStartAt,
              run: this.run,
              dailyRun: this.dailyRun,
              fallenRival: this.fallenRival,
            },
          });
        }
      );
    });
  }

  /**
   * The last stretch: the tower slides past overhead while the castle gate
   * fills the road's end, where the Gatekeeper waits.
   */
  private approachGates(durationMs: number): void {
    const { tower, gate, towerAura, roadGlow } = this.backdrop;
    if (tower) {
      this.tweens.killTweensOf(tower);
      this.tweens.add({
        targets: tower,
        scale: tower.scale * 1.35,
        alpha: 0,
        duration: durationMs * 0.8,
        ease: 'Sine.easeIn',
      });
    }
    if (gate) {
      this.tweens.killTweensOf(gate);
      const finalScale = gate.scale;
      gate.setScale(finalScale * 0.8).setAlpha(0);
      this.tweens.add({
        targets: gate,
        scale: finalScale,
        alpha: 1,
        duration: durationMs,
        ease: 'Sine.easeOut',
      });
    }
    if (towerAura) {
      this.tweens.add({
        targets: towerAura,
        scaleX: 2.35,
        scaleY: 1.55,
        alpha: 0.82,
        duration: durationMs,
        ease: 'Sine.easeOut',
      });
    }
    if (roadGlow) {
      this.tweens.add({
        targets: roadGlow,
        alpha: 0.2,
        duration: durationMs,
        ease: 'Sine.easeOut',
      });
    }
  }

  private async recordVictory(): Promise<void> {
    try {
      await fetch('/api/victory', { method: 'POST' });
    } catch {
      // Offline or local dev — the run continues regardless.
    }
  }

  /** Pause the walk at the two reward nodes and the single merchant node. */
  private openInterludeAfterRoadFight(completedEncounter: number): void {
    if (this.stage !== 'road') return;
    this.time.delayedCall(760, () => {
      if (this.mode !== 'travel' || this.stage !== 'road') return;
      if (ROAD_REWARD_FIGHTS.includes(completedEncounter)) {
        this.openGambitReward();
      } else if (MERCHANT_FIGHTS.includes(completedEncounter)) {
        this.openMerchant(completedEncounter);
      }
    });
  }

  private hasInterludeAfterRoadFight(completedEncounter: number): boolean {
    return (
      ROAD_REWARD_FIGHTS.includes(completedEncounter) ||
      MERCHANT_FIGHTS.includes(completedEncounter)
    );
  }

  /** The Gatekeeper's fall earns one last choice before the Fallen King. */
  private openFinalBossReward(): void {
    this.nextSpawnAt = Number.POSITIVE_INFINITY;
    this.time.delayedCall(820, () => {
      if (this.mode === 'travel' && this.stage === 'road') {
        this.openGambitReward(true);
      }
    });
  }

  private openGambitReward(beforeFinalBoss = false): void {
    const gambits = rewardGambitsForRun(this.run);
    const [first, second, third] = gambits;
    if (!first || !second || !third) {
      if (beforeFinalBoss) this.enterCastle();
      return;
    }
    const choices: RewardChoices = [
      this.gambitRewardChoice(first.id),
      this.gambitRewardChoice(second.id),
      this.gambitRewardChoice(third.id),
    ];
    const data: RewardSceneData = {
      choices,
      title: beforeFinalBoss ? 'ONE LAST GAMBIT' : 'CHOOSE A GAMBIT',
      subtitle: beforeFinalBoss
        ? 'The Fallen King waits beyond the throne-room doors. Choose your burden.'
        : 'Take power from the road. Its price comes with it.',
      resumeScene: this.scene.key,
      onSelected: (selection) => {
        const selected = gambits.find((gambit) => gambit.id === selection.choice.id);
        if (!selected) return;
        this.run = claimGambit(this.run, selected.id);
        this.syncPlayerGuardCapacity();
        this.syncRunHud();
        this.hud.showMessage(`${selected.name.toUpperCase()} TAKEN`, '#ffb347', 27);
      },
    };
    this.launchRewardScene(
      data,
      beforeFinalBoss ? this.enterCastle : this.resumeRoadAfterInterlude
    );
  }

  private gambitRewardChoice(gambitId: GambitId): RewardChoice {
    const gambit = GAMBITS[gambitId];
    return {
      id: gambit.id,
      title: gambit.name,
      description: gambit.benefit,
      detail: `DRAWBACK: ${gambit.drawback}`,
      category: 'Gambit',
      accent: PAPER.burst,
    };
  }

  private openMerchant(completedEncounter: number): void {
    const [mend, spear, hammer, dagger, mace] = MERCHANT_OFFERS;
    if (!mend || !spear || !hammer || !dagger || !mace) return;
    const offers: readonly [MerchantOffer, MerchantOffer, MerchantOffer] =
      completedEncounter >= 4
        ? [mend, hammer, mace]
        : [mend, spear, dagger];
    const [first, second, third] = offers;
    const choices: RewardChoices = [
      this.merchantRewardChoice(first),
      this.merchantRewardChoice(second),
      this.merchantRewardChoice(third),
    ];
    const data: RewardSceneData = {
      choices,
      title: 'THE PAPER PEDDLER',
      subtitle: `${this.run.coins} coins in hand. ${
        completedEncounter >= 4 ? 'The heavy rack opens.' : 'Choose speed, reach, or repair.'
      }`,
      resumeScene: this.scene.key,
      onSelected: (selection) => {
        const selected = offers.find((offer) => offer.id === selection.choice.id);
        if (!selected) return;
        const paidRun = spendCoins(this.run, selected.price);
        if (!paidRun) {
          this.hud.showMessage('NOT ENOUGH COINS', '#d94f3d', 26);
          return;
        }
        this.run = paidRun;
        if (selected.kind === 'heal') {
          this.healPlayer(selected.healing);
          this.hud.showMessage('PAPER MENDED', '#7fc9a0', 27);
        } else {
          this.run = equipWeapon(this.run, selected.weaponId);
          this.rig.setWeapon(selected.weaponId);
          this.hud.showMessage(`${selected.name.toUpperCase()} TAKEN`, '#ffb347', 27);
        }
        this.syncRunHud();
      },
    };
    this.launchRewardScene(data);
  }

  private merchantRewardChoice(offer: MerchantOffer): RewardChoice {
    return {
      id: offer.id,
      title: offer.name,
      description: offer.description,
      detail: `${offer.price} COINS`,
      category: offer.kind === 'heal' ? 'Service' : 'Weapon',
      accent: offer.kind === 'heal' ? PAPER.dodge : PAPER.guard,
    };
  }

  private launchRewardScene(
    data: RewardSceneData,
    onResume: () => void = this.resumeRoadAfterInterlude
  ): void {
    this.events.once(Phaser.Scenes.Events.RESUME, onResume, this);
    this.scene.launch(REWARD_SCENE_KEY, data);
    this.scene.pause();
  }

  /** Reward overlays do not spend the next encounter's travel time. */
  private resumeRoadAfterInterlude(): void {
    this.cameras.main.setZoom(1).setScroll(0, 0);
    const gatesNext =
      this.stage === 'road' && this.encounterNumber > ROAD_FIGHTS_BEFORE_BOSS;
    this.nextSpawnAt =
      this.game.loop.time + (gatesNext ? TRAVEL_MS + 1000 : TRAVEL_MS);
  }

  private playerMaxGuard(): number {
    return Math.round(PLAYER_BALANCE.maxGuard * modifiersForRun(this.run).maxGuardMultiplier);
  }

  private syncPlayerGuardCapacity(): void {
    const max = this.playerMaxGuard();
    this.playerGuard = {
      ...this.playerGuard,
      max,
      current: Math.min(this.playerGuard.current, max),
    };
  }

  private healPlayer(amount: number): void {
    const modifiers = modifiersForRun(this.run);
    const healed = Math.round(amount * modifiers.healingReceivedMultiplier);
    this.playerHealth = Math.min(PLAYER_BALANCE.maxHealth, this.playerHealth + healed);
  }

  private gainPlayerBurst(event: BurstEvent): void {
    const modifiers = modifiersForRun(this.run);
    const lowHealth = this.playerHealth / PLAYER_BALANCE.maxHealth <= 0.3;
    const directAttack =
      event === 'torsoHit' || event === 'weakPointHit' || event === 'heavyHit';
    const multiplier =
      (lowHealth ? modifiers.lowHealthBurstGainMultiplier : 1) *
      (directAttack ? modifiers.attackBurstGainMultiplier : 1);
    this.playerBurst = Math.min(
      PLAYER_BALANCE.burstMax,
      this.playerBurst + Math.round(burstGainFor(event) * multiplier)
    );
  }

  private syncRunHud(): void {
    this.hud.setRunInfo(
      weaponForRun(this.run).name,
      this.run.gambitIds.length,
      this.run.coins
    );
  }

  // ------------------------------------------------------------------
  // Player offense
  // ------------------------------------------------------------------

  private onGesture(gesture: GestureClassification): void {
    if (gesture.kind !== 'swipe') return;
    if (this.mode === 'over' || this.burstActive) return;
    const now = this.time.now;
    const weapon = weaponForRun(this.run);
    const modifiers = modifiersForRun(this.run);

    // The shield commits you: no swinging while it is raised.
    if (this.holdingBlock) {
      this.hud.showFloatingText(gesture.end.x, gesture.end.y, 'guarding', MUTED_TEXT);
      return;
    }
    if (now < this.nextAttackReadyAt) return;
    const recoveryMs = gesture.heavy ? weapon.heavy.recoveryMs : weapon.recoveryMs;
    this.nextAttackReadyAt = now + Math.round(recoveryMs * modifiers.attackRecoveryMultiplier);

    this.rig.swing(gesture.direction, gesture.heavy);
    playSfx(this, gesture.heavy ? 'swing_heavy' : 'swing_light');

    const brain = this.brain;
    const view = this.enemyView;
    const def = this.def;
    if (this.mode !== 'fight' || !brain || !view || !def || brain.isDead()) {
      drawSlashTrail(this, gesture.path, gesture.heavy, false);
      return;
    }

    const hitZone = resolveHit(gesture.path, this.strikeZones(view));
    drawSlashTrail(this, gesture.path, gesture.heavy, hitZone !== null);
    this.tracker.recordAttack(gesture.direction, hitZone?.id ?? null, now);

    if (!hitZone) {
      const note = brain.isDodging() ? 'DODGED' : 'miss';
      this.hud.showFloatingText(gesture.end.x, gesture.end.y, note, MUTED_TEXT);
      return;
    }

    // Striking into a live counter stance gets parried and punished.
    if (brain.isCounterStanceActive(now)) {
      brain.triggerRiposte(now);
      return;
    }

    const zonePos = this.zoneCenter(hitZone);
    const strike = modifyStrikeForRun(
      this.run,
      computeStrike(weapon, hitZone.id, gesture.heavy),
      hitZone.id,
      gesture.heavy
    );
    const stance = brain.currentStance();

    if (stance && isStrikeBlocked(stance, hitZone.id, gesture.direction)) {
      // The guard covers this strike: chip damage plus real guard pressure.
      const chip = blockedDamage(strike.damage, def.blockDamageReduction);
      this.enemyHealth = Math.max(0, this.enemyHealth - chip);
      this.stats.damageDealt += chip;
      view.playBlockedHit();
      playSfx(this, 'enemy_block');
      spawnPaperFragments(this, zonePos.x - 40, zonePos.y, 3, PAPER.guard);
      this.hud.showFloatingText(zonePos.x, zonePos.y - 20, 'BLOCKED', '#4f8fdd');
      this.applyEnemyGuardDamage(strike.guardDamage, now);
    } else {
      const zoneInfo = zoneBalance(hitZone.id);
      const damage = brain.isVulnerable()
        ? guardBrokenDamage(strike.damage, def.guardBrokenDamageTakenMultiplier)
        : strike.damage;
      this.enemyHealth = Math.max(0, this.enemyHealth - damage);
      this.stats.damageDealt += damage;
      const lifeSteal = Math.floor(
        damage * modifiersForRun(this.run).directDamageHealingFraction
      );
      if (lifeSteal > 0) this.healPlayer(lifeSteal);
      if (zoneInfo.weakPoint) this.stats.weakPointHits += 1;
      this.gainPlayerBurst(classifyHitBurstEvent(zoneInfo.weakPoint, gesture.heavy));
      view.playHitReaction(hitZone.id, gesture.heavy);
      playSfx(this, `hit_${weapon.id}`, { volume: gesture.heavy ? 1.2 : 1 });
      playBaseHaptic(this, 'enemy_hit');
      if (zoneInfo.weakPoint) playSfx(this, 'hit_weak');
      spawnPaperFragments(this, zonePos.x, zonePos.y, gesture.heavy ? 10 : 6);
      this.hud.showFloatingText(
        zonePos.x,
        zonePos.y - 24,
        `-${damage}`,
        zoneInfo.weakPoint ? '#d94f3d' : PARCHMENT_TEXT
      );
      if (zoneInfo.weakPoint || gesture.heavy) {
        this.hitStopUntil = now + 70;
        this.cameras.main.shake(90, 0.004);
      }

      // Zone side effects: leg hits slow, weapon-hand hits can interrupt.
      const slow = zoneInfo.slow;
      if (slow) {
        brain.applySlow(now, slow.durationMs, slow.factor);
        this.hud.showFloatingText(zonePos.x, zonePos.y - 60, 'SLOWED', '#4f8fdd');
      }
      if (
        zoneInfo.interruptChance !== undefined &&
        brain.isTelegraphing() &&
        Math.random() < zoneInfo.interruptChance
      ) {
        brain.notifyInterrupted(now);
        this.hud.showMessage('INTERRUPTED!', '#4f8fdd', 30);
      }
      const rhythm = advanceFrozenRhythm(this.run);
      this.run = rhythm.state;
      if (rhythm.triggered) {
        brain.applySlow(
          now,
          FROZEN_RHYTHM_SLOW.durationMs,
          FROZEN_RHYTHM_SLOW.factor
        );
        this.hud.showMessage('FROZEN RHYTHM!', '#8fd8ff', 26);
      }
      if (gesture.heavy && weapon.heavyStaggerMs > 0) {
        brain.applySlow(now, weapon.heavyStaggerMs, 0.4);
        this.hud.showFloatingText(zonePos.x, zonePos.y - 60, 'STAGGERED', '#ffb347');
      }
    }

    if (this.enemyHealth <= 0) this.onEnemyFelled();
  }

  /** Live hit zones as the current weapon sees them (wider head for some). */
  private strikeZones(view: PaperEnemyView): ActiveHitZone[] {
    const weapon = weaponForRun(this.run);
    return view.getHitZones().map((zone): ActiveHitZone => {
      if (zone.id !== 'head' || zone.shape.type !== 'circle') return zone;
      return {
        ...zone,
        shape: {
          ...zone.shape,
          radius: zone.shape.radius * weapon.weakPointHitRadiusMultiplier,
        },
      };
    });
  }

  /**
   * Blade contact while the swipe is still moving. Sensory only — the strike
   * resolves on release in onGesture. Contacts are suppressed whenever that
   * release would be ignored anyway (shield up, recovering, bursting).
   */
  private onSwipeSegment(a: GesturePoint, b: GesturePoint, inputTs: number): void {
    const view = this.enemyView;
    const live =
      this.mode === 'fight' &&
      !this.burstActive &&
      !this.holdingBlock &&
      this.time.now >= this.nextAttackReadyAt &&
      view !== null &&
      this.brain !== null &&
      !this.brain.isDead();
    if (!live || !view) {
      this.closeContacts(b.t, inputTs);
      return;
    }
    const step = stepContacts(this.contacts, a, b, this.strikeZones(view));
    this.contacts = step.state;
    this.emitContacts(step.events, inputTs);
  }

  private closeContacts(t: number, inputTs: number): void {
    if (this.contacts.touching.size === 0) return;
    this.emitContacts(releaseContacts(this.contacts, t), inputTs);
    this.contacts = EMPTY_CONTACTS;
  }

  private emitContacts(events: readonly ContactEvent[], inputTs: number): void {
    for (const event of events) {
      const signal: ContactSignal = { ...event, inputTs, emitTs: performance.now() };
      this.game.events.emit(CONTACT_EVENT, signal);
    }
  }

  private zoneCenter(zone: ActiveHitZone): { x: number; y: number } {
    return { x: zone.shape.x, y: zone.shape.y };
  }

  private applyEnemyGuardDamage(amount: number, now: number): void {
    if (this.enemyGuardBrokenState || !this.def || !this.brain) return;
    const result = applyGuardDamage(this.enemyGuard, amount, now, this.def.guardBreakDurationMs);
    this.enemyGuard = result.meter;
    if (result.broke) this.brain.notifyGuardBroken(now);
  }

  private onEnemyGuardBreak(): void {
    this.enemyGuardBrokenState = true;
    this.enemyView?.playGuardBreak();
    playSfx(this, 'guard_break');
    this.hud.showMessage('ENEMY GUARD BROKEN!', '#d94f3d');
    const torso = this.enemyView?.getHitZones().find((z) => z.id === 'torso');
    if (torso) spawnPaperFragments(this, torso.shape.x, torso.shape.y, 14);
    this.cameras.main.shake(140, 0.006);
  }

  private onEnemyVulnerableEnd(): void {
    this.enemyView?.endVulnerable();
    if (this.enemyGuardBrokenState) {
      this.enemyGuardBrokenState = false;
      // A recovered foe straightens up with partial guard, not zero.
      this.enemyGuard = {
        ...this.enemyGuard,
        current: Math.round(this.enemyGuard.max * 0.4),
      };
    }
  }

  /** The player's strike was caught by the Duelist's counter stance. */
  private onParried(): void {
    this.enemyView?.playParry();
    playSfx(this, 'parried');
    this.hud.showMessage('PARRIED!', '#d94f3d', 32);
    this.cameras.main.shake(90, 0.004);
    // The riposte itself arrives via the normal telegraph -> impact flow,
    // so it can still be blocked or perfect-countered.
  }

  // ------------------------------------------------------------------
  // Player defense
  // ------------------------------------------------------------------

  private pressShield(): void {
    if (this.mode === 'over') return;
    const now = this.time.now;
    if (isGuardBroken(this.playerGuard, now)) return;
    this.lastShieldPressAt = now;
    if (!this.holdingBlock) {
      this.holdingBlock = true;
      this.tracker.recordBlock(now);
      this.rig.raiseShield();
    }
  }

  private releaseShield(): void {
    if (!this.holdingBlock) return;
    this.holdingBlock = false;
    if (!isGuardBroken(this.playerGuard, this.time.now) && this.mode !== 'over') {
      this.rig.lowerShield();
    }
  }

  /** Tap dodge: brief evasion frames on a cooldown. */
  private pressDodge(): void {
    if (this.mode === 'over' || this.burstActive) return;
    const now = this.time.now;
    const result = startDodge(this.playerDodge, now, PLAYER_BALANCE);
    if (!result.started) return;
    this.playerDodge = result.state;
    playSfx(this, 'dodge');
    this.rig.playDodge(PLAYER_BALANCE.dodgeDurationMs);
  }

  private onEnemyAttackImpact(attack: EnemyAttackDefinition): void {
    if (this.mode !== 'fight') return;
    const now = this.time.now;

    // A live dodge slips the blow entirely — no damage, no guard chip.
    if (isDodgeActive(this.playerDodge, now)) {
      this.stats.attacksEvaded += 1;
      const perfectDodge = isPerfectDodge(
        this.playerDodge,
        now,
        PLAYER_BALANCE.counterWindowMs
      );
      this.gainPlayerBurst(perfectDodge ? 'perfectCounter' : 'evade');
      this.rig.evadeFlash();
      if (perfectDodge) {
        this.stats.dodgeCounters += 1;
        playSfx(this, 'counter');
        this.tracker.recordCounter(now);
        this.rig.counterFlash();
        this.hud.showMessage('DODGE COUNTER!', '#7fc9a0', 30);
        this.cameras.main.flash(90, 40, 80, 60);
        this.brain?.notifyCountered(now);
        this.applyEnemyGuardDamage(
          Math.round(
            attack.counterGuardDamage *
              0.8 *
              modifiersForRun(this.run).counterGuardDamageMultiplier
          ),
          now
        );
        this.restorePlayerGuard(modifiersForRun(this.run).counterGuardRestore);
        this.hud.showFloatingText(420, 500, 'COUNTERED', '#7fc9a0');
      } else {
        this.hud.showFloatingText(420, 500, 'EVADED', DODGE_TEXT);
      }
      return;
    }

    const outcome = resolveDefense(
      {
        holdingBlock: this.holdingBlock,
        lastShieldPressAt: this.lastShieldPressAt,
        guardBroken: isGuardBroken(this.playerGuard, now),
      },
      now,
      PLAYER_BALANCE.counterWindowMs
    );

    switch (outcome) {
      case 'counter': {
        this.stats.perfectCounters += 1;
        playSfx(this, 'counter');
        this.tracker.recordCounter(now);
        this.gainPlayerBurst('perfectCounter');
        this.rig.counterFlash();
        this.hud.showMessage('PERFECT COUNTER!', '#4f8fdd');
        this.cameras.main.flash(90, 40, 40, 80);
        this.cameras.main.zoomTo(1.05, 80, 'Sine.easeOut', true);
        this.time.delayedCall(150, () => this.cameras.main.zoomTo(1, 140, 'Sine.easeIn', true));
        this.brain?.notifyCountered(now);
        this.applyEnemyGuardDamage(
          Math.round(
            attack.counterGuardDamage * modifiersForRun(this.run).counterGuardDamageMultiplier
          ),
          now
        );
        this.restorePlayerGuard(modifiersForRun(this.run).counterGuardRestore);
        break;
      }
      case 'block': {
        const leak = blockedDamage(
          attack.damage,
          PLAYER_BALANCE.blockDamageReduction *
            modifiersForRun(this.run).blockDamageReductionMultiplier
        );
        this.damagePlayer(
          leak + modifiersForRun(this.run).blockedHitSelfDamage,
          false
        );
        this.gainPlayerBurst('normalBlock');
        playSfx(this, 'player_block');
        this.cameras.main.shake(70, 0.003);
        spawnPaperFragments(this, 300, 620, 4, PAPER.guard);
        // Shield durability gets chewed up quickly: most foes shatter it in 2-3 blocks.
        const durabilityCost = blockedHitGuardCost(attack.damage, PLAYER_BALANCE);
        const result = applyGuardDamage(
          this.playerGuard,
          durabilityCost,
          now,
          PLAYER_BALANCE.shieldDestroyedUntilNextFightMs
        );
        this.playerGuard = result.meter;
        if (result.broke) this.onPlayerGuardBroken();
        if (
          modifiersForRun(this.run).failedCounterBreaksGuard &&
          !isGuardBroken(this.playerGuard, now)
        ) {
          this.breakPlayerGuard(now);
        }
        break;
      }
      case 'hit': {
        this.damagePlayer(attack.damage, true);
        break;
      }
    }
  }

  private onPlayerGuardBroken(): void {
    this.holdingBlock = false;
    this.lastShieldPressAt = null;
    this.rig.breakShield();
    playSfx(this, 'guard_break');
    this.hud.showMessage('SHIELD DESTROYED!', '#d94f3d');
    spawnPaperFragments(this, 300, 640, 14, PAPER.guard);
    this.cameras.main.shake(160, 0.008);
    const healing = modifiersForRun(this.run).secondWindHealing;
    if (!this.secondWindUsed && healing > 0 && this.mode !== 'over') {
      this.secondWindUsed = true;
      this.healPlayer(healing);
      this.hud.showMessage('SECOND WIND!', '#7fc9a0', 28);
    }
  }

  private restorePlayerGuard(amount: number): void {
    if (amount <= 0) return;
    this.playerGuard = {
      ...this.playerGuard,
      current: Math.min(this.playerGuard.max, this.playerGuard.current + amount),
    };
    this.hud.showFloatingText(350, 590, `+${amount} GUARD`, '#4f8fdd');
  }

  private breakPlayerGuard(now: number): void {
    const result = applyGuardDamage(
      this.playerGuard,
      this.playerGuard.current,
      now,
      PLAYER_BALANCE.shieldDestroyedUntilNextFightMs
    );
    this.playerGuard = result.meter;
    if (result.broke) this.onPlayerGuardBroken();
  }

  private damagePlayer(amount: number, fullHit: boolean): void {
    if (amount <= 0 || this.mode === 'over') return;
    this.playerHealth = Math.max(0, this.playerHealth - amount);
    this.stats.damageTaken += amount;
    if (fullHit) {
      playSfx(this, 'player_hit');
      playBaseHaptic(this, 'player_hit');
      damageVignette(this);
      this.cameras.main.shake(140, 0.006);
      this.hud.showFloatingText(420, 480, `-${amount}`, '#d94f3d');
    }
    if (this.playerHealth <= 0) this.handleDefeat();
  }

  // ------------------------------------------------------------------
  // Burst
  // ------------------------------------------------------------------

  private tryActivateBurst(): void {
    const now = this.time.now;
    if (this.mode !== 'fight' || this.burstActive || !this.brain || this.brain.isDead()) return;
    if (!canActivateBurst(this.playerBurst, PLAYER_BALANCE.burstMax)) return;

    // Bursting is an all-out attack — the shield drops for it.
    this.releaseShield();
    this.playerBurst = 0;
    const modifiers = modifiersForRun(this.run);
    if (modifiers.burstHealthCost > 0) {
      this.damagePlayer(modifiers.burstHealthCost, false);
      if (this.playerHealth <= 0) return;
    }
    this.burstActive = true;
    const weapon = weaponForRun(this.run);
    const burst = weapon.burst;
    const totalMs = 200 + burst.hits * burst.hitIntervalMs;
    this.brain.notifyBurstLock(now, totalMs + 200);
    this.hud.showMessage(burst.name.toUpperCase(), '#ffb347', 32);
    this.cameras.main.flash(120, 40, 40, 80);

    for (let i = 0; i < burst.hits; i++) {
      this.time.delayedCall(200 + i * burst.hitIntervalMs, () =>
        this.applyBurstHit(weapon.id, i)
      );
    }
    this.time.delayedCall(totalMs + 120, () => {
      this.burstActive = false;
    });
  }

  private applyBurstHit(weaponId: WeaponId, index: number): void {
    if (this.mode !== 'fight' || !this.brain || !this.enemyView || !this.def) return;
    if (this.brain.isDead()) return;
    const burst = weaponForRun({ ...this.run, weaponId }).burst;
    this.rig.playBurst(weaponId, index);

    const zones = this.enemyView.getHitZones();
    const target = zones.find((z) => z.id === (index % 2 === 0 ? 'torso' : 'head')) ?? zones[0];
    const center = target ? this.zoneCenter(target) : { x: ENEMY_POSITION.x, y: 460 };

    const angle = Math.random() * Math.PI;
    const reach = 130;
    drawSlashTrail(
      this,
      [
        { x: center.x - Math.cos(angle) * reach, y: center.y - Math.sin(angle) * reach },
        { x: center.x + Math.cos(angle) * reach, y: center.y + Math.sin(angle) * reach },
      ],
      false,
      true
    );

    const damage = Math.round(
      burst.damagePerHit * modifiersForRun(this.run).burstDamageMultiplier
    );
    this.enemyHealth = Math.max(0, this.enemyHealth - damage);
    this.stats.damageDealt += damage;
    this.applyEnemyGuardDamage(
      burst.breaksGuard ? this.enemyGuard.current : burst.guardDamagePerHit,
      this.time.now
    );
    this.enemyView.playHitReaction(target?.id ?? 'torso', false);
    playSfx(this, `hit_${weaponId}`);
    playBaseHaptic(this, 'enemy_hit');
    spawnPaperFragments(this, center.x, center.y, 5);
    this.hud.showFloatingText(center.x, center.y - 24, `-${damage}`, '#ffb347');
    this.cameras.main.shake(60, 0.003);

    if (this.enemyHealth <= 0) this.onEnemyFelled();
  }

  // ------------------------------------------------------------------
  // Run end: death or triumph
  // ------------------------------------------------------------------

  private handleDefeat(): void {
    if (this.mode === 'over') return;
    this.mode = 'over';
    this.holdingBlock = false;
    this.hud.showMessage(
      this.stage === 'rival' ? 'THE ECHO OVERCOMES YOU' : 'YOU HAVE FALLEN',
      '#d94f3d',
      46
    );
    this.cameras.main.shake(220, 0.01);
    const overlay = this.add.rectangle(640, 360, 1280, 720, 0x000000, 0).setDepth(85);
    this.tweens.add({ targets: overlay, fillAlpha: 0.55, duration: 700 });
    this.time.delayedCall(900, () => this.showEndPanel(false));
  }

  /** The Fallen King is down — the run is won in the throne room. */
  private handleTriumph(): void {
    if (this.mode === 'over') return;
    this.mode = 'over';
    this.holdingBlock = false;
    this.hud.showMessage(
      this.stage === 'rival' ? 'RIVAL AVENGED' : 'THE THRONE IS RECLAIMED',
      '#ffd75e',
      46
    );
    this.cameras.main.flash(300, 60, 50, 20);
    const overlay = this.add.rectangle(640, 360, 1280, 720, 0x000000, 0).setDepth(85);
    this.tweens.add({ targets: overlay, fillAlpha: 0.4, duration: 900 });
    this.time.delayedCall(1300, () => this.showEndPanel(true));
  }

  private showEndPanel(victory: boolean): void {
    const durationSec = Math.round((this.time.now - this.runStartAt) / 1000);
    const rivalFight = this.stage === 'rival' && this.fallenRival !== null;
    this.add.rectangle(640, 360, 1280, 720, 0x000000, 0.3).setDepth(90).setInteractive();

    const panel = this.add
      .rectangle(640, 360, 560, 470, PAPER.plate, 0.96)
      .setStrokeStyle(3, victory ? PAPER.counterCue : PAPER.rim)
      .setDepth(91);
    panel.setInteractive();
    this.add
      .text(
        640,
        208,
        victory
          ? rivalFight
            ? 'RIVAL AVENGED'
            : 'THE THRONE RECLAIMED'
          : rivalFight
            ? 'THE ECHO ENDURES'
            : 'THE ROAD CLAIMS YOU',
        {
        fontFamily: FONT,
        fontSize: '36px',
        fontStyle: 'bold',
        color: victory ? '#ffd75e' : '#d94f3d',
      })
      .setOrigin(0.5)
      .setDepth(92);

    const lines = [
      victory
        ? rivalFight
          ? `u/${this.fallenRival?.username}'s echo has been laid to rest.`
          : 'The Fallen King has fallen. The road is yours.'
        : '',
      `Foes felled: ${this.stats.foesFelled}`,
      `Damage dealt: ${this.stats.damageDealt}`,
      `Damage taken: ${this.stats.damageTaken}`,
      `Weak-point hits: ${this.stats.weakPointHits}`,
      `Perfect counters: ${this.stats.perfectCounters}`,
      `Dodge counters: ${this.stats.dodgeCounters}`,
      `Attacks evaded: ${this.stats.attacksEvaded}`,
      `The road held you for ${durationSec}s`,
    ].filter((line) => line !== '');
    this.add
      .text(640, 330, lines.join('\n'), {
        fontFamily: FONT,
        fontSize: '21px',
        color: PARCHMENT_TEXT,
        align: 'center',
        lineSpacing: 7,
      })
      .setOrigin(0.5)
      .setDepth(92);

    if (this.dailyRun) {
      const dailyScore = this.add
        .text(640, 457, 'SUBMITTING DAILY SCORE…', {
          fontFamily: FONT,
          fontSize: '15px',
          color: MUTED_TEXT,
        })
        .setOrigin(0.5)
        .setDepth(92);
      this.submitDailyScore(victory, durationSec, dailyScore);
    }
    if (rivalFight) {
      const rivalResult = this.add
        .text(640, 457, 'RECORDING THE REVENGE…', {
          fontFamily: FONT,
          fontSize: '15px',
          color: MUTED_TEXT,
        })
        .setOrigin(0.5)
        .setDepth(92);
      this.submitRivalResult(victory, rivalResult);
    }

    // Explicit data: Phaser keeps the previous scene data when none is
    // passed, which would otherwise respawn a fallen player in the castle.
    this.endButton(640, 512, 'NEW DAILY RUN', () => this.scene.start('Home'));
    this.endButton(640, 565, 'RETURN HOME', () => this.scene.start('Home'), true);
  }

  private submitDailyScore(
    victory: boolean,
    durationSec: number,
    label: Phaser.GameObjects.Text
  ): void {
    const dailyRun = this.dailyRun;
    if (!dailyRun) return;
    void (async () => {
      try {
        const payload = DailyRunSubmissionSchema.parse({
          runId: dailyRun.runId,
          outcome: victory ? 'victory' : 'defeat',
          durationSec,
          stats: this.stats,
          weaponId: this.run.weaponId,
          gambitIds: this.run.gambitIds,
        });
        const response = await fetch('/api/runs/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`Daily score error: ${response.status}`);
        const result = DailyRunCompletionResponseSchema.parse(await response.json());
        if (!label.active) return;
        label.setText(
          `DAILY SCORE ${result.score}  •  BEST ${result.bestScore}  •  RANK #${result.rank}`
        );
        label.setColor(result.personalBest ? '#ffd75e' : MUTED_TEXT);
      } catch {
        if (label.active) label.setText('DAILY SCORE COULD NOT BE SUBMITTED');
      }
    })();
  }

  private submitRivalResult(victory: boolean, label: Phaser.GameObjects.Text): void {
    const rival = this.fallenRival;
    if (!rival) return;
    void (async () => {
      try {
        const payload = FallenRivalAvengeSubmissionSchema.parse({
          rivalId: rival.id,
          outcome: victory ? 'victory' : 'defeat',
        });
        const response = await fetch('/api/rivals/avenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`Rival result error: ${response.status}`);
        const result = FallenRivalAvengeResponseSchema.parse(await response.json());
        if (!label.active) return;
        label.setText(
          victory
            ? `REVENGE RECORDED — ${result.avenges} ${result.avenges === 1 ? 'TRAVELLER HAS' : 'TRAVELLERS HAVE'} AVENGED THIS ECHO`
            : 'THE RIVAL STILL WALKS THE ROAD'
        );
        label.setColor(victory ? '#ffd75e' : MUTED_TEXT);
      } catch {
        if (label.active) label.setText('REVENGE COULD NOT BE RECORDED');
      }
    })();
  }

  private endButton(x: number, y: number, label: string, onClick: () => void, minor = false): void {
    const button = this.add
      .rectangle(x, y, minor ? 300 : 360, minor ? 42 : 54, minor ? PAPER.plate : PAPER.cardboard)
      .setStrokeStyle(2.5, minor ? PAPER.rim : PAPER.burst, 0.9)
      .setDepth(92)
      .setInteractive({ useHandCursor: true });
    const text = this.add
      .text(x, y, label, {
        fontFamily: FONT,
        fontSize: minor ? '17px' : '22px',
        fontStyle: 'bold',
        color: PARCHMENT_TEXT,
      })
      .setOrigin(0.5)
      .setDepth(93);
    button.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OVER, () =>
      button.setStrokeStyle(2.5, PAPER.counterCue, 1)
    );
    button.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OUT, () =>
      button.setStrokeStyle(2.5, minor ? PAPER.rim : PAPER.burst, 0.9)
    );
    button.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => {
      text.setScale(0.95);
      playSfx(this, 'ui_tap');
      onClick();
    });
  }
}
