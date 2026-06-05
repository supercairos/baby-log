/**
 * Service worker — two jobs:
 *  1. Offline app shell. Precache the document + manifest on install; serve navigations
 *     network-first (falling back to the cached shell) and same-origin static assets
 *     stale-while-revalidate. API calls (`/api/…`) are never cached — reads go to the
 *     network and writes are handled by the outbox.
 *  2. Drain the outbox in the background — on Background Sync (`OUTBOX_SYNC_TAG`, fires even
 *     after the tab closes once back online) and on a `{ type: "flush" }` postMessage. It
 *     reads the persisted Connection from IndexedDB (the SW can't see localStorage).
 *
 * Built by vite-plugin-pwa (injectManifest) and served at the root so it controls the whole
 * app. Typed against the DOM lib via a small scope shim so it shares the app's tsconfig.
 */
import { createBabyBuddyClient } from "./client";
import { allRecords, allTimerMappings, enqueue, loadConnection, setTimerMapping } from "./outbox";
import { flushOutbox, OUTBOX_SYNC_TAG } from "./sync";
import { consumeTimerMutation } from "./mutations";
import { METHODS_FOR_TYPE, type FeedingMethod, type FeedingType, type TimerActivityKey } from "./activities";

const CACHE = "baby-log-shell-v1";
// Base path the app is served under ("/" or e.g. "/quick-ui/"); the SW scope matches it.
const BASE = import.meta.env.BASE_URL;
const PRECACHE = [BASE, `${BASE}manifest.webmanifest`];

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface SyncEventLike extends ExtendableEventLike {
  readonly tag: string;
}
interface MessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
}
interface SwNotification {
  readonly data: unknown;
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly icon: string;
  readonly badge: string;
  close(): void;
}
interface NotificationClickEventLike extends ExtendableEventLike {
  readonly action: string;
  readonly notification: SwNotification;
}
interface NotificationCloseEventLike extends ExtendableEventLike {
  readonly notification: SwNotification;
}
interface WindowClientLike {
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
interface ServiceWorkerScope {
  skipWaiting(): Promise<void>;
  readonly registration: {
    showNotification(title: string, options?: Record<string, unknown>): Promise<void>;
  };
  readonly clients: {
    claim(): Promise<void>;
    matchAll(opts?: { type?: string }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  readonly location: { origin: string };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "sync", listener: (event: SyncEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationClickEventLike) => void): void;
  addEventListener(type: "notificationclose", listener: (event: NotificationCloseEventLike) => void): void;
}

const sw = self as unknown as ServiceWorkerScope;

/** Shape of `notification.data` for a running-timer notification (set by the page). */
interface TimerNotifData {
  kind: "timer";
  activity: TimerActivityKey;
  childId: number;
  localId?: string;
  serverId?: number;
  startedAt: string;
  feeding?: { type?: FeedingType | null; method?: FeedingMethod | null };
}

// ── outbox flush ────────────────────────────────────────────────────────────
async function flush(): Promise<void> {
  const conn = await loadConnection();
  if (!conn) return; // not logged in — nothing to flush
  await flushOutbox(createBabyBuddyClient(conn));
}

// ── caching strategies ───────────────────────────────────────────────────────
async function networkFirstShell(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE);
    return (await cache.match(BASE)) ?? Response.error();
  }
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) void cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached ?? Response.error());
  return cached ?? network;
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
sw.addEventListener("install", (event) => {
  // No skipWaiting here: a new worker waits until the page tells it to activate (the
  // "tap to refresh" prompt → SKIP_WAITING message), so we never reload mid-interaction.
  // (First install has no controller to wait behind, so it activates immediately anyway.)
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // mutations are never cached
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return; // cross-origin → passthrough
  if (url.pathname.startsWith("/api/")) return; // API is network-only
  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

sw.addEventListener("sync", (event) => {
  if (event.tag === OUTBOX_SYNC_TAG) event.waitUntil(flush());
});

sw.addEventListener("message", (event) => {
  const type = typeof event.data === "object" && event.data !== null ? (event.data as { type?: unknown }).type : undefined;
  if (type === "flush") event.waitUntil(flush());
  // The "tap to refresh" prompt asks the waiting worker to take over now; activating it fires
  // `controllerchange` on the page, which reloads onto the new version.
  if (type === "SKIP_WAITING") void sw.skipWaiting();
});

// ── running-timer notifications: "Stop" action + sticky re-show ──────────────
// The web has no true "ongoing"/non-dismissable notification, so we make it sticky by
// re-showing it when it's dismissed — as long as its timer is still running. Tags we close on
// purpose (the Stop action) are parked here so the close handler lets them go.
const reshowSuppressed = new Set<string>();

sw.addEventListener("notificationclick", (event) => {
  const data = event.notification.data as TimerNotifData | null;
  if (event.action === "stop" && data?.kind === "timer") {
    reshowSuppressed.add(event.notification.tag); // we're stopping it — don't bring it back
  }
  event.notification.close();
  if (event.action === "stop" && data?.kind === "timer") {
    event.waitUntil(stopTimerFromNotification(data));
  } else {
    event.waitUntil(focusApp()); // tapping the body opens/focuses the app
  }
});

sw.addEventListener("notificationclose", (event) => {
  const data = event.notification.data as TimerNotifData | null;
  if (data?.kind === "timer") event.waitUntil(reshowIfStillRunning(event.notification));
});

/** Bring a dismissed timer notification back, unless we closed it on purpose (Stop) or its
 *  timer has stopped (consumed/discarded here or on another device). */
async function reshowIfStillRunning(n: SwNotification): Promise<void> {
  if (reshowSuppressed.delete(n.tag)) return; // closed by the Stop action — let it go
  const data = n.data as TimerNotifData;
  if (!(await timerStillRunning(data))) return; // timer ended → no need to nag
  await sw.registration.showNotification(n.title, {
    tag: n.tag,
    body: n.body,
    icon: n.icon,
    badge: n.badge,
    requireInteraction: true,
    renotify: false,
    silent: true, // it was just dismissed — bring it back quietly, don't buzz again
    actions: [{ action: "stop", title: "Stop" }],
    data,
  });
}

/** A timer is still running iff its mapping is present AND no stop is queued for it. */
async function timerStillRunning(data: TimerNotifData): Promise<boolean> {
  if (!data.localId) return false; // server-only card — the page owns its lifecycle
  const [maps, records] = await Promise.all([allTimerMappings(), allRecords()]);
  const stopQueued = records.some((r) => {
    const m = r.mutation;
    return (
      (m.kind === "consume-feeding" ||
        m.kind === "consume-sleep" ||
        m.kind === "consume-tummy" ||
        m.kind === "discard-timer") &&
      m.localId === data.localId
    );
  });
  return maps.some((mp) => mp.localId === data.localId) && !stopQueued;
}

/** Stop a running timer straight from its notification — enqueue the consume + flush. */
async function stopTimerFromNotification(d: TimerNotifData): Promise<void> {
  const conn = await loadConnection();
  if (!conn) return;
  // Resolve a localId the consume can reference (mint one for a server-only timer).
  let localId = d.localId;
  if (!localId) {
    localId = crypto.randomUUID();
    await setTimerMapping({ localId, serverId: d.serverId, startedAt: d.startedAt, activity: d.activity, childId: d.childId, feeding: d.feeding });
  }
  if (d.activity === "feeding") {
    const type: FeedingType = (d.feeding?.type as FeedingType) ?? "breast milk";
    const allowed = METHODS_FOR_TYPE[type];
    const chosen = d.feeding?.method as FeedingMethod | undefined;
    const method = chosen && allowed.includes(chosen) ? chosen : allowed[0];
    await enqueue(consumeTimerMutation("feeding", localId, d.childId, { type, method }));
  } else if (d.activity === "sleep") {
    await enqueue(consumeTimerMutation("sleep", localId, d.childId));
  } else {
    await enqueue(consumeTimerMutation("tummy", localId, d.childId));
  }
  await flushOutbox(createBabyBuddyClient(conn)).catch(() => {}); // offline → Background Sync retries
  // Nudge any open tab to refresh its view.
  for (const client of await sw.clients.matchAll({ type: "window" })) client.postMessage({ type: "timers-changed" });
}

async function focusApp(): Promise<void> {
  const open = await sw.clients.matchAll({ type: "window" });
  if (open.length) {
    await open[0].focus();
    return;
  }
  await sw.clients.openWindow(BASE);
}

export {};
