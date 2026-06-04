# `src/api` — Baby Buddy typed API layer

A thin, fully-typed client over a self-hosted Baby Buddy instance, plus an offline-first
write pipeline. **No types are hand-written** — they're generated from the instance's
OpenAPI schema.

## Layers

```
generated/schema.d.ts   ← openapi-typescript output. NEVER edit by hand.
connection.ts           Connection shape, BABYBUDDY-LOGIN QR parser, URL normalization
errors.ts               BabyBuddyApiError + TimerAlreadyConsumedError + unwrap()
client.ts               createBabyBuddyClient(conn) — Token auth; validateConnection()
activities.ts           the 4 activities, timer-name allow-list, METHODS_FOR_TYPE, diaper states
children.ts             listChildren()
timers.ts               listActiveTimers() · startTimer() · discardTimer()
entries.ts              consume{Feeding,Sleep,Tummy}Timer() · logDiaperChange() · create*() · updateEntry() · deleteEntry() · getLastFeedingChoice()
timeline.ts             listRecentEntries() — merges feedings/sleep/tummy/changes into one stream
mutations.ts            serializable Mutation commands (every write) + factories
outbox.ts               durable IndexedDB queue + localId→timer map + persisted Connection
sync.ts                 flushOutbox() — worker-side drain with retry/coalescing; auto-flush wiring
service-worker.ts       background drain on Sync / postMessage
index.ts                public barrel
```

Typical online write is just: build a `Mutation` → `enqueue()` → `flushOutbox(client)`
(which the page also runs on `online`/focus/interval, and the SW runs on Background Sync).

## Regenerating types

The instance schema is **pinned to a version** and committed at `schema/babybuddy.openapi.yml`,
so type generation is reproducible and diffable.

```bash
npm run gen:api        # schema/babybuddy.openapi.yml → src/api/generated/schema.d.ts
npm run fetch:schema   # refresh the pinned schema from upstream (github @ v$BABYBUDDY_VERSION)
npm run api:refresh    # fetch + gen
```

> ⚠️ This instance's live `/api/schema/` returns **HTTP 500** (the drf-spectacular generator
> is broken server-side; the data API is healthy). So we generate from the schema **upstream
> commits for v2.9.2**, which is the exact CI-generated schema for that version.
> `npm run fetch:schema:live` exists to try the instance directly once it's fixed.

## Contract facts (verified live against v2.9.2)

These were confirmed with self-cleaning round-trips, not assumed — a few correct earlier
assumptions in `CLAUDE.md`/the mockup:

1. **Timers have no `active`/`end` state.** `?active=true` and `?active=false` return the
   same rows — the param is ignored. A stored timer *is* a running timer; it vanishes only
   when consumed or deleted. So `listActiveTimers()` lists **all** timers (and drops
   unrecognized names).
2. **Stop = consume.** `POST /api/{feedings,sleep,tummy-times}/ {timer:<id>}` pulls
   start/end/child from the timer, creates the entry, and **deletes the timer**. No PATCH.
3. **Feeding `type`+`method` are required even when consuming** (omitting → 400). `method`
   has 6 values incl. `parent fed`/`self fed`, so `solid food` maps to those — never `[]`.
4. **Stop race** (two caregivers): re-consuming a gone timer → `400 {"timer":[…object does
   not exist…]}`. We key detection on the **`timer` field**, not the message, and surface it
   as `TimerAlreadyConsumedError` → treat as "already logged, re-fetch".
5. **Untyped timers**: activity lives in `Timer.name`; unknown names are ignored entirely
   (never shown, never mutated).
6. **Explicit `start` is honored** on timer create, and direct entry create with explicit
   `start`/`end` works — both underpin the offline pipeline.

## Offline write pipeline

- Every write is a serializable `Mutation` stored in IndexedDB, so it survives reload /
  backgrounding / app-kill / being offline.
- `flushOutbox()` drains FIFO with exponential backoff + jitter, and never head-of-line-blocks
  independent writes.
- A start + its stop that are **both** still queued (activity began and ended offline) are
  **coalesced** into one direct entry create — no transient timer hits the server. A start
  that flushes while still running creates a real timer (with its true start time); its later
  stop consumes it via the persisted `localId → serverId` map.
- The stop race and 404s count as success.
- **Delivery is at-least-once**: a network drop *after* the server commits but *before* we see
  the response can duplicate a write (Baby Buddy has no idempotency key). Rare; fixed via
  timeline edit. See `sync.ts`.

## Same-origin / CORS

The app is served **same-origin with the instance** (deployed on the same host; in dev the
Vite proxy forwards `/api` there). So the client uses a **relative base** (`baseUrl: ""`) in
both the page and the service worker — no CORS, ever. The connection's `url` is kept only for
identity/QR, not routing. (The instance only sends CORS headers for allow-listed origins, so a
direct cross-origin browser call would be blocked — verified: the preflight returns no
`access-control-allow-origin`. Same-origin sidesteps that entirely.) During `npm run
dev`/`preview` the proxy targets a single instance (`BABYBUDDY_BASE_URL` from `.env`), so the
entered server URL is ignored there.

## PWA / service worker

Wired via `vite-plugin-pwa` (`injectManifest`): it builds `service-worker.ts` to
`/service-worker.js` at **root scope** and injects the manifest + registration. The worker:
- **precaches** the app shell (`/`, manifest) and **stale-while-revalidate**s same-origin
  static assets (JS/CSS/fonts); navigations are network-first → cached shell offline; `/api`
  is never cached. Verified: an offline reload renders the full shell.
- **drains the outbox** on Background Sync (`OUTBOX_SYNC_TAG`) and on a `flush` postMessage,
  reading the persisted `Connection` from IndexedDB.

Icons + manifest live in `public/` and `vite.config.ts`. Dev uses page autoflush
(`startOutboxAutoFlush`); the SW is verified via `vite preview`.

> Home-Assistant-ingress `session_cookies` are carried where the platform allows; browsers
> forbid setting the `Cookie` header, so in-browser ingress relies on `credentials:"include"`.
