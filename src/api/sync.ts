/**
 * Sync — the worker-side flush engine that drains the outbox against the server.
 *
 * Runs the same way on the main thread (on `online`/focus/interval) and inside the
 * service worker (on Background Sync). It:
 *  - processes the queue in FIFO order;
 *  - resolves the create→consume timer dependency via `localId`, and COALESCES a
 *    start+stop that are both still queued (a fully-offline activity) into one direct
 *    entry create — no transient timer ever hits the server;
 *  - retries with exponential backoff + jitter, never head-of-line-blocking independent
 *    writes (a stuck feeding won't hold up a diaper), and dead-letters writes that can't
 *    succeed (non-retryable 4xx, or too many attempts) instead of retrying forever;
 *  - treats "timer already consumed/deleted" (the multi-caregiver race) and 404s as
 *    success — the activity was already logged.
 *
 * Concurrency: the page and the service worker are separate realms, so a process-local
 * flag can't serialize them. We take a cross-realm flush lock in IndexedDB (`outbox.ts`)
 * so only one drainer runs at a time — without it, Background Sync firing while the page
 * is flushing would double-POST.
 *
 * Delivery is at-least-once. ONLY the server-timer consume path self-heals a lost-response
 * duplicate (the retry hits the gone timer → TimerAlreadyConsumedError → success). The
 * coalesced offline create + every diaper/manual create carry no idempotency key, so a
 * network drop after the server commits but before we see the response can leave a
 * duplicate, fixed via timeline edit. See README.
 */
import type { BabyBuddyClient } from "./client";
import {
  allRecords,
  removeRecord,
  updateRecord,
  setTimerMapping,
  getTimerMapping,
  mergeTimerMapping,
  deleteTimerMapping,
  acquireFlushLock,
  releaseFlushLock,
  pendingCount,
  type OutboxRecord,
} from "./outbox";
import type { Mutation, LocalId } from "./mutations";
import { BabyBuddyApiError, TimerAlreadyConsumedError, describeApiError } from "./errors";
import { emitOutboxError } from "./outbox-events";
import { startTimer, discardTimer } from "./timers";
import {
  consumeFeedingTimer,
  consumeSleepTimer,
  consumeTummyTimer,
  createFeeding,
  createSleep,
  createTummyTime,
  logDiaperChange,
  updateEntry,
  deleteEntry,
} from "./entries";

/** Background Sync registration tag (used by the service worker). */
export const OUTBOX_SYNC_TAG = "baby-log-outbox";

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;
const FLUSH_LOCK_TTL_MS = 60_000;

export interface FlushSummary {
  executed: number;
  failed: number;
  /** Records dead-lettered this run (permanently failed). */
  deadLettered: number;
  /** Records still queued (not-yet-ready, blocked, or held by another drainer). */
  remaining: number;
}

// Short, command-kind-based action label for a failed-write toast. Kept local (a tiny switch
// on `m.kind`) rather than importing `mutationLabel` from "./mutations" — that value import
// would create a `sync ↔ mutations` runtime cycle.
function actionLabel(kind: Mutation["kind"]): string {
  if (kind === "start-timer") return "Starting the timer";
  if (kind.startsWith("consume")) return "Saving the activity";
  if (kind.startsWith("create")) return "Adding the entry";
  if (kind === "log-diaper") return "Logging the diaper";
  if (kind === "update-entry") return "Saving the change";
  if (kind === "delete-entry") return "Deleting the entry";
  return "Saving";
}

let running: Promise<FlushSummary> | null = null;

/**
 * Drain the outbox once. Two layers of mutual exclusion: a process-local promise (so the
 * page's interval/online/focus handlers coalesce into one run) AND a cross-realm
 * IndexedDB lock (so the page and the service worker never drain at the same time).
 */
