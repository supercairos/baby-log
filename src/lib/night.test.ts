/**
 * Last-night recap regression tests.
 *
 * The interesting behaviour is the CHAINING rule: consecutive sleep segments belong to the
 * same night, and the gap allowed between them widens when a feed or change sits in it —
 * because a night feed routinely takes 45–90 min before baby settles again, and that's still
 * the same night rather than the start of the morning.
 */
import { describe, expect, it } from "vitest";
import { lastNight } from "./night";
import type { TimelineEntry } from "../api";

const MIN = 60_000;
const H = 3_600_000;

/** Local midnight on the 20th, so every offset below reads as a wall-clock time. */
const MIDNIGHT = new Date(2026, 7, 20, 0, 0, 0, 0).getTime();
const NOW = MIDNIGHT + 9 * H; // 09:00

const sleep = (startMs: number, endMs: number): TimelineEntry =>
  ({ id: startMs, activity: "sleep", path: "/api/sleep/", startMs, endMs, nap: false, notes: null }) as TimelineEntry;

const feed = (startMs: number): TimelineEntry =>
  ({
    id: startMs, activity: "feeding", path: "/api/feedings/",
    startMs, endMs: startMs + 20 * MIN, type: "breast milk", method: "both breasts", amount: null, notes: null,
  }) as TimelineEntry;

describe("lastNight", () => {
  it("returns nothing when no sleep was logged", () => {
    expect(lastNight([], NOW)).toBeNull();
    expect(lastNight([feed(MIDNIGHT - 2 * H)], NOW)).toBeNull();
  });

  it("summarises a single unbroken night", () => {
    const n = lastNight([sleep(MIDNIGHT - 2 * H, MIDNIGHT + 7 * H)], NOW)!;
    expect(n.startMs).toBe(MIDNIGHT - 2 * H); // 22:00
    expect(n.endMs).toBe(MIDNIGHT + 7 * H); // 07:00
    expect(n.sleepMs).toBe(9 * H);
    expect(n.wakings).toBe(0);
  });

  it("chains segments split by a short waking and counts it", () => {
    const n = lastNight(
      [sleep(MIDNIGHT - 2 * H, MIDNIGHT + 2 * H), sleep(MIDNIGHT + 2 * H + 20 * MIN, MIDNIGHT + 7 * H)],
      NOW,
    )!;
    expect(n.wakings).toBe(1);
    expect(n.startMs).toBe(MIDNIGHT - 2 * H);
    expect(n.endMs).toBe(MIDNIGHT + 7 * H);
    // The 20-minute gap is a waking, not sleep — it must not be counted as time asleep.
    expect(n.sleepMs).toBe(9 * H - 20 * MIN);
  });

  it("keeps chaining across a long gap when a feed explains it", () => {
    // 75 min is past the plain chaining limit, but a logged feed inside it means the night
    // continued rather than ended.
    const gapStart = MIDNIGHT + 2 * H;
    const n = lastNight(
      [sleep(MIDNIGHT - 2 * H, gapStart), feed(gapStart + 10 * MIN), sleep(gapStart + 75 * MIN, MIDNIGHT + 7 * H)],
      NOW,
    )!;
    expect(n.endMs).toBe(MIDNIGHT + 7 * H);
    expect(n.wakings).toBe(1);
  });

  it("does not absorb a later nap into the night", () => {
    // A morning nap sits past the wake window; counting it would inflate the night.
    const n = lastNight(
      [sleep(MIDNIGHT - 2 * H, MIDNIGHT + 6 * H), sleep(MIDNIGHT + 8 * H, MIDNIGHT + 8 * H + 30 * MIN)],
      NOW,
    )!;
    expect(n.endMs).toBe(MIDNIGHT + 6 * H);
  });

  it("ignores a sleep that has not finished yet", () => {
    // A running timer has no end; it must not be treated as a completed night.
    const open = { id: 1, activity: "sleep", path: "/api/sleep/", startMs: MIDNIGHT - 2 * H, endMs: null } as TimelineEntry;
    expect(lastNight([open], NOW)).toBeNull();
  });
});
