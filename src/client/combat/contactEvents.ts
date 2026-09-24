import type { ContactEvent } from '../../shared/combat/contacts';

/** Fired on `game.events` for every blade-contact step — the haptics tap point. */
export const CONTACT_EVENT = 'contact';

export type ContactSignal = ContactEvent & {
  /** DOM timestamp of the pointer event that produced it (performance.now clock). */
  inputTs: number;
  /** performance.now() when the signal was emitted. */
  emitTs: number;
};
