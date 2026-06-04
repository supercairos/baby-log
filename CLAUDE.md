# Baby Log — Project Context

A custom mobile-first PWA client for a self-hosted **Baby Buddy** instance, focused on
fast one-handed logging (feeds, sleep, diapers, tummy time) for sleep-deprived parents.

Two reference mockups exist (single-file HTML, React via CDN + in-browser Babel):
`baby-log.html` (dark aubergine theme) and `baby-log-light.html` (warm paper theme).
They are the **living spec** for interaction + visual design. Read them before reimplementing UI.

---

## Target stack

- **PWA**: React + TypeScript + Vite (chosen over the existing Kotlin Android app for cross-platform
  incl. iOS for both caregivers, trivial deploy, matches existing skillset).
- Thin client over the Baby Buddy REST API. Almost all logic is HTTP calls; the app is a UI shell.
- Typed API client **generated** from the instance's OpenAPI schema (`/api/schema/`) via
  `openapi-typescript` — do NOT hand-write the client. The API shape varies by Baby Buddy version.
- Self-host fonts (Fraunces + Nunito) as `.woff2` — do not depend on Google Fonts (offline + flaky
  nursery wifi). The mockups load them via `<link>` only because they're previews.

## First concrete steps (in order)

1. Generate the typed client from the running instance's `/api/schema/`.
2. Port the home screen from `baby-log.html` onto real typed hooks.
3. Wire auth (see QR login below).
4. Add the offline/persistence layer.

---

## Baby Buddy API — key facts (verified against source/docs)

### Auth
- Token auth: header `Authorization: Token <api_key>`.
- Validate a connection with `GET {url}api/children/`.

### Login QR code (exact format, from babybuddy source `login_qr_code.txt`)
The "Add a device" page (User → Add a device) renders a QR whose decoded text is:
```
BABYBUDDY-LOGIN:{"url":"https://instance/","api_key":"<token>","session_cookies":{}}
```
Parser:
1. Reject if it doesn't start with `BABYBUDDY-LOGIN:`.
2. Strip that prefix, `JSON.parse` the rest.
3. Extract `url` (note trailing slash; append `api/`) and `api_key`.
4. `session_cookies` is `{}` for normal deployments; only populated (with an `ingress_session`
   cookie) when Baby Buddy runs behind Home Assistant ingress. If non-empty, send those cookies
   alongside the token.

### Timers are NOT typed
- A timer is generic: `{id, child, name, start, duration, user}`. There is **no type field**.
- The "type" is a **client-side convention stored in `name`** ("Feeding", "Sleep", "Tummy time").
- The server does not enforce it. The same timer could be converted to any entry type.
- On READ (`GET /api/timers/?active=true`), match `name` → activity using a **normalized
  allow-list** (lowercase + trim). Match forgivingly so "Tummy time"/"tummy" resolve.
- **Unknown/unrecognized names are IGNORED** — for display AND for any future mutation. Rationale:
  another caregiver may run a newer app version with timer types this client doesn't know yet;
  unknown ≠ invalid, so leave them completely alone (never delete/convert them). Keep it simple:
  no neutral card, no chooser, no "N others running" hint. Just filter them out.

### Stopping a timer = consuming it into an entry
- There is no "stop"/PATCH endpoint. You stop a timer by creating the typed entry from it:
  `POST /api/{feedings,sleep,tummy-times}/ {"timer": <id>}`.
- This pulls start/end from the timer, creates the entry, and **deletes the timer** server-side.
- To discard a mistaken timer without logging: `DELETE /api/timers/<id>/`.
- Race condition (two caregivers stop same timer): 2nd POST hits a deleted timer → "Timer does not
  exist" error. Handle gracefully: re-fetch (the activity was already logged) rather than show failure.

### Activity field semantics
- Feeding: `type` (breast milk / formula / fortified breast milk / solid food) and
  `method` (left breast / right breast / both breasts / bottle).
- Diaper (`/api/changes/`): booleans `wet` and `solid` (can be both). Instant, no duration.
- Bottle feeds support an `amount` (ml) field — NOT yet in the mockup; next field to add.
- One unified timeline = several endpoints fetched in parallel and merged/sorted by timestamp.
  There is no single "entries" endpoint.

---

## Persistence & timers model (critical)

- **Never run a live timer.** A timer is just a stored `startedAt` timestamp. Elapsed time is
  always derived as `now - startedAt`, recomputed on render. The 1s `setInterval` only repaints
  the clock; it has nothing to do with correctness. This makes reload / backgrounding / app-kill /
  multi-device all work for free.
