/**
 * Timers — the running-activity layer.
 *
 * Verified against v2.9.2: a stored timer has no `end`/`active` field, so a timer that
 * exists IS a running timer. There is no server-side "active" concept; the documented
 * `?active=true` param is silently ignored. We therefore list ALL timers and treat each
 * as running. Timers disappear only when consumed into an entry or explicitly deleted.
 *
 * A timer carries no type — the activity lives in `Timer.name`. We classify names against
 * a normalized allow-list and DROP anything we don't recognize (a newer client may run
 * timer types we don't know; unknown ≠ invalid, so we never touch them).
 */
import type { components } from "./generated/schema";
import type { BabyBuddyClient } from "./client";
import { unwrap } from "./errors";
import { TIMER_NAMES, classifyTimerName, type TimerActivityKey } from "./activities";

export type Timer = components["schemas"]["Timer"];

/** A running timer whose name we recognize, paired with its resolved activity. */
export interface ClassifiedTimer {
  timer: Timer;
  activity: TimerActivityKey;
}

/**
 * Poll running timers (the "active timers" poll). Returns only recognized timers, each
 * tagged with its activity; unknown-named timers are filtered out entirely.
 *
 * @param childId optional — restrict to one child (server-side filter).
 */
export async function listActiveTimers(
  client: BabyBuddyClient,
  childId?: number,
): Promise<ClassifiedTimer[]> {
  const res = await client.GET("/api/timers/", {
    params: { query: childId === undefined ? {} : { child: String(childId) } },
  });
  const page = unwrap(res);
  const out: ClassifiedTimer[] = [];
  for (const timer of page.results ?? []) {
    const activity = classifyTimerName(timer.name);
    if (activity) out.push({ timer, activity });
  }
  return out;
}

/**
 * Start a timer for a timed activity (`POST /api/timers/`). The server stamps `user` and,
 * if `startedAt` is omitted, `start` (= now). Pass `startedAt` to preserve the true start
 * time when flushing a timer that was begun offline minutes ago (verified: the server
 * honors an explicit `start`). Written the moment a timer starts so every device sees it.
 */
export async function startTimer(
  client: BabyBuddyClient,
  activity: TimerActivityKey,
  childId: number,
  startedAt?: string,
): Promise<Timer> {
  const res = await client.POST("/api/timers/", {
    body: { name: TIMER_NAMES[activity], child: childId, ...(startedAt ? { start: startedAt } : {}) },
  });
  return unwrap(res);
}

/** Discard a timer without logging an entry (`DELETE /api/timers/{id}/`). */
export async function discardTimer(client: BabyBuddyClient, id: number): Promise<void> {
  const res = await client.DELETE("/api/timers/{id}/", {
    params: { path: { id: String(id) } },
  });
  if (!res.response.ok && res.response.status !== 404) {
    // 404 = already gone (another device discarded/consumed it) — treat as success.
    unwrap(res);
  }
}