export function flushOutbox(client: BabyBuddyClient): Promise<FlushSummary> {
  if (running) return running;
  running = (async () => {
    const lockOwner = await acquireFlushLock(FLUSH_LOCK_TTL_MS);
    if (!lockOwner) {
      // Another realm (page or SW) owns the drain right now.
      return { executed: 0, failed: 0, deadLettered: 0, remaining: await pendingCount() };
    }
    try {
      return await drain(client);
    } finally {
      await releaseFlushLock(lockOwner);
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

function backoffMs(attempts: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return base / 2 + Math.random() * (base / 2); // 50–100% jitter
}

/**
 * Pre-scan (order-independent): for each started timer, is its stop/discard ALSO queued?
 * Collected in two passes so a consume that landed with a lower seq than its start (rapid
 * taps / un-awaited enqueue) is still detected and coalesced.
 */
function coalesceDecisions(records: OutboxRecord[]): Map<LocalId, "consume" | "discard"> {
  const starts = new Set<LocalId>();
  const stops = new Map<LocalId, "consume" | "discard">();
  for (const { mutation: m } of records) {
    if (m.kind === "start-timer") starts.add(m.localId);
    else if (m.kind === "discard-timer") stops.set(m.localId, "discard");
    else if (m.kind === "consume-feeding" || m.kind === "consume-sleep" || m.kind === "consume-tummy") {
      if (!stops.has(m.localId)) stops.set(m.localId, "consume");
    }
  }
  const decisions = new Map<LocalId, "consume" | "discard">();
  for (const localId of starts) {
    const stop = stops.get(localId);
    if (stop) decisions.set(localId, stop);
  }
  return decisions;
}

async function drain(client: BabyBuddyClient): Promise<FlushSummary> {
  const records = (await allRecords()).filter((r) => !r.dead);
  const coalesce = coalesceDecisions(records);
  // localIds with a start-timer record still queued (not yet executed this pass). A
  // consume/discard must wait until its start runs first — regardless of seq order.
  const unprocessedStarts = new Set<LocalId>();
  for (const { mutation: m } of records) if (m.kind === "start-timer") unprocessedStarts.add(m.localId);

  const now = Date.now();
  const blocked = new Set<LocalId>(); // localIds whose start failed this pass
  let executed = 0;
  let failed = 0;
  let deadLettered = 0;
  let remaining = 0;

  for (const record of records) {
    const m = record.mutation;
    const localId = "localId" in m ? m.localId : undefined;
    const isStart = m.kind === "start-timer";

    if (record.nextAttemptAt > now) {
      if (isStart && localId) blocked.add(localId);
      remaining++;
      continue;
    }
    // A stop/discard can't run before its start has been processed.
    if (!isStart && localId && (blocked.has(localId) || unprocessedStarts.has(localId))) {
      remaining++;
      continue;
    }

    try {
      await executeRecord(client, m, coalesce);
      if (record.seq !== undefined) await removeRecord(record.seq);
      if (isStart && localId) unprocessedStarts.delete(localId);
      executed++;
    } catch (err) {
      const attempts = record.attempts + 1;
      const status = err instanceof BabyBuddyApiError ? err.status : 0;
      // Client errors (except the already-handled timer-gone race) won't self-heal.
      const permanent = (status >= 400 && status < 500) || attempts >= MAX_ATTEMPTS;
      await updateRecord({
        ...record,
        attempts,
        nextAttemptAt: permanent ? record.nextAttemptAt : now + backoffMs(attempts),
        lastError: err instanceof Error ? err.message : String(err),
        dead: permanent || undefined,
      });
      if (permanent) {
        // Tell the UI this write will never land (e.g. a rejected field) — it's not retrying.
        emitOutboxError(`${actionLabel(m.kind)} failed — ${describeApiError(err)}`);
        // Dead-letter the start. If a stop is also queued (coalesce), keep the mapping so the
        // stop can still direct-create the entry from startedAt. If it's a LONE start (no
        // queued stop), drop the mapping so it doesn't leave a phantom running card ticking
        // forever for a timer the server never created.
        if (isStart && localId) {
          unprocessedStarts.delete(localId);
          if (!coalesce.has(localId)) await deleteTimerMapping(localId);
        }
        deadLettered++;
      } else {
        if (isStart && localId) blocked.add(localId);
        failed++;
      }
      remaining++;
    }
  }

  return { executed, failed, deadLettered, remaining };
}

async function executeRecord(
  client: BabyBuddyClient,
  m: Mutation,
  coalesce: Map<LocalId, "consume" | "discard">,
): Promise<void> {
  switch (m.kind) {
    case "start-timer": {
      // Record start metadata first, so a replayed/late stop keeps the true start time.
      // Preserve any `feeding` refinement already on the mapping (and any concurrent refine).
      const existing = await getTimerMapping(m.localId);
      await setTimerMapping({
        localId: m.localId,
        startedAt: m.startedAt,
        activity: m.activity,
        childId: m.childId,
        feeding: existing?.feeding,
      });
      const decision = coalesce.get(m.localId);
      if (decision === "discard") {
        await deleteTimerMapping(m.localId); // started + discarded offline → nothing happened
        return;
      }
      if (decision === "consume") return; // coalesced: the stop will direct-create the entry
      const timer = await startTimer(client, m.activity, m.childId, m.startedAt);
      await mergeTimerMapping(m.localId, { serverId: timer.id }); // merge, don't clobber feeding
      return;
    }

    case "consume-feeding":
      return resolveStop(
        m.localId,
        m.childId,
        m.endedAt,
        (id) => consumeFeedingTimer(client, id, m.fields),
        (childId, start, end) => createFeeding(client, childId, start, end, m.fields),
      );

    case "consume-sleep":
      return resolveStop(
        m.localId,
        m.childId,
        m.endedAt,
        (id) => consumeSleepTimer(client, id, m.fields),
        (childId, start, end) => createSleep(client, childId, start, end, m.fields),
      );

    case "consume-tummy":
      return resolveStop(
        m.localId,
        m.childId,
        m.endedAt,
        (id) => consumeTummyTimer(client, id, m.fields),
        (childId, start, end) => createTummyTime(client, childId, start, end, m.fields),
      );

    case "discard-timer": {
      const mapping = await getTimerMapping(m.localId);
      if (mapping?.serverId != null) await discardTimer(client, mapping.serverId);
      await deleteTimerMapping(m.localId);
      return;
    }

    case "log-diaper":
      await logDiaperChange(client, m.childId, m.fields);
      return;

    case "create-feeding":
      await createFeeding(client, m.childId, m.start, m.end, m.fields);
      return;
    case "create-sleep":
      await createSleep(client, m.childId, m.start, m.end, m.fields);
      return;
    case "create-tummy":
      await createTummyTime(client, m.childId, m.start, m.end, m.fields);
      return;

    case "update-entry":
      await updateEntry(client, m.serverId, m.patch);
      return;
    case "delete-entry":
      await deleteEntry(client, m.path, m.serverId);
      return;
  }
}

/**
 * Resolve a stop: consume the real server timer if one exists, else (start was coalesced
 * offline, or its server id was never recorded) direct-create the entry from the recorded
 * start time. The multi-caregiver race (timer already gone) counts as success.
 */
async function resolveStop(
  localId: LocalId,
  childId: number,
  endedAt: string,
  consumeServer: (serverTimerId: number) => Promise<unknown>,
  directCreate: (childId: number, start: string, end: string) => Promise<unknown>,
): Promise<void> {
  const mapping = await getTimerMapping(localId);
  if (mapping?.serverId != null) {
    try {
      await consumeServer(mapping.serverId);
    } catch (err) {
      if (!(err instanceof TimerAlreadyConsumedError)) throw err;
      // Another device already logged it — nothing to do.
    }
    await deleteTimerMapping(localId);
    return;
  }
  if (!mapping?.startedAt) {
    // No server timer AND no recorded start: the start hasn't been processed yet, or its
    // mapping was lost. Refuse to fabricate a zero-duration entry — throw so the record
    // backs off (and eventually surfaces) instead of writing garbage to the timeline.
    throw new Error(`No start time for timer ${localId}; deferring stop`);
  }
  await directCreate(childId, mapping.startedAt, endedAt);
  await deleteTimerMapping(localId);
}

/**
 * Wire automatic flushing on the main thread: when connectivity returns, when the tab
 * regains focus, and on a gentle interval (matching the multi-caregiver poll cadence).
 * Returns a teardown function. No-op outside a browser window.
 */
export function startOutboxAutoFlush(client: BabyBuddyClient, intervalMs = 45_000): () => void {
  if (typeof window === "undefined") return () => {};
  const flush = () => void flushOutbox(client).catch(() => {});
  const onVisible = () => {
    if (document.visibilityState === "visible") flush();
  };
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(flush, intervalMs);
  flush(); // drain anything left from a previous session
  return () => {
    window.removeEventListener("online", flush);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}

/** Register the outbox service worker (main thread). No-op without SW support. */
export async function registerOutboxServiceWorker(scriptUrl = "/service-worker.js"): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register(scriptUrl, { type: "module" });
}

/**
 * Ask the browser to drain the outbox via Background Sync — it fires even after the tab
 * closes, once connectivity returns. Returns false when Background Sync is unavailable
 * (e.g. Safari), in which case `startOutboxAutoFlush` is the fallback. Call after enqueue.
 */
export async function requestOutboxSync(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  const reg = await navigator.serviceWorker.ready;
  const sync = (reg as unknown as { sync?: { register(tag: string): Promise<void> } }).sync;
  if (!sync) return false;
  try {
    await sync.register(OUTBOX_SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}
