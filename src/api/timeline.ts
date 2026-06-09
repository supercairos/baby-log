/**
 * Unified timeline — Baby Buddy has no single "entries" endpoint, so we fetch feedings,
 * sleep, tummy-times and changes in parallel and merge/sort them into one stream.
 */
import type { BabyBuddyClient } from "./client";
import type { FeedingType, FeedingMethod, ActivityKey, EntryPath } from "./activities";
import { unwrap } from "./errors";

export interface TimelineEntryBase {
  /** Server id (within its endpoint). */
  id: number;
  activity: ActivityKey;
  path: EntryPath;
  /** Epoch ms. For diapers this is the instant `time`; otherwise the `start`. */
  startMs: number;
  /** Epoch ms, or null for instant entries (diaper). */
  endMs: number | null;
}

export type TimelineEntry =
  | (TimelineEntryBase & { activity: "feeding"; type: FeedingType; method: FeedingMethod; amount: number | null; notes: string | null })
  | (TimelineEntryBase & { activity: "sleep"; nap: boolean | null; notes: string | null })
  | (TimelineEntryBase & { activity: "tummy"; milestone: string | null })
  | (TimelineEntryBase & { activity: "diaper"; wet: boolean; solid: boolean; notes: string | null });

const parse = (v: string | null | undefined): number => (v ? Date.parse(v) : 0);

/**
 * Fetch the most recent entries across all activity types for a child, newest first.
 * @param limitPer max rows pulled from each endpoint before merging (default 25).
 */
export async function listRecentEntries(
  client: BabyBuddyClient,
  childId: number,
  limitPer = 25,
): Promise<TimelineEntry[]> {
  const child = String(childId);
  const [feedings, sleep, tummy, changes] = await Promise.all([
    client.GET("/api/feedings/", { params: { query: { child, limit: limitPer, ordering: "-start" } } }),
    client.GET("/api/sleep/", { params: { query: { child, limit: limitPer, ordering: "-start" } } }),
    client.GET("/api/tummy-times/", { params: { query: { child, limit: limitPer, ordering: "-start" } } }),
    client.GET("/api/changes/", { params: { query: { child, limit: limitPer, ordering: "-time" } } }),
  ]);

  const out: TimelineEntry[] = [];

  for (const f of unwrap(feedings).results ?? []) {
    if (f.id == null) continue;
    out.push({
      id: f.id,
      activity: "feeding",
      path: "/api/feedings/",
      startMs: parse(f.start),
      endMs: f.end ? parse(f.end) : null,
      type: f.type,
      method: f.method,
      amount: f.amount ?? null,
      notes: f.notes ?? null,
    });
  }
  for (const sl of unwrap(sleep).results ?? []) {
    if (sl.id == null) continue;
    out.push({
      id: sl.id,
      activity: "sleep",
      path: "/api/sleep/",
      startMs: parse(sl.start),
      endMs: sl.end ? parse(sl.end) : null,
      nap: sl.nap ?? null,
      notes: sl.notes ?? null,
    });
  }
  for (const tt of unwrap(tummy).results ?? []) {
    if (tt.id == null) continue;
    out.push({
      id: tt.id,
      activity: "tummy",
      path: "/api/tummy-times/",
      startMs: parse(tt.start),
      endMs: tt.end ? parse(tt.end) : null,
      milestone: tt.milestone ?? null,
    });
  }
  for (const c of unwrap(changes).results ?? []) {
    if (c.id == null) continue;
    out.push({
      id: c.id,
      activity: "diaper",
      path: "/api/changes/",
      startMs: parse(c.time),
      endMs: null,
      wet: c.wet,
      solid: c.solid,
      notes: c.notes ?? null,
    });
  }

  return out.sort((a, b) => b.startMs - a.startMs);
}
