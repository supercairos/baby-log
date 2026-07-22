/**
 * Tiny event bus for permanently-failed outbox writes, so the UI can toast them.
 *
 * This lives in its OWN leaf module (it imports nothing from the API graph) on purpose: the
 * listener registry is shared module state, and if it lived in `sync.ts` — which is part of a
 * `sync ↔ mutations` import cycle — the bundler can instantiate that module twice, leaving the
 * emitter and the subscriber holding two different Sets (the emit then reaches no listener).
 * A dependency-free leaf module is always a single instance, so emit and subscribe agree.
 */
/**
 * A permanently-failed write, described structurally (not as a built string) so the message
 * stays i18n-free here — this module is reachable from the service-worker bundle. The UI
 * (which has the translator) formats it into a toast.
 */
export interface OutboxFailure {
  /** The mutation kind that failed (e.g. "start-timer", "consume-feeding"). */
  actionKind: string;
  /** HTTP status (0 = network / unknown). */
  status: number;
  /** Raw server message if any (already in the instance's language); else null. */
  detail: string | null;
}

type OutboxErrorListener = (failure: OutboxFailure) => void;
const listeners = new Set<OutboxErrorListener>();

/**
 * Subscribe to permanently-failed writes (a non-retryable 4xx or exhausted retries). Transient
 * / offline failures are NOT reported — they retry silently. Returns an unsubscribe. Only fires
 * in the realm that runs the drain (the page).
 */
export function onOutboxError(listener: OutboxErrorListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitOutboxError(failure: OutboxFailure): void {
  for (const fn of listeners) fn(failure);
}

type OutboxChangeListener = () => void;
const changeListeners = new Set<OutboxChangeListener>();

/**
 * Subscribe to queue-size changes (a mutation enqueued, or a record drained/dropped) so the UI
 * can re-read `pendingCount()` instead of polling IndexedDB. Carries no payload — the count is
 * re-derived from the store. Same single-realm caveat as above: an SW-side drain emits into the
 * worker only; the page catches up on its own flush (interval/online/focus).
 */
export function onOutboxChange(listener: OutboxChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function emitOutboxChange(): void {
  for (const fn of changeListeners) fn();
}
