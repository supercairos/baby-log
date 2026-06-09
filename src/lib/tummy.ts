/**
 * Tummy-time daily progress — today's logged total vs the age-recommended amount.
 *
 * Pure + i18n-free: derived on render from the already-fetched timeline, like elapsed time.
 *
 * The daily goal ramps per AAP / Pathways.org / NIH Safe to Sleep guidance: a few short
 * 3–5 min sessions for newborns, building to ~15–30 min/day by ~2 months and at least
 * ~60 min/day by 6 months. Values are a deliberately conservative daily target, not a
 * prescription — tummy time should always be supervised and awake.
 */
import type { TimelineEntry } from "../api";
import { ageInMonths } from "./predict";

export interface TummyProgress {
  /** Completed tummy-time logged so far in the local day (ms). */
  todayMs: number;
  /** Age-recommended daily total (minutes). */
  goalMin: number;
  /** Whether today's total has reached the goal. */
  metGoal: boolean;
}

/** Recommended daily tummy-time (minutes) by age (AAP / Pathways.org / NIH Safe to Sleep). */
function tummyGoalMinutes(months: number): number {
  if (!(months >= 0)) return 30; // unknown age → a safe middle target
  if (months < 1) return 10;
  if (months < 2) return 20;
  if (months < 4) return 30;
  if (months < 6) return 45;
  return 60;
}

/**
 * Sum today's completed tummy-time entries (by local calendar day) and compare against the
 * age-appropriate daily goal. A currently-running tummy timer isn't counted (it's not yet a
 * logged entry) — it shows live on the running card and rolls into the total once stopped.
 */
export function tummyProgress(
  entries: TimelineEntry[],
  birthDate: string | null | undefined,
  now: number,
): TummyProgress {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const from = dayStart.getTime();

  let todayMs = 0;
  for (const e of entries) {
    if (e.activity !== "tummy" || e.endMs == null) continue;
    if (e.startMs >= from) todayMs += Math.max(0, e.endMs - e.startMs);
  }

  const goalMin = tummyGoalMinutes(ageInMonths(birthDate, now));
  return { todayMs, goalMin, metGoal: todayMs >= goalMin * 60_000 };
}
