/**
 * Entries — creating typed records, either by CONSUMING a running timer or by direct
 * (backdated / instant) creation.
 *
 * Consuming a timer is how you "stop" it: `POST /api/{feedings,sleep,tummy-times}/`
 * with `{ timer: <id> }` pulls start/end/child from the timer, creates the entry, and
 * DELETES the timer server-side (verified). There is no stop/PATCH endpoint.
 *
 * Feedings additionally REQUIRE `type` + `method` even when consuming a timer (verified:
 * omitting them returns 400) — so the caller must always supply them (default from the
 * child's last feeding, see `getLastFeedingChoice`).
 *
 * If the timer was already consumed/deleted on another device, the POST returns 400 with
 * a `timer` field error; we surface that as `TimerAlreadyConsumedError` so callers can
 * re-fetch instead of showing a failure.
 */
import type { components } from "./generated/schema";
import type { BabyBuddyClient } from "./client";
import type { FeedingType, FeedingMethod, EntryPath } from "./activities";
import {
  BabyBuddyApiError,
  TimerAlreadyConsumedError,
  isTimerGoneError,
  unwrap,
  type FetchResult,
} from "./errors";

export type Feeding = components["schemas"]["Feeding"];
export type Sleep = components["schemas"]["Sleep"];
export type TummyTime = components["schemas"]["TummyTime"];
export type DiaperChange = components["schemas"]["DiaperChange"];

/** ISO-8601 UTC datetime string (we store UTC, render local). */
export type IsoDateTime = string;

export interface FeedingFields {
  type: FeedingType;
  method: FeedingMethod;
  amount?: number | null;
  notes?: string | null;
}
export interface SleepFields {
  nap?: boolean | null;
  notes?: string | null;
}
export interface TummyFields {
  /** Tummy-time has no `notes` column server-side — use `milestone` for free text. */
  milestone?: string;
}
export interface DiaperFields {
  wet: boolean;
  solid: boolean;
  time?: IsoDateTime;
  color?: DiaperChange["color"];
  amount?: number | null;
  notes?: string | null;
}

/** Run a consume result, mapping the "timer already gone" race to a typed error. */
function finishConsume<T>(res: FetchResult<T>): T {
  try {
    return unwrap(res);
  } catch (err) {
    if (isTimerGoneError(err)) {
      throw new TimerAlreadyConsumedError((err as BabyBuddyApiError).body);
    }
    throw err;
  }
}

// ── Consume a running timer into an entry (the "stop" operation) ──────────────

export async function consumeFeedingTimer(
  client: BabyBuddyClient,
  timerId: number,
  fields: FeedingFields,
): Promise<Feeding> {
  const res = await client.POST("/api/feedings/", { body: { timer: timerId, ...fields } });
  return finishConsume(res);
}

export async function consumeSleepTimer(
  client: BabyBuddyClient,
  timerId: number,
  fields: SleepFields = {},
): Promise<Sleep> {
  const res = await client.POST("/api/sleep/", { body: { timer: timerId, ...fields } });
  return finishConsume(res);
}

export async function consumeTummyTimer(
  client: BabyBuddyClient,
  timerId: number,
  fields: TummyFields = {},
): Promise<TummyTime> {
  const res = await client.POST("/api/tummy-times/", { body: { timer: timerId, ...fields } });
  return finishConsume(res);
}

// ── Direct creation (instant diaper, or backdated / manual logging) ───────────

/** Log a diaper change — instant, no timer. `/api/changes/` requires `wet` + `solid`. */
export async function logDiaperChange(
  client: BabyBuddyClient,
  childId: number,
  fields: DiaperFields,
): Promise<DiaperChange> {
  const res = await client.POST("/api/changes/", { body: { child: childId, ...fields } });
  return unwrap(res);
}

export async function createFeeding(
  client: BabyBuddyClient,
  childId: number,
  start: IsoDateTime,
  end: IsoDateTime,
  fields: FeedingFields,
): Promise<Feeding> {
  const res = await client.POST("/api/feedings/", {
    body: { child: childId, start, end, ...fields },
  });
  return unwrap(res);
}

export async function createSleep(
  client: BabyBuddyClient,
  childId: number,
  start: IsoDateTime,
  end: IsoDateTime,
  fields: SleepFields = {},
): Promise<Sleep> {
  const res = await client.POST("/api/sleep/", { body: { child: childId, start, end, ...fields } });
  return unwrap(res);
}

export async function createTummyTime(
  client: BabyBuddyClient,
  childId: number,
  start: IsoDateTime,
  end: IsoDateTime,
  fields: TummyFields = {},
): Promise<TummyTime> {
  const res = await client.POST("/api/tummy-times/", {
    body: { child: childId, start, end, ...fields },
  });
  return unwrap(res);
}

// ── Edit / delete existing entries ───────────────────────────────────────────

/**
 * A typed PATCH body per endpoint. Each variant carries its schema's required fields, so
 * editing only a time still sends a body the server accepts (DRF PATCH is partial; the
 * required fields come from the entry being edited).
 */
export type EntryPatch =
  | { path: "/api/feedings/"; body: { type: FeedingType; method: FeedingMethod; start?: IsoDateTime; end?: IsoDateTime; amount?: number | null; notes?: string | null } }
  | { path: "/api/sleep/"; body: { start?: IsoDateTime; end?: IsoDateTime; nap?: boolean | null; notes?: string | null } }
  | { path: "/api/tummy-times/"; body: { start?: IsoDateTime; end?: IsoDateTime; milestone?: string } }
  | { path: "/api/changes/"; body: { child: number; wet: boolean; solid: boolean; time?: IsoDateTime; color?: DiaperChange["color"]; amount?: number | null; notes?: string | null } };

export async function updateEntry(client: BabyBuddyClient, id: number, patch: EntryPatch): Promise<void> {
  const params = { path: { id: String(id) } };
  switch (patch.path) {
    case "/api/feedings/":
      unwrap(await client.PATCH("/api/feedings/{id}/", { params, body: patch.body }));
      return;
    case "/api/sleep/":
      unwrap(await client.PATCH("/api/sleep/{id}/", { params, body: patch.body }));
      return;
    case "/api/tummy-times/":
      unwrap(await client.PATCH("/api/tummy-times/{id}/", { params, body: patch.body }));
      return;
    case "/api/changes/":
      unwrap(await client.PATCH("/api/changes/{id}/", { params, body: patch.body }));
      return;
  }
}

export async function deleteEntry(client: BabyBuddyClient, path: EntryPath, id: number): Promise<void> {
  const params = { path: { id: String(id) } };
  const res =
    path === "/api/feedings/"
      ? await client.DELETE("/api/feedings/{id}/", { params })
      : path === "/api/sleep/"
        ? await client.DELETE("/api/sleep/{id}/", { params })
        : path === "/api/tummy-times/"
          ? await client.DELETE("/api/tummy-times/{id}/", { params })
          : await client.DELETE("/api/changes/{id}/", { params });
  if (!res.response.ok && res.response.status !== 404) unwrap(res); // 404 = already deleted
}

// ── Read helpers ──────────────────────────────────────────────────────────────

/** The child's last feeding `{type, method}`, to pre-select the next feeding's details. */
export async function getLastFeedingChoice(
  client: BabyBuddyClient,
  childId: number,
): Promise<Pick<FeedingFields, "type" | "method"> | null> {
  const res = await client.GET("/api/feedings/", {
    params: { query: { child: String(childId), limit: 1, ordering: "-start" } },
  });
  const last = unwrap(res).results?.[0];
  return last ? { type: last.type, method: last.method } : null;
}
