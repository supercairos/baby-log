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
import { loadConnection } from "./outbox";
import { flushOutbox, OUTBOX_SYNC_TAG } from "./sync";

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
interface ServiceWorkerScope {
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  readonly location: { origin: string };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "sync", listener: (event: SyncEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

const sw = self as unknown as ServiceWorkerScope;

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
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => sw.skipWaiting()));
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
  if (typeof event.data === "object" && event.data !== null && (event.data as { type?: unknown }).type === "flush") {
    event.waitUntil(flush());
  }
});

export {};
