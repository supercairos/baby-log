/**
 * Outbox — the durable, offline-first write buffer (IndexedDB).
 *
 * Three stores:
 *  - `mutations`  : the FIFO queue of pending writes (keyPath `seq`, auto-increment).
 *  - `timerMap`   : `localId` → server timer id + start metadata, so a stop queued later
 *                   (or replayed by the worker) can resolve the timer it belongs to.
 *  - `connection` : the persisted `Connection` (single row), so the SERVICE WORKER can
 *                   build a client and flush without the page — it can't read localStorage.
 *
 * IndexedDB is available in both window and worker scopes, which is exactly why the
 * outbox lives here and not in localStorage.
 */
import type { Mutation, LocalId } from "./mutations";
import type { TimerActivityKey, FeedingType, FeedingMethod } from "./activities";
import type { Connection } from "./connection";
import { emitOutboxChange } from "./outbox-events";

const DB_NAME = "baby-log";
const DB_VERSION = 2;
const STORE_MUTATIONS = "mutations";
const STORE_TIMER_MAP = "timerMap";
const STORE_CONNECTION = "connection";
const STORE_META = "meta";
const CONNECTION_KEY = "current";
const FLUSH_LOCK_KEY = "flushLock";

/** A queued mutation plus its retry bookkeeping. */
export interface OutboxRecord {
  /** Auto-increment sequence — the queue's FIFO order. Assigned by IndexedDB. */
  seq?: number;
  mutation: Mutation;
  attempts: number;
  /** Epoch ms; the record is eligible to run once `Date.now() >= nextAttemptAt`. */
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
  /** Set once the write has permanently failed (non-retryable 4xx or max attempts). */
  dead?: boolean;
}

/**
 * Local↔server identity of a started timer. `startedAt` is recorded as soon as the start
 * is processed (so a later/replayed stop keeps the true start time); `serverId` is filled
 * in once the timer is actually created on the server, and stays `undefined` when the
 * start+stop were coalesced offline into a single direct entry create.
 */
