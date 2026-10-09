/**
 * Milk stash — where a pumped bottle is kept, and when it turns.
 *
 * Baby Buddy has no storage model, so the state rides in the Pumping entry's `notes`
 * behind a machine-readable prefix. Same trick as the "|"-encoded feeding side in
 * `Timer.name` (see activities.ts): the server is still the single source of truth, every
 * caregiver's device sees the same state, and Baby Buddy's own web UI still shows the note.
 *
 *   [stash loc=fridge at=2026-08-15T02:10:00.000Z state=stored] left side sore
 *   ╰────────────── machine, stripped on read ─────────────────╯ ╰─ the parent's text ─╯
 *
 * The human half is preserved verbatim across every rewrite — we never clobber what a
 * caregiver typed.
 *
 * EXPIRY IS DERIVED, NEVER STORED. We keep only `loc` + `at` and recompute freshness on
 * render, exactly as a running timer keeps only `startedAt` and derives elapsed. Reload,
 * backgrounding and multi-device all stay correct for free, and there's no stored deadline
 * that can drift out of sync with the location it was computed from.
 */
import type { Pumping } from "../api/entries";

export type StashLocation = "room" | "fridge" | "freezer" | "thawed";
export type StashState = "stored" | "used" | "discarded";

export const STASH_LOCATIONS: StashLocation[] = ["fridge", "freezer", "room", "thawed"];

/**
 * Storage windows — AFSSA 2005, the French official guidance.
 *
 * Deliberately the conservative end of the published range: CoFAM 2024 allows 8 days in the
 * fridge and 12 months frozen, ABM 2017 sits between the two. THIS IS THE ONE PLACE to
 * adjust if a pediatrician gives different numbers.
 *
 * Applies to full-term healthy infants at home. The durations are NOT cumulative — milk
 * that spent two days in the fridge does not then get a fresh four months in the freezer.
 * We show the new window on a move (below) without pretending the milk became fresh again.
 *
 * The freezer window is in CALENDAR months, not a fixed span: milk frozen on 6 Oct at 09:01
 * is good until 6 Feb at 09:01 local time — the date a parent would work out themselves. A
 * flat 120 days landed on a different day, and an hour off once winter time had kicked in.
 */
export const STORAGE_WINDOW: Record<StashLocation, { hours: number } | { months: number }> = {
  room: { hours: 4 }, //     flat, since we can't know the ambient temperature
  fridge: { hours: 48 },
  freezer: { months: 4 },
  thawed: { hours: 24 }, //  and never refreeze
};

/** Longest a window can run, in ms — a month counted as 31 days so it never falls short. */
function maxWindowMs(loc: StashLocation): number {
  const w = STORAGE_WINDOW[loc];
  return "hours" in w ? w.hours * 3_600_000 : w.months * 31 * 86_400_000;
}

/** How far back the stash query has to reach to see everything still drinkable: the longest
 *  window, padded so a bottle never falls out of the query while it's still good. */
export const STASH_LOOKBACK_DAYS = Math.ceil(maxWindowMs("freezer") / 86_400_000) + 7;

export interface StashInfo {
  loc: StashLocation;
  /** Epoch ms the milk entered `loc` — the clock restarts on every move. */
  at: number;
  state: StashState;
  /** Whatever the caregiver actually typed, with the machine prefix stripped. */
  note: string;
}

const PREFIX_RE = /^\[stash ([^\]]*)\]\s?([\s\S]*)$/;

function isLocation(v: string): v is StashLocation {
  return (STASH_LOCATIONS as string[]).includes(v);
}
function isState(v: string): v is StashState {
  return v === "stored" || v === "used" || v === "discarded";
}

/**
 * Read the stash state out of a Pumping entry's `notes`. Returns `null` when the note has no
 * stash prefix — an entry logged by Baby Buddy's own UI, by another client, or before this
 * feature existed. Callers treat `null` as "untracked", never as an error.
 */
