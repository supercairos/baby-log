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
 * BAGS ("Regrouper" in the UI — never "bag": crèches refuse storage bags). Fridge bottles
 * are often poured together into one bottle before freezing. Each session stays its own
 * entry with its own volume (supply counts what was expressed, so a new "bag" entry would
 * count it twice); they just share `bag=<id of the oldest>` and move as one from then on.
 *
 *   [stash loc=freezer at=2026-10-12T07:30:00.000Z state=stored bag=1760254200000]
 *
 * The bag id is the moment it was formed: unique, and it can't collide when the rest of one
 * session goes into a second bag later. (Bags formed before partial pours were named after
 * their oldest session's id — any number works, it's only ever compared for equality.)
 *
 * PARTIAL POURS. Only part of a bottle may go into the combined one — the rest stays in the
 * fridge for the next feed. That's one session in two containers, so the note carries one
 * record per container: the first is the session itself (holding whatever wasn't poured
 * off), each following one a poured portion with its own volume.
 *
 *   [stash loc=fridge at=… state=stored][stash loc=freezer at=… state=stored bag=… ml=60] note
 *
 * Splitting the entry instead would rewrite the session log (two sessions where there was
 * one, amounts that were never pumped) to describe what happened to the milk afterwards.
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
 * So the freezer's months run from when the milk was EXPRESSED, not from when it went in:
 * a bottle pumped Saturday night and frozen Monday is good until the Saturday four months
 * on, as a parent counting from the date on the bag would expect. The short windows (room,
 * fridge, thawed) do restart on a move — they're about the bottle's current conditions.
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
  /** Epoch ms the milk was expressed — the freezer's clock (see `STORAGE_WINDOW`). Not
   *  encoded: it's the entry's own end time, attached on read. Absent, `at` stands in. */
  pumpedAt?: number;
  /** Shared by every bottle poured into the same combined one — see the header. */
  bag?: number;
  /** Volume of a poured-off portion. Set on the records in `portions` only. */
  ml?: number;
  /** Portions of this session poured off into combined bottles; whatever wasn't poured off
   *  stays with this record. Main record only, and absent when nothing was poured off. */
  portions?: StashInfo[];
}

const PREFIX_RE = /^\[stash ([^\]]*)\]/;

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
export function decodeStashNotes(notes: string | null | undefined, pumpedAt?: number): StashInfo | null {
  let rest = notes ?? "";
  const records: Omit<StashInfo, "note">[] = [];
  for (let m = PREFIX_RE.exec(rest); m; m = PREFIX_RE.exec(rest)) {
    const r = decodeRecord(m[1]);
    // A prefix missing its location or timestamp can't be reasoned about — treat the whole
    // note as human text rather than inventing a default that would fake an expiry date.
    if (r == null && records.length === 0) return null;
    // A portion that can't be read is dropped from view but stays in the text it came from,
    // so stop there: everything from it on is kept verbatim as the human half.
    if (r == null || (records.length > 0 && r.ml == null)) break;
    records.push(r);
    rest = rest.slice(m[0].length);
  }
  if (records.length === 0) return null;
  const note = rest.replace(/^\s/, "");
  const [main, ...portions] = records;
  return {
    ...main,
    note,
    pumpedAt,
    ...(portions.length > 0 ? { portions: portions.map((p) => ({ ...p, note, pumpedAt })) } : {}),
  };
}

function decodeRecord(body: string): Omit<StashInfo, "note"> | null {
  let loc: StashLocation | null = null;
  let at: number | null = null;
  let state: StashState = "stored";
  let bag: number | undefined;
  let ml: number | undefined;
  for (const pair of body.trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key === "loc" && isLocation(value)) loc = value;
    else if (key === "state" && isState(value)) state = value;
    else if (key === "bag" && /^\d+$/.test(value)) bag = Number(value);
    else if (key === "ml" && /^\d+$/.test(value)) ml = Number(value);
    else if (key === "at") {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) at = ms;
    }
  }
  if (loc == null || at == null) return null;
  return { loc, at, state, ...(bag != null ? { bag } : {}), ...(ml != null ? { ml } : {}) };
}

/** Write the stash state back into `notes`, preserving the caregiver's own text. */
export function encodeStashNotes(info: StashInfo): string {
  const record = (r: StashInfo, ml?: number) => {
    const bag = r.bag != null ? ` bag=${r.bag}` : "";
    return `[stash loc=${r.loc} at=${new Date(r.at).toISOString()} state=${r.state}${bag}${ml != null ? ` ml=${ml}` : ""}]`;
  };
  const prefix = record(info) + (info.portions ?? []).map((p) => record(p, p.ml ?? 0)).join("");
  return info.note ? `${prefix} ${info.note}` : prefix;
}

/** A freshly pumped bottle: `at` is when it was expressed, so it's the pumping time too. */
export function newStash(loc: StashLocation, at: number, note = ""): StashInfo {
  return { loc, at, state: "stored", note, pumpedAt: at };
}

