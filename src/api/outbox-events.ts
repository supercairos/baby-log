/**
 * Tiny event bus for permanently-failed outbox writes, so the UI can toast them.
 *
 * This lives in its OWN leaf module (it imports nothing from the API graph) on purpose: the
 * listener registry is shared module state, and if it lived in `sync.ts` — which is part of a
 * `sync ↔ mutations` import cycle — the bundler can instantiate that module twice, leaving the
 * emitter and the subscriber holding two different Sets (the emit then reaches no listener).
 * A dependency-free leaf module is always a single instance, so emit and subscribe agree.
 */
type OutboxErrorListener = (message: string) => void;
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

export function emitOutboxError(message: string): void {
  for (const fn of listeners) fn(message);
}
