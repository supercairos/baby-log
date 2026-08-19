/**
 * Duration + time-field regression tests.
 *
 * This module is deliberately i18n-free — it's reachable from the service-worker bundle —
 * so nothing here needs stubbing. The Django DurationField round-trip is the load-bearing
 * part: it's how a medication's next-dose interval survives a trip through the API.
 */
import { describe, expect, it } from "vitest";
import { fmt, hm, parseDurationMs, toDurationField, toLocalInput, fromLocalInput } from "./format";

describe("hm", () => {
  it("never renders a real span as nothing", () => {
    // A 20-second feed did happen; "0m" would read as though it hadn't.
    expect(hm(20_000)).toBe("<1m");
    expect(hm(0)).toBe("0m");
  });

  it("formats minutes and hours", () => {
    expect(hm(45 * 60_000)).toBe("45m");
    expect(hm(65 * 60_000)).toBe("1h 5m");
    expect(hm(2 * 3_600_000)).toBe("2h 0m");
  });

  it("clamps a negative span rather than emitting a minus sign", () => {
    expect(hm(-5000)).toBe("0m");
  });
});

describe("fmt", () => {
  it("drops the hour segment below an hour, so it can't be read as a clock time", () => {
    expect(fmt(65_000)).toBe("1:05");
    expect(fmt(3_665_000)).toBe("1:01:05");
  });
});

describe("Django DurationField", () => {
  it("round-trips through the wire format", () => {
    for (const ms of [0, 60_000, 4 * 3_600_000, 12 * 3_600_000 + 30 * 60_000]) {
      expect(parseDurationMs(toDurationField(ms))).toBe(ms);
    }
  });

  it("parses the day-prefixed forms another client might write", () => {
    expect(parseDurationMs("1 00:00:00")).toBe(86_400_000);
    expect(parseDurationMs("1 day, 6:00:00")).toBe(30 * 3_600_000);
    expect(parseDurationMs("04:00:00")).toBe(4 * 3_600_000);
  });

  it("keeps fractional seconds out of the result's way", () => {
    expect(parseDurationMs("00:00:01.500000")).toBe(1500);
  });

  it("returns null rather than guessing at junk", () => {
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs(null)).toBeNull();
    expect(parseDurationMs("soon")).toBeNull();
  });
});

describe("datetime-local fields", () => {
  it("round-trips local wall-clock without drifting a minute", () => {
    const ms = Date.parse("2026-08-19T21:47:00Z"); // 23:47 Paris
    expect(fromLocalInput(toLocalInput(ms))).toBe(ms);
  });

  it("renders an empty string for a cleared field instead of NaN", () => {
    expect(toLocalInput(Number.NaN)).toBe("");
  });
});
