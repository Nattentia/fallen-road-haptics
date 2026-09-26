import type { Signal } from '../haptics/signals';
import {
  BASE_GAIN_MAX,
  BASE_GAIN_MIN,
  type BaseVibration,
  type Command,
  type Hint,
  type SoundFeatures,
  type UpscalerEngine,
  type UpscalerStep,
  validateCommand,
} from './contract';

/** What a failed step falls back to: the base alone, never nothing. */
const BASE_ONLY: UpscalerStep = { baseGain: 1, commands: [] };

/**
 * Sits between the game and the native player. It hands each signal to the
 * upscaler and sends the resulting commands, and it pairs every base
 * vibration with the signal that names it so both leave in one message and
 * the upscaler can set the base's gain. The game emits a base and its signal
 * a few statements apart, in either order; whatever is still unpaired when
 * the current task ends is sent on its own.
 */
export class UpscalerLink {
  private bases: string[] = [];
  private waiting: Signal[] = [];
  private flushQueued = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt = Infinity;

  constructor(
    private readonly engine: UpscalerEngine,
    private readonly send: (commands: Command[]) => void,
    private readonly now: () => number = () => performance.now(),
    private readonly report: (problem: string) => void = (p) =>
      console.warn(`[upscaler] ${p}`)
  ) {}

  /**
   * Runs an engine call so that nothing it throws reaches the game, and the
   * paired base vibration still plays (fallback: base only).
   */
  private guarded(call: () => UpscalerStep): UpscalerStep {
    try {
      return call();
    } catch (error) {
      this.report(`engine failed: ${String(error)}`);
      return BASE_ONLY;
    }
  }

  define(bases: readonly BaseVibration[]): void {
    this.send(this.engine.define(bases));
  }

  defineSounds(sounds: Readonly<Record<string, SoundFeatures>>): void {
    try {
      this.engine.defineSounds(sounds);
    } catch (error) {
      this.report(`sound features rejected: ${String(error)}`);
    }
  }

  /** The game played its base vibration `name`. */
  base(name: string): void {
    const i = this.waiting.findIndex(
      (s) => s.kind === 'event' && s.base === name
    );
    if (i >= 0) {
      const [signal] = this.waiting.splice(i, 1);
      if (signal) this.run(signal, name);
      return;
    }
    this.bases.push(name);
    this.queueFlush();
  }

  signal(signal: Signal): void {
    const name = signal.kind === 'event' ? signal.base : undefined;
    if (name === undefined) {
      this.run(signal, null);
      return;
    }
    const i = this.bases.indexOf(name);
    if (i >= 0) {
      this.bases.splice(i, 1);
      this.run(signal, name);
      return;
    }
    this.waiting.push(signal);
    this.queueFlush();
  }

  hint(hint: Hint): void {
    this.deliver(
      this.guarded(() => this.engine.hint(hint, this.now())),
      null
    );
  }

  private run(signal: Signal, base: string | null): void {
    const now = this.now();
    const step = this.guarded(() =>
      this.engine.consume(signal, {
        now,
        gameToJs: now - signal.t,
        paired: base !== null,
      })
    );
    this.deliver(step, base);
  }

  private deliver(step: UpscalerStep, base: string | null): void {
    const commands: Command[] = [];
    if (base !== null)
      commands.push({
        op: 'base',
        name: base,
        at: this.now(),
        gain: Math.min(BASE_GAIN_MAX, Math.max(BASE_GAIN_MIN, step.baseGain)),
      });
    // A command the contract rejects (a NaN from a game value, say) is
    // dropped here rather than sent to the player.
    for (const c of step.commands) {
      const issues = validateCommand(c);
      if (issues.length === 0) commands.push(c);
      else this.report(`dropped ${c.op}: ${issues.join('; ')}`);
    }
    if (commands.length > 0) this.send(commands);
    if (step.wakeAt !== undefined) this.scheduleWake(step.wakeAt);
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const bases = this.bases;
      const waiting = this.waiting;
      this.bases = [];
      this.waiting = [];
      for (const name of bases)
        this.send([{ op: 'base', name, at: this.now(), gain: 1 }]);
      for (const signal of waiting) this.run(signal, null);
    });
  }

  private scheduleWake(at: number): void {
    if (at >= this.wakeAt) return;
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.wakeAt = Infinity;
        this.deliver(
          this.guarded(() => this.engine.wake(this.now())),
          null
        );
      },
      Math.max(0, at - this.now())
    );
  }
}