- **Source of truth = the Baby Buddy server.** Write to the server the *moment* a timer starts
  (`POST /api/timers/`), not at stop. Then any device sees it via the active-timers poll.
- **Local layer (IndexedDB)** is the offline buffer, not the primary store:
  - mirror of active timers,
  - an outbox of writes not yet flushed to the server (service worker retries on reconnect).
- **Reconciliation on reopen**: fetch server timers, merge with local outbox. Timers are just
  timestamps so conflicts are trivial; if server has a stop time you don't, server wins.
- Store UTC, render local (DST / midnight-spanning sleeps must stay correct).
- **Stale-timer nudge**: if e.g. a "sleep" has run >~14h it's likely a forgotten stop — surface a
  gentle "still sleeping?" prompt rather than logging a nonsense duration.

### Multi-caregiver
- Shared state is the server. Poll `GET /api/timers/?active=true` on focus + every ~30–60s.
- Either caregiver can stop either caregiver's timer (only the timer id is needed, not ownership).

---

## UX / interaction rules (from the mockups)

- **Thumb-first**: primary actions (activity tiles) at the bottom; running timers + child switcher
  at top. Big tap targets, dark-by-default (nursery at 3am). Haptics + top toast on action,
  no confirm dialogs (fix mistakes later via timeline edit).
- **Color = identity**: each activity owns one accent in one fixed position (muscle memory).
- **Feeding starts immediately on tile tap** — the timer is running before details are chosen.
  The details sheet opens *over* the running timer; type/method are **optional refinements** applied
  to the live timer. A pencil button on the running card reopens the sheet; tapping the card body
  STOPS the timer ("tap to stop" hint). Starting blank must not overwrite remembered last choice.
- **Feeding method is filtered by type** (`METHODS_FOR_TYPE`): formula/fortified → bottle only
  (auto-selected); breast milk → all four; solid food → no method. Selection self-corrects when
  type changes. This map is the one place to adjust if the instance rejects a combo.
- **Last feeding choice** is remembered per-child and pre-selected (derive from
  `GET /api/feedings/?child=<id>&limit=1&ordering=-start` in the real app so it's correct across
  devices; localStorage as instant-paint fallback).
- **Timeline**: entries grouped Today / Yesterday / weekday-date, newest first. Every entry is
  tappable → edit sheet (type/method or wet/solid + editable start/end times, delete). "Add entry"
  button opens the same sheet with an activity picker for backdated/manual logging. New timed
  entries default to a 15-min span; validate end ≥ start (block save + red readout otherwise).
- Entries store **structured fields** (type/method, wet/solid), and the display label is derived
  live via a `metaFor()` helper — this mirrors what the API PATCH body wants.
- **Auth gate**: landing/hero screen → "Scan Login QR" (camera via `BarcodeDetector`, `jsQR`
  fallback) or manual server-URL + token entry. Persist the connection (localStorage/IndexedDB) so
  reload stays logged in. Disconnect lives in the drawer.

## Design system

- Two themes, identical structure, just different palettes — wire a light/dark toggle (follow system).
- Fonts: **Fraunces** (display serif: greeting, timers, labels, headings) + **Nunito** (body).
  Always set an explicit light text color AND `color: inherit` on buttons — webview buttons reset
  text to black otherwise (this was a real bug).
- Dark theme: warm aubergine/charcoal base, soft accents (honey feeding, dusty blue sleep, sage
  diaper, rose tummy), grain texture, subtle press-scale.
- Light theme: cream/oatmeal paper, ink text, saturated earthy accents (terracotta/teal/olive/plum),
  hard offset shadows ("0 4px 0") with a press-to-sink effect.
- Respect `env(safe-area-inset-*)` in the installed PWA (top toast vs notch).

## Icons
- Use Lucide or Phosphor (MIT, tree-shakeable). Gaps (no good "diaper"/"tummy time" glyph) → hand
  inline SVGs. The mockups already contain custom inline SVGs for all four activities.

---

## Notes
- The mockups fake all data in React state (no persistence, resets on reload) and fake the QR
  scan + connect with `setTimeout`. The *parsing* and the connection object
  (`{url, api_key, session_cookies}`) are real-shaped for a clean swap.
- The in-browser Babel warning in the console is expected for the preview only; gone in the Vite build.
