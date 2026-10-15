/**
 * Tummy-time daily goal — the age-recommended amount, shown against the day's total on the
 * calendar. (Home used to carry a "done/goal min today" row too; it was dropped on request,
 * 2026-10-15 — the tile and the calendar already say what was logged.)
 *
 * Pure + i18n-free: derived on render from the already-fetched entries, like elapsed time.
 *
 * The daily goal ramps per AAP / Pathways.org / NIH Safe to Sleep guidance: a few short
 * 3–5 min sessions for newborns, building to ~15–30 min/day by ~2 months and at least
 * ~60 min/day by 6 months. Values are a deliberately conservative daily target, not a
 * prescription — tummy time should always be supervised and awake.
 */
import { ageInMonths } from "./predict";

/**
 * Recommended daily tummy-time (minutes) by age, aligned to Huckleberry's tummy-time chart
 * (consistent with AAP / Pathways.org / NIH Safe to Sleep): ~20 min/day for newborns through
 * 1 month, ~30 by 2 months, ~45 by 3 months (their 30–60 range), and ≥60 from 4 months on
 * (4–5 mo "60+", 6 mo+ "60–90+"). The goal is the floor — more is fine ("no such thing as too
 * much"), and it's only ever a gentle daily target.
 */
function tummyGoalMinutes(months: number): number {
  if (!(months >= 0)) return 30; // unknown age → a safe middle target
  if (months < 2) return 20; // newborn–1 mo: a few short sessions
  if (months < 3) return 30; // ~2 mo
  if (months < 4) return 45; // ~3 mo (30–60)
  return 60; // 4 mo+: build toward / maintain ≥60 min/day
}

/** The age-recommended daily tummy-time goal (minutes) for a child at `now`. */
export function tummyGoalForAge(birthDate: string | null | undefined, now: number): number {
  return tummyGoalMinutes(ageInMonths(birthDate, now));
}
