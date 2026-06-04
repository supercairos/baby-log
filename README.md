# Baby Log

A mobile-first PWA for fast, one-handed baby tracking (feeds, sleep, diapers, tummy time),
built as a thin, offline-first client over a self-hosted [Baby Buddy](https://github.com/babybuddy/babybuddy)
instance. React + TypeScript + Vite.

## Highlights

- **Typed API client generated** from Baby Buddy's OpenAPI schema (`openapi-typescript` +
  `openapi-fetch`) — never hand-written. See [`src/api/README.md`](src/api/README.md).
- **Offline-first writes** — every mutation is a serializable command in an IndexedDB outbox,
  drained by a service worker (Background Sync) with retry/backoff. Timers are derived from a
  stored `startedAt`, so reload / backgrounding / multi-device all work.
- **Optimistic UI** — a started timer shows instantly and reconciles with the server poll.
- **Installable PWA** with an offline app shell; dark + light themes (follows system).
- **Self-hosted fonts** (Fraunces + Nunito) — no Google Fonts dependency.

## Develop

```bash
npm install --legacy-peer-deps   # openapi-typescript declares a typescript@^5 peer; TS 6 works
npm run dev                      # http://localhost:5173 (proxies /api → your instance)
```

The app is served **same-origin** with the instance, so it calls `/api/…` relative (no CORS).
In dev, Vite proxies `/api` to `BABYBUDDY_BASE_URL` (set in `.env`). Copy `.env.example` → `.env`.

| Script | What |
|---|---|
| `npm run dev` | Dev server + `/api` proxy |
| `npm run build` | `tsc -b && vite build` (+ PWA service worker) |
| `npm run preview` | Serve the production build (also proxies `/api`) |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc` |
| `npm run gen:api` | Regenerate the typed client from `schema/babybuddy.openapi.yml` |
| `npm run fetch:schema` | Refresh the pinned schema (upstream v2.9.2; the live endpoint 500s) |

## Deploy (Docker)

Multi-stage build → unprivileged nginx that serves the PWA and proxies `/api` to the instance:

```bash
docker build -t baby-log .
docker run -p 8080:8080 -e BABYBUDDY_UPSTREAM=https://babybuddy.example.com baby-log

# Serve under a subpath — same image, set at RUNTIME (no rebuild):
docker run -p 8080:8080 \
  -e BABYBUDDY_UPSTREAM=https://babybuddy.example.com \
  -e BASE_PATH=/quick-ui/ baby-log
```

- `BABYBUDDY_UPSTREAM` — no trailing slash/path.
- `BASE_PATH` (runtime, default `/`) — the image is built with a placeholder base and the
  entrypoint substitutes `BASE_PATH` into the (absolute) asset URLs, manifest, and SW scope at
  start, then relocates the build under it. Absolute URLs keep deep links / refreshes
  (`/quick-ui/timeline`) working. `/api` is always at the domain root.

CI publishes images to `ghcr.io/<owner>/baby-log` on every push to `main` and on `v*` tags.

## CI / releases

- **CI** (`.github/workflows/ci.yml`): commitlint, lint + typecheck, build, and a Docker
  build+push to GHCR.
- **Releases** (`.github/workflows/release-please.yml`): [Release Please](https://github.com/googleapis/release-please)
  derives versions + `CHANGELOG.md` from [Conventional Commits](https://www.conventionalcommits.org/)
  and opens a release PR; merging it tags `v*` and ships a versioned image.
