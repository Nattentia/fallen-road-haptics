import {
  StreamCoalescer,
  type ChainStep,
  type Signal,
} from '../../shared/haptics/signals';

/** Fired on `game.events` for every signal to the haptic upscaler. */
export const SIGNAL_EVENT = 'hsSignal';

/** What the bus needs from the game: its event emitter. */
export type SignalSink = {
  events: { emit: (event: string, signal: Signal) => unknown };
};

/**
 * Hands game signals to the haptic upscaler. It thins out fast stream
 * updates, drops gauge reports that did not change, and numbers chains.
 */
export class SignalBus {
  private readonly streams = new StreamCoalescer();
  private readonly gauges = new Map<string, number>();
  private chainSeq = 0;

  constructor(private readonly game: SignalSink) {}

  /** A new chain id; `label` only makes logs readable. */
  openChain(label: string): string {
    this.chainSeq += 1;
    return `${label}-${this.chainSeq}`;
  }

  emit(signal: Signal): void {
    if (signal.kind === 'stream' && !this.streams.accept(signal)) return;
    if (signal.kind === 'gauge') {
      const prev = this.gauges.get(signal.id);
      if (prev !== undefined && Math.abs(prev - signal.value) < 0.005) return;
      this.gauges.set(signal.id, signal.value);
    }
    this.game.events.emit(SIGNAL_EVENT, signal);
  }
}

export const chainRef = (id: string | null, step: ChainStep) =>
  id === null ? {} : { chain: { id, step } };