export interface TimerMapping {
  localId: LocalId;
  serverId?: number;
  startedAt: string;
  activity: TimerActivityKey;
  childId: number;
  /** In-progress feeding refinement, applied to the running feeding timer (persisted). */
  feeding?: { type?: FeedingType | null; method?: FeedingMethod | null; amount?: number | null };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable in this environment"));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MUTATIONS)) {
          db.createObjectStore(STORE_MUTATIONS, { keyPath: "seq", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(STORE_TIMER_MAP)) {
          db.createObjectStore(STORE_TIMER_MAP, { keyPath: "localId" });
        }
        if (!db.objectStoreNames.contains(STORE_CONNECTION)) {
          db.createObjectStore(STORE_CONNECTION);
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/**
 * Run one request in a transaction and resolve on COMMIT (`oncomplete`), not on request
 * success. A request can succeed while the transaction later aborts at commit (quota,
 * forced close); resolving on `oncomplete` means a write only "succeeds" once it's durably
 * persisted — so enqueue can't report a phantom seq and removeRecord can't drop a record
 * that then resurrects.
 */
async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await getDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    let value: T;
    request.onsuccess = () => {
      value = request.result;
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = () => reject(transaction.error ?? request.error);
    transaction.onerror = () => reject(transaction.error ?? request.error);
  });
}

// ── Mutations queue ────────────────────────────────────────────────────────────

/** Append a mutation to the queue, eligible to run immediately. */
export async function enqueue(mutation: Mutation): Promise<number> {
  const record: OutboxRecord = {
    mutation,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  };
  const seq = await tx<number>(STORE_MUTATIONS, "readwrite", (s) => s.add(record) as IDBRequest<number>);
  emitOutboxChange();
  return seq;
}

/** All queued records in FIFO (seq) order. */
export async function allRecords(): Promise<OutboxRecord[]> {
  const records = await tx<OutboxRecord[]>(STORE_MUTATIONS, "readonly", (s) => s.getAll() as IDBRequest<OutboxRecord[]>);
  return records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function pendingCount(): Promise<number> {
  return tx<number>(STORE_MUTATIONS, "readonly", (s) => s.count() as IDBRequest<number>);
}

export async function removeRecord(seq: number): Promise<void> {
  await tx<undefined>(STORE_MUTATIONS, "readwrite", (s) => s.delete(seq) as IDBRequest<undefined>);
  emitOutboxChange(); // enqueue + remove are the only two places the pending count moves
}

export async function updateRecord(record: OutboxRecord): Promise<void> {
  await tx<IDBValidKey>(STORE_MUTATIONS, "readwrite", (s) => s.put(record) as IDBRequest<IDBValidKey>);
}

// ── localId → server timer id mapping ────────────────────────────────────────

export async function setTimerMapping(mapping: TimerMapping): Promise<void> {
  await tx<IDBValidKey>(STORE_TIMER_MAP, "readwrite", (s) => s.put(mapping) as IDBRequest<IDBValidKey>);
}

export async function getTimerMapping(localId: LocalId): Promise<TimerMapping | undefined> {
  return tx<TimerMapping | undefined>(STORE_TIMER_MAP, "readonly", (s) => s.get(localId) as IDBRequest<TimerMapping | undefined>);
}

/** All known timer mappings (used to render optimistic running timers). */
export async function allTimerMappings(): Promise<TimerMapping[]> {
  return tx<TimerMapping[]>(STORE_TIMER_MAP, "readonly", (s) => s.getAll() as IDBRequest<TimerMapping[]>);
}

/** Read-merge-write a mapping (e.g. refine the running feeding's type/method) without
 *  clobbering a `serverId` the flusher may have just written. No-op if it's gone. */
export async function mergeTimerMapping(localId: LocalId, patch: Partial<TimerMapping>): Promise<void> {
  const existing = await getTimerMapping(localId);
  if (!existing) return;
  await setTimerMapping({ ...existing, ...patch, localId });
}

export async function deleteTimerMapping(localId: LocalId): Promise<void> {
  await tx<undefined>(STORE_TIMER_MAP, "readwrite", (s) => s.delete(localId) as IDBRequest<undefined>);
}

// ── Persisted connection (shared with the service worker) ────────────────────

export async function saveConnection(conn: Connection): Promise<void> {
  await tx<IDBValidKey>(STORE_CONNECTION, "readwrite", (s) => s.put(conn, CONNECTION_KEY) as IDBRequest<IDBValidKey>);
}

export async function loadConnection(): Promise<Connection | undefined> {
  return tx<Connection | undefined>(STORE_CONNECTION, "readonly", (s) => s.get(CONNECTION_KEY) as IDBRequest<Connection | undefined>);
}

export async function clearConnection(): Promise<void> {
  await tx<undefined>(STORE_CONNECTION, "readwrite", (s) => s.delete(CONNECTION_KEY) as IDBRequest<undefined>);
}

// ── Cross-realm flush lock ───────────────────────────────────────────────────
// The page and the service worker are separate JS realms; an in-memory flag can't
// coordinate them. This read-then-conditional-write happens in ONE readwrite transaction,
// and IndexedDB serializes transactions across realms — so only one drainer holds the lock
// at a time. A TTL lets a crashed holder's lock expire.

interface FlushLock {
  expiresAt: number;
  owner: string;
}

/** Try to claim the flush lock for `ttlMs`. Returns an owner token, or null if held. */
export async function acquireFlushLock(ttlMs: number): Promise<string | null> {
  const db = await getDb();
  const owner = crypto.randomUUID();
  return new Promise<string | null>((resolve, reject) => {
    const transaction = db.transaction(STORE_META, "readwrite");
    const store = transaction.objectStore(STORE_META);
    const getReq = store.get(FLUSH_LOCK_KEY);
    let acquired = false;
    getReq.onsuccess = () => {
      const lock = getReq.result as FlushLock | undefined;
      const now = Date.now();
      if (!lock || lock.expiresAt <= now) {
        store.put({ expiresAt: now + ttlMs, owner } satisfies FlushLock, FLUSH_LOCK_KEY);
        acquired = true;
      }
    };
    transaction.oncomplete = () => resolve(acquired ? owner : null);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Release the lock only if we still own it (a TTL-expired lock may have been re-taken). */
export async function releaseFlushLock(owner: string): Promise<void> {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_META, "readwrite");
    const store = transaction.objectStore(STORE_META);
    const getReq = store.get(FLUSH_LOCK_KEY);
    getReq.onsuccess = () => {
      const lock = getReq.result as FlushLock | undefined;
      if (lock && lock.owner === owner) store.delete(FLUSH_LOCK_KEY);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
