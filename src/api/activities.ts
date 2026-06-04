/**
 * Activity registry — the bridge between the app's four activities and the Baby Buddy
 * API. Domain values (feeding type/method) are derived from the generated schema so they
 * cannot silently drift from the instance: if a future Baby Buddy version changes an
 * enum, this file stops type-checking until it's reconciled.
 *
 * Timer model facts encoded here (verified live against v2.9.2):
 *  - Timers are untyped server-side; the activity lives entirely in `Timer.name`.
 *  - On READ, names are matched against a normalized allow-list. UNKNOWN names are
 *    ignored completely (never shown, never mutated) — another caregiver may run a
 *    newer client with timer types we don't know yet.
 *  - Diaper is instant (no timer); the other three are timed.
 */
import type { components } from "./generated/schema";

/** Feeding `type` enum, straight from the generated schema (4 values). */
export type FeedingType = components["schemas"]["Feeding"]["type"];
/** Feeding `method` enum, straight from the generated schema (6 values). */
export type FeedingMethod = components["schemas"]["Feeding"]["method"];

/** All four activities. */
export type ActivityKey = "feeding" | "sleep" | "diaper" | "tummy";
/** Activities that run as a timer (everything except instant diaper changes). */
export type TimerActivityKey = "feeding" | "sleep" | "tummy";

/** Entry endpoint each activity consumes a timer into / creates an entry on. */
export type EntryPath =
  | "/api/feedings/"
  | "/api/sleep/"
  | "/api/tummy-times/"
  | "/api/changes/";

export interface ActivityDef {
  key: ActivityKey;
  /** Human label (also the basis of the canonical timer name for timed activities). */
  label: string;
  /** Canonical `Timer.name` written on start; absent for instant diaper. */
  timerName?: string;
  /** Endpoint used to create the entry / consume the timer. */
  entryPath: EntryPath;
  timed: boolean;
}

/** Canonical timer name written on `POST /api/timers/`, per timed activity. */
export const TIMER_NAMES: Record<TimerActivityKey, string> = {
  feeding: "Feeding",
  sleep: "Sleep",
  tummy: "Tummy time",
};

export const ACTIVITIES: Record<ActivityKey, ActivityDef> = {
  feeding: { key: "feeding", label: "Feeding", timerName: TIMER_NAMES.feeding, entryPath: "/api/feedings/", timed: true },
  sleep: { key: "sleep", label: "Sleep", timerName: TIMER_NAMES.sleep, entryPath: "/api/sleep/", timed: true },
  tummy: { key: "tummy", label: "Tummy time", timerName: TIMER_NAMES.tummy, entryPath: "/api/tummy-times/", timed: true },
  diaper: { key: "diaper", label: "Diaper", entryPath: "/api/changes/", timed: false },
};

/**
 * Normalized allow-list: lowercased/trimmed timer name → activity. Deliberately
 * forgiving so "Tummy time", "tummy", "Nap" etc. all resolve. Anything not in here is
 * UNKNOWN and gets filtered out entirely (see `classifyTimerName`).
 */
const TIMER_NAME_ALIASES: Record<string, TimerActivityKey> = {
  feeding: "feeding",
  feed: "feeding",
  nursing: "feeding",
  nurse: "feeding",
  sleep: "sleep",
  nap: "sleep",
  "tummy time": "tummy",
  "tummy-time": "tummy",
  tummytime: "tummy",
  tummy: "tummy",
};

function normalizeName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

/**
 * Map a timer's `name` to one of our timed activities, or `null` if we don't recognize
 * it. `null` means "leave this timer completely alone."
 */
export function classifyTimerName(name: string | null | undefined): TimerActivityKey | null {
  return TIMER_NAME_ALIASES[normalizeName(name)] ?? null;
}

/**
 * Which feeding methods are valid for each feeding type.
 *
 * NOTE — corrected against the live v2.9.2 API: `method` is REQUIRED on every feeding
 * (verified: posting a feeding without it returns 400). So `solid food` maps to
 * `parent fed` / `self fed`, NOT to `[]` as the early mockup assumed — an empty method
 * would be rejected. This map is the single place to adjust if the instance rejects a
 * type/method combo. The `Record<FeedingType, …>` typing forces every type to be covered
 * and every method to be a real enum value.
 */
export const METHODS_FOR_TYPE: Record<FeedingType, FeedingMethod[]> = {
  "breast milk": ["left breast", "right breast", "both breasts", "bottle"],
  formula: ["bottle"],
  "fortified breast milk": ["bottle"],
  "solid food": ["parent fed", "self fed"],
};

/** Diaper change presets (wet / solid / both). `/api/changes/` requires both booleans. */
export const DIAPER_STATES = [
  { id: "wet", label: "Wet", wet: true, solid: false },
  { id: "solid", label: "Solid", wet: false, solid: true },
  { id: "both", label: "Both", wet: true, solid: true },
] as const;

export type DiaperStateId = (typeof DIAPER_STATES)[number]["id"];
