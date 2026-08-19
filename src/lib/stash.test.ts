/**
 * Milk stash regression tests.
 *
 * Every bug this feature shipped lived here or in what reads it, so these are deliberately
 * the cases that actually went wrong rather than a mechanical pass over the API: a human
 * note destroyed by a state change, an expiry derived from the wrong timestamp, a warning
 * threshold that could never turn off, and a lapsed bottle quietly dropping off the list.
 */
import { describe, expect, it } from "vitest";
import {
  STASH_LOOKBACK_DAYS,
  STORAGE_WINDOW_MS,
  availableBottles,
  decodeStashNotes,
  encodeStashNotes,
  expiresAt,
  expiringSoon,
  isAvailable,
  isExpired,
  isExpiringSoon,
  isSpent,
  moveStash,
  newStash,
  soonThresholdMs,
  toBottle,
  type StashBottle,
  type StashInfo,
} from "./stash";

const H = 3_600_000;
const D = 86_400_000;
const AT = Date.parse("2026-08-15T08:00:00.000Z");

const stash = (over: Partial<StashInfo> = {}): StashInfo => ({
  loc: "fridge",
  at: AT,
  state: "stored",
  note: "",
  ...over,
});

const bottle = (over: Partial<StashBottle> = {}): StashBottle => {
  const s = over.stash === undefined ? stash() : over.stash;
  return {
    id: 1,
    amount: 100,
    pumpedMs: AT,
    stash: s,
    notes: s ? encodeStashNotes(s) : null,
    ...over,
  };
};

describe("storage windows", () => {
  // These are AFSSA 2005 — the conservative end of French guidance, chosen deliberately over
  // CoFAM 2024's 8 days / 12 months. Pinned because a silent change here would quietly extend
  // how long the app claims milk is safe to feed.
  it("are the AFSSA 2005 figures", () => {
    expect(STORAGE_WINDOW_MS.room).toBe(4 * H);
    expect(STORAGE_WINDOW_MS.fridge).toBe(48 * H);
    expect(STORAGE_WINDOW_MS.freezer).toBe(120 * D);
    expect(STORAGE_WINDOW_MS.thawed).toBe(24 * H);
  });

  it("reach back far enough to cover the longest window", () => {
    // Frozen milk keeps four months; the query must not lose a bottle that's still drinkable.
    expect(STASH_LOOKBACK_DAYS * D).toBeGreaterThan(STORAGE_WINDOW_MS.freezer);
  });
});

describe("notes codec", () => {
  it("round-trips and keeps the parent's own text", () => {
    const info = stash({ note: "left side sore" });
    const decoded = decodeStashNotes(encodeStashNotes(info));
    expect(decoded).toEqual(info);
  });

  it("keeps the human half when the machine half changes", () => {
    // The bug this guards: marking a bottle used rewrote `notes` wholesale and took the
    // caregiver's text with it.
    const encoded = encodeStashNotes(stash({ note: "power pump" }));
    const after = encodeStashNotes({ ...decodeStashNotes(encoded)!, state: "used" });
    expect(decodeStashNotes(after)!.note).toBe("power pump");
    expect(decodeStashNotes(after)!.state).toBe("used");
  });

  it("survives a note containing brackets", () => {
    const info = stash({ note: "took [both] sides" });
    expect(decodeStashNotes(encodeStashNotes(info))!.note).toBe("took [both] sides");
  });

  it("emits no trailing space when there is no note", () => {
    expect(encodeStashNotes(stash())).not.toMatch(/\s$/);
  });

  it("treats an entry with no prefix as untracked, not as an error", () => {
    // Written by Baby Buddy's own UI, or before this feature existed. The app must leave it
    // alone rather than invent a location for it.
    expect(decodeStashNotes("just a note")).toBeNull();
    expect(decodeStashNotes("")).toBeNull();
    expect(decodeStashNotes(null)).toBeNull();
    expect(decodeStashNotes(undefined)).toBeNull();
  });

  it("refuses a prefix missing its location or timestamp", () => {
    // Half a prefix can't be reasoned about; defaulting would fake an expiry date.
    expect(decodeStashNotes("[stash state=stored] x")).toBeNull();
    expect(decodeStashNotes("[stash loc=fridge state=stored] x")).toBeNull();
    expect(decodeStashNotes("[stash loc=nowhere at=2026-08-15T08:00:00.000Z] x")).toBeNull();
    expect(decodeStashNotes("[stash loc=fridge at=not-a-date] x")).toBeNull();
  });

  it("defaults a missing state to stored", () => {
    expect(decodeStashNotes(`[stash loc=fridge at=${new Date(AT).toISOString()}]`)!.state).toBe("stored");
  });
});