export function decodeStashNotes(notes: string | null | undefined): StashInfo | null {
  const m = PREFIX_RE.exec(notes ?? "");
  if (!m) return null;
  let loc: StashLocation | null = null;
  let at: number | null = null;
  let state: StashState = "stored";
  for (const pair of m[1].trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key === "loc" && isLocation(value)) loc = value;
    else if (key === "state" && isState(value)) state = value;
    else if (key === "at") {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) at = ms;
    }
  }
  // A prefix missing its location or timestamp can't be reasoned about — treat the whole
  // note as human text rather than inventing a default that would fake an expiry date.
  if (loc == null || at == null) return null;
  return { loc, at, state, note: m[2] };
}

/** Write the stash state back into `notes`, preserving the caregiver's own text. */
export function encodeStashNotes(info: StashInfo): string {
  const at = new Date(info.at).toISOString();
  const prefix = `[stash loc=${info.loc} at=${at} state=${info.state}]`;
  return info.note ? `${prefix} ${info.note}` : prefix;
}

/** Fresh milk goes to the fridge unless told otherwise — the overwhelmingly common case. */
export function newStash(loc: StashLocation, at: number, note = ""): StashInfo {
  return { loc, at, state: "stored", note };
}

/** Move to another location. The window restarts from now — see the non-cumulative caveat. */
export function moveStash(info: StashInfo, loc: StashLocation, now: number): StashInfo {
  return { ...info, loc, at: now };
}

export function expiresAt(info: StashInfo): number {
  const w = STORAGE_WINDOW[info.loc];
  if ("hours" in w) return info.at + w.hours * 3_600_000;
  // Same local wall-clock time, N months on. Clamped to the month's last day, so 31 Oct
  // gives 28 Feb rather than JavaScript's overflow into early March.
  const d = new Date(info.at);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + w.months);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.getTime();
}

export function isExpired(info: StashInfo, now: number): boolean {
  return info.state === "stored" && now >= expiresAt(info);
}

/** Still drinkable: kept, and not past its window. */
export function isAvailable(info: StashInfo, now: number): boolean {
  return info.state === "stored" && now < expiresAt(info);
}

/**
 * Used or thrown away — the bottle is gone, but the SESSION still happened. Pumping to
 * discard (after a drink, or a medication that isn't feed-safe) is an ordinary reason to
 * express, and the volume still counts toward supply, so these entries are never deleted.
 */
export function isSpent(info: StashInfo): boolean {
  return info.state !== "stored";
}

/** A Pumping entry paired with its decoded stash state (`null` when untracked). */
export interface StashBottle {
  id: number;
  amount: number;
  /** When it was expressed — the entry's `end`, falling back to `start`. */
  pumpedMs: number;
  stash: StashInfo | null;
  /** The server's `notes` verbatim. Kept so an optimistic overlay can tell whether the
   *  server has caught up with a queued change and stand down once it has. */
  notes: string | null;
}

export function toBottle(p: Pumping): StashBottle | null {
  if (p.id == null) return null;
  const pumpedMs = Date.parse(p.end ?? p.start ?? "");
  if (Number.isNaN(pumpedMs)) return null;
  const notes = p.notes ?? null;
  return { id: p.id, amount: p.amount ?? 0, pumpedMs, stash: decodeStashNotes(notes), notes };
}

/** A bottle we know the whereabouts of — the only kind the stash can reason about. */
export type TrackedBottle = StashBottle & { stash: StashInfo };

/**
 * Current inventory, soonest to turn first — the order that answers "what do I use next".
 * Untracked bottles (no stash prefix) and spent ones are left out: the list is what's
 * actually available to feed.
 */
export function availableBottles(bottles: StashBottle[], now: number): TrackedBottle[] {
  return bottles
    .filter((b): b is TrackedBottle => b.stash != null && isAvailable(b.stash, now))
    .sort((a, b) => expiresAt(a.stash) - expiresAt(b.stash));
}

