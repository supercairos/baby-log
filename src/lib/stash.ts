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
 * We show the new window on a move (below) without pretending the milk became fresh again;
 * the UI carries the caveat.
 */
export const STORAGE_WINDOW_MS: Record<StashLocation, number> = {
  room: 4 * 3_600_000, //         4 h — flat, since we can't know the ambient temperature
  fridge: 48 * 3_600_000, //     48 h
  freezer: 120 * 86_400_000, //   4 months (120 d)
  thawed: 24 * 3_600_000, //     24 h — and never refreeze
};

/** How far back the stash query has to reach to see everything still drinkable: the longest
 *  window, padded so a bottle never falls out of the query while it's still good. */
export const STASH_LOOKBACK_DAYS = Math.ceil(STORAGE_WINDOW_MS.freezer / 86_400_000) + 7;

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
  return info.at + STORAGE_WINDOW_MS[info.loc];
}

export function isExpired(info: StashInfo, now: number): boolean {
  return info.state === "stored" && now >= expiresAt(info);
}

/** Still drinkable: kept, and not past its window. */
export function isAvailable(info: StashInfo, now: number): boolean {
  return info.state === "stored" && now < expiresAt(info);
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
  return Math.min(SOON_CAP_MS, STORAGE_WINDOW_MS[loc] / 2);
}

/** True once a bottle is inside its own warning window. */
export function isExpiringSoon(stash: StashInfo, now: number): boolean {
  return expiresAt(stash) - now <= soonThresholdMs(stash.loc);
}

/** Bottles inside their warning window, soonest first. Empty when there's no hurry. */
export function expiringSoon(bottles: StashBottle[], now: number): TrackedBottle[] {
  return availableBottles(bottles, now).filter((b) => isExpiringSoon(b.stash, now));
}