describe("expiry", () => {
  it("is derived from the location's own clock, not the pump time", () => {
    expect(expiresAt(stash({ loc: "fridge" }))).toBe(AT + 48 * H);
    expect(expiresAt(stash({ loc: "room" }))).toBe(AT + 4 * H);
    expect(expiresAt(stash({ loc: "freezer" }))).toBe(AT + 120 * D);
    expect(expiresAt(stash({ loc: "thawed" }))).toBe(AT + 24 * H);
  });

  it("lapses exactly at the boundary, not a moment later", () => {
    const s = stash();
    expect(isExpired(s, AT + 48 * H - 1)).toBe(false);
    expect(isExpired(s, AT + 48 * H)).toBe(true);
  });

  it("restarts the clock on a move without touching the rest", () => {
    const moved = moveStash(stash({ note: "keep me" }), "freezer", AT + 10 * H);
    expect(moved.at).toBe(AT + 10 * H);
    expect(moved.loc).toBe("freezer");
    expect(moved.note).toBe("keep me");
    expect(expiresAt(moved)).toBe(AT + 10 * H + 120 * D);
  });

  it("reports a spent bottle as neither available nor expired", () => {
    // A used bottle is gone; calling it "expired" would put it in the bin-this-now group.
    const used = stash({ state: "used" });
    expect(isSpent(used)).toBe(true);
    expect(isAvailable(used, AT)).toBe(false);
    expect(isExpired(used, AT + 100 * H)).toBe(false);
  });
});

describe("the soon-to-expire threshold", () => {
  it("scales to the window so it can be off for every location", () => {
    // The bug: a flat 4 h equalled the room-temperature window exactly, so room-temp milk was
    // flagged in danger red from the instant it was logged and the alert could never rest.
    expect(soonThresholdMs("room")).toBe(2 * H);
    expect(soonThresholdMs("fridge")).toBe(4 * H);
    expect(soonThresholdMs("freezer")).toBe(4 * H);
    expect(soonThresholdMs("thawed")).toBe(4 * H);
  });

  it("leaves a freshly stored room-temp bottle un-flagged", () => {
    const s = stash({ loc: "room" });
    expect(isExpiringSoon(s, AT)).toBe(false);
    expect(isExpiringSoon(s, AT + 2 * H)).toBe(true);
  });

  it("never exceeds half the window", () => {
    for (const loc of ["room", "fridge", "freezer", "thawed"] as const) {
      expect(soonThresholdMs(loc)).toBeLessThanOrEqual(STORAGE_WINDOW_MS[loc] / 2);
    }
  });
});

describe("inventory selection", () => {
  it("orders by soonest to turn, not by when it was pumped", () => {
    const frozen = bottle({ id: 1, stash: stash({ loc: "freezer" }) });
    const chilled = bottle({ id: 2, stash: stash({ loc: "fridge" }) });
    const out = bottle({ id: 3, stash: stash({ loc: "room" }) });
    expect(availableBottles([frozen, chilled, out], AT).map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it("excludes untracked, spent and lapsed bottles", () => {
    const list = [
      bottle({ id: 1, stash: null, notes: "plain note" }),
      bottle({ id: 2, stash: stash({ state: "used" }) }),
      bottle({ id: 3, stash: stash({ state: "discarded" }) }),
      bottle({ id: 4, stash: stash({ at: AT - 50 * H }) }),
      bottle({ id: 5 }),
    ];
    expect(availableBottles(list, AT).map((b) => b.id)).toEqual([5]);
  });

  it("only warns about bottles inside their own window", () => {
    const soon = bottle({ id: 1, stash: stash({ at: AT - 45 * H }) }); // 3 h left of 48
    const later = bottle({ id: 2, stash: stash({ at: AT - 10 * H }) }); // 38 h left
    expect(expiringSoon([soon, later], AT).map((b) => b.id)).toEqual([1]);
  });

  it("drops a bottle from the warning the moment it lapses", () => {
    // Home relies on this: `expiringSoon` going empty is what hands over to the
    // already-expired row, so the warning never silently disappears instead.
    const b = bottle({ stash: stash({ at: AT - 48 * H }) });
    expect(expiringSoon([b], AT)).toEqual([]);
    expect(isExpired(b.stash!, AT)).toBe(true);
  });
});

describe("toBottle", () => {
  it("dates the bottle by when the session ENDED", () => {
    // Not `start`: the milk went in the fridge when pumping finished.
    const b = toBottle({
      id: 7,
      amount: 120,
      start: "2026-08-15T07:40:00.000Z",
      end: "2026-08-15T08:00:00.000Z",
      notes: encodeStashNotes(stash()),
    } as never);
    expect(b!.pumpedMs).toBe(AT);
    expect(b!.amount).toBe(120);
    expect(b!.stash!.loc).toBe("fridge");
  });

  it("falls back to start when there is no end", () => {
    const b = toBottle({ id: 8, amount: 60, start: "2026-08-15T08:00:00.000Z", notes: null } as never);
    expect(b!.pumpedMs).toBe(AT);
    expect(b!.stash).toBeNull();
  });

  it("rejects a row it cannot place in time", () => {
    expect(toBottle({ id: 9, amount: 60, notes: null } as never)).toBeNull();
    expect(toBottle({ amount: 60, start: "2026-08-15T08:00:00.000Z" } as never)).toBeNull();
  });
});

describe("newStash", () => {
  it("starts stored, at the moment given", () => {
    const s = newStash("freezer", AT, "note");
    expect(s).toEqual({ loc: "freezer", at: AT, state: "stored", note: "note" });
  });
});
