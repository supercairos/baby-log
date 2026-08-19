/**
 * Tummy-time goal regression tests. The goal ramps with age, and only COMPLETED entries from
 * the current local day count — a running timer isn't a logged entry yet, and yesterday's
 * total must not leak into today's.
 */
import { describe, expect, it } from "vitest";
import { tummyGoalForAge, tummyProgress } from "./tummy";
import type { TimelineEntry } from "../api";

const MIN = 60_000;
const NOW = new Date(2026, 7, 20, 15, 0, 0, 0).getTime(); // 15:00 local
const MIDNIGHT = new Date(2026, 7, 20, 0, 0, 0, 0).getTime();

/** A birth date `months` before NOW, as the `YYYY-MM-DD` string the API returns. */
const bornMonthsAgo = (months: number) => {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const tummy = (startMs: number, minutes: number): TimelineEntry =>
  ({ id: startMs, activity: "tummy", path: "/api/tummy-times/", startMs, endMs: startMs + minutes * MIN, milestone: null }) as TimelineEntry;

describe("tummyGoalForAge", () => {
  it("ramps with age", () => {
    expect(tummyGoalForAge(bornMonthsAgo(0), NOW)).toBe(20);
    expect(tummyGoalForAge(bornMonthsAgo(2), NOW)).toBe(30);
    expect(tummyGoalForAge(bornMonthsAgo(3), NOW)).toBe(45);
    expect(tummyGoalForAge(bornMonthsAgo(6), NOW)).toBe(60);
  });

  it("falls back to a middle target when the age is unknown", () => {
    expect(tummyGoalForAge(null, NOW)).toBe(30);
    expect(tummyGoalForAge(undefined, NOW)).toBe(30);
  });
});

describe("tummyProgress", () => {
  it("sums only today's completed entries", () => {
    const p = tummyProgress(
      [
        tummy(MIDNIGHT + 10 * 3_600_000, 8), // today
        tummy(MIDNIGHT + 12 * 3_600_000, 7), // today
        tummy(MIDNIGHT - 4 * 3_600_000, 30), // yesterday evening — must not count
      ],
      bornMonthsAgo(0),
      NOW,
    );
    expect(p.todayMs).toBe(15 * MIN);
    expect(p.goalMin).toBe(20);
    expect(p.metGoal).toBe(false);
  });

  it("ignores a running timer, which is not a logged entry yet", () => {
    const running = { id: 1, activity: "tummy", path: "/api/tummy-times/", startMs: MIDNIGHT + 9 * 3_600_000, endMs: null } as TimelineEntry;
    expect(tummyProgress([running], bornMonthsAgo(0), NOW).todayMs).toBe(0);
  });

  it("marks the goal met once reached", () => {
    const p = tummyProgress([tummy(MIDNIGHT + 9 * 3_600_000, 20)], bornMonthsAgo(0), NOW);
    expect(p.metGoal).toBe(true);
  });

  it("counts nothing when there is no tummy time", () => {
    const p = tummyProgress([], bornMonthsAgo(1), NOW);
    expect(p.todayMs).toBe(0);
    expect(p.metGoal).toBe(false);
  });
});