/** Move to another location. `at` restarts from now, but a freezer window still counts from
 *  `pumpedAt` — see the non-cumulative caveat on `STORAGE_WINDOW`. */
export function moveStash(info: StashInfo, loc: StashLocation, now: number): StashInfo {
  return { ...info, loc, at: now };
}

export function expiresAt(info: StashInfo): number {
  const w = STORAGE_WINDOW[info.loc];
  if ("hours" in w) return info.at + w.hours * 3_600_000;
  // Same local wall-clock time, N months on from when it was pumped (never later than it
  // went in, should a backdated entry disagree). Clamped to the month's last day, so 31 Oct
  // gives 28 Feb rather than JavaScript's overflow into early March.
  const d = new Date(Math.min(info.at, info.pumpedAt ?? info.at));
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
  /** Set on a bag (see `groupBags`): the sessions poured into it, oldest first. A write to
   *  the bag is a write to each of them. */
  members?: StashBottle[];
  /** Set on a poured-off portion (see `splitPortions`): its index in the session's
   *  `portions`. `stash` is then the portion's own record, and `entry` the session's. */
  part?: number;
  entry?: StashInfo;
  /** The whole session's volume, when this item is only one container of it. */
  sessionAmount?: number;
}

/** Unique per physical container — a session and the portions poured off it share an id. */
export function bottleKey(b: StashBottle): string {
  if (b.members != null && b.stash != null) return `bag${b.stash.bag}.${b.stash.loc}.${b.stash.state}`;
  return b.part == null ? String(b.id) : `${b.id}.${b.part}`;
}

/**
 * One item per container: a session with portions poured off becomes the rest of it plus
 * one item per portion. The rest disappears once nothing is left of it (an amount edited
 * down below what was poured off).
 */
export function splitPortions(bottles: StashBottle[]): StashBottle[] {
  return bottles.flatMap((b) => {
    const portions = b.stash?.portions;
    if (b.stash == null || portions == null || portions.length === 0) return [b];
    const entry = b.stash;
    const rest = b.amount - portions.reduce((sum, p) => sum + (p.ml ?? 0), 0);
    const parts = portions.map((p, i) => ({
      ...b,
      amount: p.ml ?? 0,
      sessionAmount: b.amount,
      stash: { ...p, note: entry.note, pumpedAt: entry.pumpedAt },
      part: i,
      entry,
    }));
    return rest > 0 ? [{ ...b, amount: rest, sessionAmount: b.amount }, ...parts] : parts;
  });
}

export function toBottle(p: Pumping): StashBottle | null {
  if (p.id == null) return null;
  const pumpedMs = Date.parse(p.end ?? p.start ?? "");
  if (Number.isNaN(pumpedMs)) return null;
  const notes = p.notes ?? null;
  return { id: p.id, amount: p.amount ?? 0, pumpedMs, stash: decodeStashNotes(notes, pumpedMs), notes };
}

/**
 * Split off the poured portions (see `splitPortions`), then fold the sessions of each bag into one item: summed volume, and the earliest `at` and
 * `pumpedAt` of its members, so the bag turns when its oldest milk does — the standard rule
 * for mixed milk. Members only group while they agree on location and state: a write that
 * reached one session but not yet the other shows as two rows rather than a bag that lies.
 */
export function groupBags(bottles: StashBottle[]): StashBottle[] {
  const groups = new Map<string, StashBottle[]>();
  const out: (StashBottle | string)[] = [];
  for (const b of splitPortions(bottles)) {
    if (b.stash?.bag == null) {
      out.push(b);
      continue;
    }
    const key = `${b.stash.bag}|${b.stash.loc}|${b.stash.state}`;
    const list = groups.get(key);
    if (list) list.push(b);
    else {
      groups.set(key, [b]);
      out.push(key);
    }
  }
  return out.map((item) => {
    if (typeof item !== "string") return item;
    const members = groups.get(item)!.sort((a, b) => a.pumpedMs - b.pumpedMs);
    const first = members[0];
    const stash = first.stash!;
    return {
      id: first.id,
      amount: members.reduce((sum, m) => sum + m.amount, 0),
      pumpedMs: first.pumpedMs,
      notes: null,
      members,
      stash: {
        ...stash,
        at: Math.min(...members.map((m) => m.stash!.at)),
        pumpedAt: Math.min(...members.map((m) => m.stash!.pumpedAt ?? m.stash!.at)),
      },
    };
  });
}

/** Can go into a new bag: fridge milk still on offer. Room milk is chilled first — fresh
 *  milk is cooled before it's added to cold milk — and frozen milk is never mixed. */
export function canBag(b: StashBottle, now: number): b is TrackedBottle {
  return b.stash != null && b.stash.loc === "fridge" && isAvailable(b.stash, now);
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
