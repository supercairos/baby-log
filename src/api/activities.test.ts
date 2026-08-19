/**
 * Activity registry regression tests.
 *
 * Timer names are a CONTRACT — with the Home Assistant buttons, and with whatever version of
 * this app the other caregiver is running. The rules that matter: an unknown name is left
 * completely alone (a newer client may be running a timer type this build doesn't know), and
 * the "|" suffix that carries a feeding's side across devices round-trips both the format
 * this app writes and the shorter one the HA buttons write.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVITIES,
  METHODS_FOR_TYPE,
  TIMER_NAMES,
  classifyTimerName,
  feedingFromName,
  feedingTimerName,
  type ActivityKey,
  type FeedingType,
} from "./activities";

describe("classifyTimerName", () => {
  it("recognises the names this app writes", () => {
    for (const [activity, name] of Object.entries(TIMER_NAMES)) {
      expect(classifyTimerName(name)).toBe(activity);
    }
  });

  it("matches forgivingly on case and padding", () => {
    expect(classifyTimerName("  TUMMY TIME  ")).toBe("tummy");
    expect(classifyTimerName("Nap")).toBe("sleep");
    expect(classifyTimerName("feed")).toBe("feeding");
  });

  it("resolves the French pump names the HA buttons use", () => {
    expect(classifyTimerName("tire-lait")).toBe("pumping");
    expect(classifyTimerName("Tirage")).toBe("pumping");
    expect(classifyTimerName("pump")).toBe("pumping");
  });

  it("IGNORES an unknown name rather than guessing", () => {
    // The rule that protects a caregiver running a newer build: unknown never means invalid,
    // so an unrecognised timer is neither shown nor mutated — least of all deleted.
    expect(classifyTimerName("Bath")).toBeNull();
    expect(classifyTimerName("")).toBeNull();
    expect(classifyTimerName(null)).toBeNull();
    expect(classifyTimerName(undefined)).toBeNull();
  });

  it("classifies on the base name, ignoring the encoded suffix", () => {
    expect(classifyTimerName("Feeding|breast milk|left breast")).toBe("feeding");
    expect(classifyTimerName("Feeding|left breast")).toBe("feeding");
  });
});

describe("the feeding-side name codec", () => {
  it("round-trips what this app writes", () => {
    const name = feedingTimerName({ type: "breast milk", method: "left breast" });
    expect(name).toBe("Feeding|breast milk|left breast");
    expect(feedingFromName(name)).toEqual({ type: "breast milk", method: "left breast" });
  });

  it("reads the method-only format the HA buttons write", () => {
    expect(feedingFromName("Feeding|right breast")).toEqual({ type: undefined, method: "right breast" });
  });

  it("omits parts it doesn't have", () => {
    expect(feedingTimerName({ type: "formula" })).toBe("Feeding|formula");
    expect(feedingTimerName({})).toBe("Feeding");
    expect(feedingTimerName()).toBe("Feeding");
  });

  it("ignores values that aren't real enum members", () => {
    expect(feedingFromName("Feeding|purple|sideways")).toEqual({ type: undefined, method: undefined });
  });

  it("leaves a bare name with nothing decoded", () => {
    expect(feedingFromName("Feeding")).toEqual({ type: undefined, method: undefined });
  });
});

describe("METHODS_FOR_TYPE", () => {
  it("offers at least one method for every type", () => {
    // `method` is REQUIRED on every feeding (verified live: a POST without it 400s), so an
    // empty list here would make that type impossible to log.
    for (const [type, methods] of Object.entries(METHODS_FOR_TYPE)) {
      expect(methods.length, `${type} has no method`).toBeGreaterThan(0);
    }
  });

  it("keeps prepared milk to a bottle", () => {
    expect(METHODS_FOR_TYPE.formula).toEqual(["bottle"]);
    expect(METHODS_FOR_TYPE["fortified breast milk"]).toEqual(["bottle"]);
  });

  it("does not offer a breast for solid food", () => {
    expect(METHODS_FOR_TYPE["solid food"]).not.toContain("bottle");
    for (const m of METHODS_FOR_TYPE["solid food"]) expect(m).not.toContain("breast");
  });
});

describe("the activity registry", () => {
  it("gives every timed activity a canonical timer name", () => {
    for (const [key, def] of Object.entries(ACTIVITIES)) {
      if (def.timed) expect(def.timerName, `${key} is timed but unnamed`).toBeTruthy();
      else expect(def.timerName).toBeUndefined();
    }
  });

  it("round-trips every canonical name back to its own activity", () => {
    for (const def of Object.values(ACTIVITIES)) {
      if (def.timerName) expect(classifyTimerName(def.timerName)).toBe(def.key);
    }
  });

  it("keys every entry by itself", () => {
    for (const [key, def] of Object.entries(ACTIVITIES)) expect(def.key).toBe(key as ActivityKey);
  });

  it("covers every feeding type in the method map", () => {
    const types = Object.keys(METHODS_FOR_TYPE) as FeedingType[];
    expect(types).toContain("breast milk");
    expect(types).toContain("solid food");
  });
});