/**
 * How close to lapsing counts as "use this now". Milk thrown away is milk expressed for
 * nothing, so this crosses over from the stash screen onto Home — the one place a
 * sleep-deprived parent actually looks.
 */
const SOON_CAP_MS = 4 * 3_600_000;

/**
 * The warning window for a location, never more than half its storage window.
 *
 * A flat 4 h would make room-temperature milk urgent from the instant it's logged — its whole
 * window is 4 h — so the alert could never be in its "not urgent" state, which trains you to
 * ignore it everywhere else. Scaling it keeps the warning meaning "act soon" rather than
 * "this exists": 2 h for room, 4 h for fridge, freezer and thawed.
 */
export function soonThresholdMs(loc: StashLocation): number {
  return Math.min(SOON_CAP_MS, maxWindowMs(loc) / 2);
}

/**
 * How long before the fridge deadline to start pushing the freezer. Wider than the 4 h
 * "use it now" warning on purpose: that one fires when it's already about drinking the
 * bottle, while freezing is a decision for the last half-day — late enough not to nag about
 * milk you're about to use anyway, early enough that a night's sleep can't swallow it.
 */
const SUGGEST_FREEZE_MS = 12 * 3_600_000;

/** A fridge bottle nearing its deadline, which the freezer would still save. */
export function shouldSuggestFreezing(stash: StashInfo, now: number): boolean {
  return stash.state === "stored" && stash.loc === "fridge" && now < expiresAt(stash) && expiresAt(stash) - now <= SUGGEST_FREEZE_MS;
}

/** True once a bottle is inside its own warning window. */
export function isExpiringSoon(stash: StashInfo, now: number): boolean {
  return expiresAt(stash) - now <= soonThresholdMs(stash.loc);
}

/** Bottles inside their warning window, soonest first. Empty when there's no hurry. */
export function expiringSoon(bottles: StashBottle[], now: number): TrackedBottle[] {
  return availableBottles(bottles, now).filter((b) => isExpiringSoon(b.stash, now));
}

/** Days the supply average looks back over. */
export const SUPPLY_AVG_DAYS = 7;

/**
 * Today's pumping next to the recent daily average — the trend a pumping parent watches.
 *
 * Every session counts, whatever became of the milk: used, discarded and untracked bottles
 * were all expressed, and supply is about what came out, not what got drunk. Days are local
 * calendar days (midnight to midnight, DST-safe via Date's own arithmetic). The average covers
 * the full days BEFORE today, so a morning with one session doesn't drag it down, and it
 * only divides by days since the first session: a parent three days into pumping gets a
 * three-day average, not one diluted by four empty days that predate it. Null until there's
 * at least one full day behind.
 */
export function supplySummary(
  bottles: StashBottle[],
  now: number,
): { todayCount: number; todayMl: number; avgMl: number | null; avgDays: number } {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.getTime();
  const windowStartDate = new Date(midnight);
  windowStartDate.setDate(windowStartDate.getDate() - SUPPLY_AVG_DAYS);
  const windowStart = windowStartDate.getTime();

  const today = bottles.filter((b) => b.pumpedMs >= todayStart && b.pumpedMs <= now);
  const past = bottles.filter((b) => b.pumpedMs >= windowStart && b.pumpedMs < todayStart);

  let avgMl: number | null = null;
  let avgDays = 0;
  if (past.length > 0) {
    const first = new Date(Math.min(...past.map((b) => b.pumpedMs)));
    first.setHours(0, 0, 0, 0);
    // Calendar days from the first session's day up to today — rounded, since a DST night
    // makes the raw span 23 or 25 h short of a whole number of days.
    avgDays = Math.round((todayStart - first.getTime()) / 86_400_000);
    avgMl = Math.round(past.reduce((sum, b) => sum + b.amount, 0) / avgDays);
  }
  return { todayCount: today.length, todayMl: today.reduce((sum, b) => sum + b.amount, 0), avgMl, avgDays };
}
