/**
 * Unified timeline — Baby Buddy has no single "entries" endpoint, so we fetch feedings,
 * sleep, tummy-times and changes in parallel and merge/sort them into one stream.
 */
import type { components } from "./generated/schema";
import type { BabyBuddyClient } from "./client";
import type { FeedingType, FeedingMethod, MedicationUnit, ActivityKey, EntryPath } from "./activities";
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
  | (TimelineEntryBase & { activity: "diaper"; wet: boolean; solid: boolean; notes: string | null })
  | (TimelineEntryBase & { activity: "medication"; name: string; dosage: number | null; dosageUnit: MedicationUnit | null; nextDoseInterval: string | null; notes: string | null });

const parse = (v: string | null | undefined): number => (v ? Date.parse(v) : 0);

type Lists = {
  feedings: components["schemas"]["Feeding"][];
  sleep: components["schemas"]["Sleep"][];
  tummy: components["schemas"]["TummyTime"][];
  changes: components["schemas"]["DiaperChange"][];
  medication: components["schemas"]["Medication"][];
};

/** Merge the endpoint result sets into one newest-first stream of typed timeline entries. */
function mergeEntries({ feedings, sleep, tummy, changes, medication }: Lists): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const f of feedings) {
    if (f.id == null) continue;
    out.push({ id: f.id, activity: "feeding", path: "/api/feedings/", startMs: parse(f.start), endMs: f.end ? parse(f.end) : null, type: f.type, method: f.method, amount: f.amount ?? null, notes: f.notes ?? null });
  }
  for (const sl of sleep) {
    if (sl.id == null) continue;
    out.push({ id: sl.id, activity: "sleep", path: "/api/sleep/", startMs: parse(sl.start), endMs: sl.end ? parse(sl.end) : null, nap: sl.nap ?? null, notes: sl.notes ?? null });
  }
  for (const tt of tummy) {
    if (tt.id == null) continue;
    out.push({ id: tt.id, activity: "tummy", path: "/api/tummy-times/", startMs: parse(tt.start), endMs: tt.end ? parse(tt.end) : null, milestone: tt.milestone ?? null });
  }
  for (const c of changes) {
    if (c.id == null) continue;
    out.push({ id: c.id, activity: "diaper", path: "/api/changes/", startMs: parse(c.time), endMs: null, wet: c.wet, solid: c.solid, notes: c.notes ?? null });
  }
  for (const md of medication) {
    if (md.id == null) continue;
    out.push({ id: md.id, activity: "medication", path: "/api/medication/", startMs: parse(md.time), endMs: null, name: md.name, dosage: md.dosage ?? null, dosageUnit: md.dosage_unit ?? null, nextDoseInterval: md.next_dose_interval ?? null, notes: md.notes ?? null });
  }
  return out.sort((a, b) => b.startMs - a.startMs);
}

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
  const [feedings, sleep, tummy, changes, medication] = await Promise.all([
    client.GET("/api/feedings/", { params: { query: { child, limit: limitPer, ordering: "-start" } } }),
    client.GET("/api/sleep/", { params: { query: { child, limit: limitPer, ordering: "-start" } } }),
    client.GET("/api/tummy-times/", { params: { query: { child, limit: limitPer, ordering: "-start" } } }),
    client.GET("/api/changes/", { params: { query: { child, limit: limitPer, ordering: "-time" } } }),
    client.GET("/api/medication/", { params: { query: { child, limit: limitPer, ordering: "-time" } } }),
  ]);
  return mergeEntries({
    feedings: unwrap(feedings).results ?? [],
    sleep: unwrap(sleep).results ?? [],
    tummy: unwrap(tummy).results ?? [],
    changes: unwrap(changes).results ?? [],
    medication: unwrap(medication).results ?? [],
  });
}

/**
 * Fetch every entry overlapping the local window [fromMs, toMs) — for the calendar's day/week
 * grids and summary. Timed activities are queried by `start` (widened 18 h on the low side so an
 * overnight sleep that began the previous evening still shows); instants by their `time`.
 */
export async function listEntriesInRange(
  client: BabyBuddyClient,
  childId: number,
  fromMs: number,
  toMs: number,
): Promise<TimelineEntry[]> {
  const child = String(childId);
  const startMin = new Date(fromMs - 18 * 3_600_000).toISOString();
  const startMax = new Date(toMs).toISOString();
  const timed = { child, start_min: startMin, start_max: startMax, limit: 500, ordering: "-start" };
  // Instant entries (changes, medication): despite the names, `date_min`/`date_max` compare
  // against the full `time` DATETIME — a bare date parses as midnight, so a same-day window
  // (`date_min = date_max = <day>`) matches nothing. Pass the exact window as ISO datetimes.
  const instant = { child, date_min: new Date(fromMs).toISOString(), date_max: new Date(toMs).toISOString(), limit: 500, ordering: "-time" };
  const [feedings, sleep, tummy, changes, medication] = await Promise.all([
    client.GET("/api/feedings/", { params: { query: timed } }),
    client.GET("/api/sleep/", { params: { query: timed } }),
    client.GET("/api/tummy-times/", { params: { query: timed } }),
    client.GET("/api/changes/", { params: { query: instant } }),
    client.GET("/api/medication/", { params: { query: instant } }),
  ]);
  return mergeEntries({
    feedings: unwrap(feedings).results ?? [],
    sleep: unwrap(sleep).results ?? [],
    tummy: unwrap(tummy).results ?? [],
    changes: unwrap(changes).results ?? [],
    medication: unwrap(medication).results ?? [],
  });
}
