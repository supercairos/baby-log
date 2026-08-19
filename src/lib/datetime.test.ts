/**
 * Date display regression tests.
 *
 * `currentLocale` is stubbed rather than left to the machine: every assertion below runs
 * through `toLocaleString`, so without this the suite would pass in Paris and fail in CI.
 * The timezone is pinned in vitest.config.ts for the same reason — these are all questions
 * about LOCAL day boundaries.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({
  default: { t: (key: string) => key },
  currentLocale: () => "fr-FR",
}));

const { deadlineTime, shortDateTime } = await import("./datetime");

const at = (s: string) => Date.parse(s);

describe("deadlineTime", () => {
  it("shows a bare clock time while the deadline is today", () => {
    const now = new Date(at("2026-08-19T20:00:00Z")); // 22:00 Paris
    expect(deadlineTime(at("2026-08-19T21:47:00Z"), now)).toBe("23:47");
  });

  it("adds the date once the deadline crosses midnight", () => {
    // The bug: at 23:15 a deadline of 01:15 rendered as a bare "1:15", which reads as a time
    // that has already been and gone — on the one row that exists to say "use this before X".
    const now = new Date(at("2026-08-19T21:15:00Z")); // 23:15 Paris
    const label = deadlineTime(at("2026-08-19T23:15:00Z"), now); // 01:15 Paris, next day
    expect(label).toContain("20/08");
    expect(label).not.toBe("01:15");
  });

  it("switches on the LOCAL day, not the UTC one", () => {
    // 22:30 UTC is already the next day in Paris; a UTC-based check would get this wrong.
    const now = new Date(at("2026-08-19T21:00:00Z")); // 23:00 Paris, 19th
    expect(deadlineTime(at("2026-08-19T22:30:00Z"), now)).toContain("20/08"); // 00:30 Paris, 20th
  });
});

describe("shortDateTime", () => {
  it("omits the year within the current year", () => {
    const now = new Date(at("2026-08-19T12:00:00Z"));
    expect(shortDateTime(at("2026-12-13T08:00:00Z"), now)).not.toContain("2026");
  });

  it("shows the year once it differs", () => {
    // Frozen milk keeps four months, so a freezer expiry routinely crosses New Year — and
    // "19/04" on a bottle frozen in December reads as a date already past.
    const now = new Date(at("2026-12-20T12:00:00Z"));
    expect(shortDateTime(at("2027-04-19T08:00:00Z"), now)).toContain("2027");
  });

  it("keeps day and month zero-padded so rows line up", () => {
    const now = new Date(at("2026-08-19T12:00:00Z"));
    expect(shortDateTime(at("2026-08-05T08:00:00Z"), now)).toMatch(/^05\/08/);
  });
});
