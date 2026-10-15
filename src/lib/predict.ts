/**
 * Next-event prediction — "when's the next feed / nap / change likely?"
 *
 * Pure + i18n-free: a function of the already-fetched timeline entries, the child's age, and
 * `now` (epoch ms). No `Date.now()` inside, no network — recompute on render like elapsed time.
 *
 * The approach mirrors Huckleberry's documented SweetSpot predictor and the consultant/clinical
 * literature on infant sleep & feeding (see the research notes that produced this file):
 *   - start from an AGE-APPROPRIATE prior,
 *   - refine with the child's RECENT logged pattern,
 *   - CLAMP to established ranges,
 *   - emit a WINDOW (not a fake-precise minute) plus a CONFIDENCE so the UI can stay quiet when
 *     the data is too noisy to trust (newborn cluster feeding is genuinely unpredictable).
 *
 * Methods (refined against the infant sleep/feeding literature):
 *   - Sleep: two predictors, the earlier wins (see `predictSleep`). NAPS by wake window — last
 *     wake + how long this child stays awake at that point, told apart by position (first
 *     window of the day vs after a nap) and shortened after a short nap; the behavioural proxy
 *     for the two-process model's homeostatic Process S. BEDTIME by clock — the recent bedtimes'
 *     time of day, the circadian Process C. Bedtime is also what gets logged reliably when
 *     naps don't, so the evening stays predictable either way. Wake-window numbers are
 *     consultant guidance, not science — backtested against this family's own history.
 *   - Feeding & diaper: recency-weighted median of the recent gaps that followed an event at
 *     about this time of day (once a rhythm has emerged, ~6 weeks) — after the 07:30 feed two
 *     hours, after the 22:00 dream feed nine — taking the main mode when the nights split
 *     between a dream feed and sleeping through.
 *   - Non-stationarity: infant rhythms drift fastest in the early months, so all observed
 *     estimates are RECENCY-WEIGHTED (EWMA-style exponential decay) — recent days dominate while
 *     older data still informs. The weighted median keeps outlier-robustness; confidence uses the
 *     effective (not raw) sample size so a long-stale history can't masquerade as certainty.
 *
 * Anchors older than a day are dropped: once logging lapses, the rhythm has likely reset and a
 * stale "overdue" hint would just be wrong.
 */
import type { ActivityKey, TimelineEntry } from "../api";
import { lastNight } from "./night";

/** Activities we predict. Tummy time is deliberately omitted — it isn't rhythmic. */
export type PredictableActivity = "feeding" | "sleep" | "diaper";

export interface ActivityPrediction {
  activity: PredictableActivity;
  /** Best-guess next time (epoch ms). May be ≤ now → the UI shows "due now". */
  etaMs: number;
  /** Confidence window (epoch ms): the estimate sits between these. */
  lowMs: number;
  highMs: number;
  /** "pattern" = learned from this child's logs; "age" = age-based cold-start prior. */
  basis: "pattern" | "age";
  /** 0..1 — falls toward 0 as the recent pattern gets noisier / sparser. */
  confidence: number;
  /** Sleep only: which sleep is coming — a nap, or the night. */
  kind?: "nap" | "bedtime";
  /** Sleep only: the nap's number in the day. */
  ordinal?: number;
}

export type Predictions = Partial<Record<PredictableActivity, ActivityPrediction>>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Anchor (most recent event) older than this → drop the prediction; the rhythm has reset. */
const STALE_ANCHOR_MS = DAY;
/** Confidence assigned to age-based cold-start predictions (a reasonable prior, not observed). */
const AGE_BASIS_CONFIDENCE = 0.25;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Per-observation recency decay. Infant feeding/sleep rhythms are strongly non-stationary —
 * they drift week to week (fastest in the early months) — so older observations are
 * down-weighted, the standard EWMA remedy for concept drift. 0.85 ≈ a half-life of ~4–5
 * observations, so roughly the last day or two dominate while older data still informs.
 */
const RECENCY_DECAY = 0.85;

/** Recency weights for a NEWEST-FIRST list: weight 1, d, d², … (most recent gets the most). */
function recencyWeights(n: number): number[] {
  return Array.from({ length: n }, (_, i) => RECENCY_DECAY ** i);
}

/**
 * Weighted quantile (q in 0..1) — the recency-weighted analogue of a median (q=0.5) / IQR
 * edge. Robust like a median (operates on order, not magnitude) but lets recent observations
 * carry more weight, so it tracks drift without letting one outlier swing the estimate.
 */
function weightedQuantile(values: number[], weights: number[], q: number): number {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return NaN;
  const target = q * total;
  let cum = 0;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const prev = cum;
    cum += weights[i];
    if (cum >= target) {
      if (k === 0) return values[i];
      const j = order[k - 1];
      return values[j] + (values[i] - values[j]) * clamp((target - prev) / weights[i], 0, 1);
    }
  }
  return values[order[order.length - 1]];
}

/**
 * Confidence from dispersion + effective sample size. Uses the weighted coefficient of
 * variation (tight rhythm → high) and Kish's effective sample size n_eff = (Σw)²/Σw² (recency
 * weighting shrinks the effective count, so a long-stale history can't masquerade as certainty).
 */
function weightedConfidence(values: number[], weights: number[]): number {
  const W = weights.reduce((a, b) => a + b, 0);
  if (!(W > 0) || values.length < 1) return 0;
  const mean = values.reduce((s, v, i) => s + v * weights[i], 0) / W;
  if (!(mean > 0)) return 0;
  const variance = values.reduce((s, v, i) => s + weights[i] * (v - mean) ** 2, 0) / W;
  const cv = Math.sqrt(variance) / mean;
  const effN = (W * W) / weights.reduce((s, w) => s + w * w, 0);
  const nScore = clamp(effN / 6, 0, 1);
  const cvScore = clamp(1 - cv, 0, 1);
  return Math.round(nScore * (0.4 + 0.6 * cvScore) * 100) / 100;
}

// ── age ────────────────────────────────────────────────────────────────────────

const AVG_MONTH = (365.25 / 12) * DAY;

/** Child age in months at `now` (fractional). NaN if the birth date is unparseable. */
export function ageInMonths(birthDate: string | null | undefined, now: number): number {
  const b = birthDate ? Date.parse(birthDate) : NaN;
  return Number.isNaN(b) ? NaN : (now - b) / AVG_MONTH;
}

/**
 * Age-appropriate wake-window band (minutes): the cold-start prior AND the clamp for the
 * learned value. Napper's published table (its blog), which sits mid-range among the
 * consultants (Taking Cara Babies, Huckleberry, Cleveland Clinic disagree by ±30 min at
 * every age; no study backs any of them). INTERPOLATED between anchor ages: a hard step at a
 * month boundary would move the prediction by half an hour overnight.
 */
const WAKE_BAND: [months: number, min: number, max: number][] = [
  [0, 35, 60],
  [1, 60, 90],
  [3, 75, 120],
  [5, 120, 180],
  [7, 150, 210],
  [11, 180, 240],
  [14, 240, 360],
];

function wakeWindowBand(months: number): { min: number; max: number } {
  if (!(months >= 0)) return { min: 90, max: 180 }; // unknown age → a safe middle band
  const last = WAKE_BAND[WAKE_BAND.length - 1];
  if (months >= last[0]) return { min: last[1], max: last[2] };
  const k = WAKE_BAND.findIndex(([m]) => m > months);
  const [m0, lo0, hi0] = WAKE_BAND[k - 1];
  const [m1, lo1, hi1] = WAKE_BAND[k];
  const f = (months - m0) / (m1 - m0);
  return { min: lo0 + (lo1 - lo0) * f, max: hi0 + (hi1 - hi0) * f };
}

/** Age-appropriate typical feeding interval (ms) — the cold-start prior. */
function feedingPrior(months: number): number {
  if (!(months >= 0)) return 3 * HOUR;
  if (months < 1) return 2.5 * HOUR;
  if (months < 3) return 3 * HOUR;
  if (months < 6) return 3.5 * HOUR;
  return 4 * HOUR;
}

const DIAPER_PRIOR = 2.5 * HOUR;

// ── extraction helpers ───────────────────────────────────────────────────────────

/** Start times (epoch ms) for an activity, newest first. */
function startsOf(entries: TimelineEntry[], activity: ActivityKey): number[] {
  return entries
    .filter((e) => e.activity === activity && Number.isFinite(e.startMs))
    .map((e) => e.startMs)
    .sort((a, b) => b - a);
}

/** Circular distance between two clock times, in hours. */
const hoursApart = (a: number, b: number): number => {
  const d = Math.abs(sinceNoon(a) - sinceNoon(b)) / 60;
  return Math.min(d, 24 - d);
};

/**
 * Recent gaps (ms) between consecutive starts over the last fortnight, newest first, within
 * a sane band, each with the earlier event's time (the gap is measured from it).
 */
function recentIntervals(starts: number[], minGap: number, maxGap: number, now: number): { gap: number; from: number }[] {
  const out: { gap: number; from: number }[] = [];
  for (let i = 0; i + 1 < starts.length && now - starts[i + 1] <= SLEEP_LOOKBACK_MS; i++) {
    const gap = starts[i] - starts[i + 1];
    if (gap >= minGap && gap <= maxGap) out.push({ gap, from: starts[i + 1] });
  }
  return out;
}

/**
 * The sample's main mode. A sample of gaps is often two-moded — after the 19:00 feed the baby
 * either takes a dream feed three hours on or sleeps thirteen hours through, depending on the
 * night — and the median of such a sample is the one answer that never happens. When the
 * sorted gaps show a clear break (over two hours, and over 40 % of the larger side) with at
 * least two on each side, the heavier side (by recency weight) is the answer. Returns the
 * indexes into `values` to keep.
 */
function mainMode(values: number[], weights: number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  let cut = -1;
  let biggest = 0;
  for (let k = 1; k < order.length; k++) {
    const lo = values[order[k - 1]];
    const hi = values[order[k]];
    const jump = hi - lo;
    if (k >= 2 && order.length - k >= 2 && jump > Math.max(2 * HOUR, 0.4 * hi) && jump > biggest) {
      biggest = jump;
      cut = k;
    }
  }
  if (cut < 0) return order;
  const below = order.slice(0, cut);
  const above = order.slice(cut);
  const weightOf = (idx: number[]) => idx.reduce((sum, i) => sum + weights[i], 0);
  return weightOf(below) >= weightOf(above) ? below : above;
}

// ── predictors ─────────────────────────────────────────────────────────────────

/**
 * Recency-weighted interval predictor for the rhythmic, point-in-time activities (feeding,
 * diaper). The next gap depends on the clock: after the 07:30 feed it's two hours, after
 * the 19:00 one three, after the 22:00 dream feed nine — so the sample is the gaps that
 * followed feeds at about this time of day (within an hour, widened to two, then to all,
 * until there are four), once the child is old enough for a day/night rhythm
 * (`useCircadian`). Recent observations weigh more (rhythms drift); the estimate is the
 * weighted median of the sample's main mode (see `mainMode`) for outlier-robustness.
 */
function predictInterval(
  activity: "feeding" | "diaper",
  starts: number[],
  prior: number,
  minGap: number,
  maxGap: number,
  now: number,
  useCircadian: boolean,
): ActivityPrediction | null {
  const last = starts[0];
  if (last == null || now - last > STALE_ANCHOR_MS) return null; // no/stale anchor

  const gaps = recentIntervals(starts, minGap, maxGap, now); // newest-first
  let sample: number[] = [];
  if (useCircadian) {
    for (const within of [1, 2]) {
      sample = gaps.filter((g) => hoursApart(g.from, last) <= within).map((g) => g.gap);
      if (sample.length >= 4) break;
    }
  }
  if (sample.length < 4) sample = gaps.map((g) => g.gap);

  if (sample.length >= 3) {
    const w = recencyWeights(sample.length);
    const keep = mainMode(sample, w);
    const values = keep.map((i) => sample[i]);
    const weights = keep.map((i) => w[i]);
    return {
      activity,
      etaMs: last + weightedQuantile(values, weights, 0.5),
      lowMs: last + weightedQuantile(values, weights, 0.25),
      highMs: last + weightedQuantile(values, weights, 0.75),
      basis: "pattern",
      confidence: weightedConfidence(values, weights),
    };
  }
  // Cold start: offset the last event by the age-based prior, ±25% as the window.
  return {
    activity,
    etaMs: last + prior,
    lowMs: last + prior * 0.75,
    highMs: last + prior * 1.25,
    basis: "age",
    confidence: AGE_BASIS_CONFIDENCE,
  };
}

/**
 * Time-of-day bin for a wake window/**
 * Time-of-day bin for a wake window, keyed by the wake (sleep END) hour. Wake windows lengthen
 * across the day — the first is shortest (high overnight sleep pressure), the pre-bed one is
 * longest — so binning beats a single daily median.
 */
const wakeBin = (epochMs: number): 0 | 1 | 2 => {
  const h = new Date(epochMs).getHours();
  return h < 10 ? 0 : h < 14 ? 1 : 2;
};

/** Part of the night: a sleep that STARTS between 18:00 and 06:00. Clock-based rather than
 *  Baby Buddy's `nap` flag, which follows the instance's configured nap hours and labels a
 *  07:30 morning stretch as night. */
const isNightSleep = (startMs: number): boolean => {
  const h = new Date(startMs).getHours();
  return h >= 18 || h < 6;
};

/**
 * A nap, as opposed to the night or a piece of it. Starts in the day (06:00–18:00), lasts at
 * least a quarter of an hour (a six-minute doze in the car is logged, but it isn't a nap and
 * mustn't number the day's naps) — and a long sleep begun before 08:00 is the night's tail
 * after a dawn feed, not a first nap: it once made the sampler plan a 2½-hour first nap.
 */
const isNap = (s: { startMs: number; endMs: number | null }): boolean => {
  const len = (s.endMs ?? s.startMs) - s.startMs;
  return !isNightSleep(s.startMs) && len >= 15 * MIN && !(new Date(s.startMs).getHours() < 8 && len > 90 * MIN);
};

/** A sleep that can begin a night: starting 18:00–04:00. Not `isNightSleep`, which also takes
 *  the small hours up to 06:00 — a 04:30 piece of last night falls under the coming evening
 *  by the 04:00 day turn, and once passed for "tonight has begun" at ten in the morning. */
const isEveningOnset = (startMs: number): boolean => {
  const m = sinceNoon(startMs);
  return m >= 6 * 60 && m < 16 * 60;
};

/** Clock time as minutes since NOON, so an evening's bedtimes (20:00 → 480, 00:30 → 750)
 *  sort and average without wrapping at midnight. */
const sinceNoon = (epochMs: number): number => {
  const d = new Date(epochMs);
  return (d.getHours() * 60 + d.getMinutes() + 720) % 1440;
};

/** Local midnight before `epochMs`. */
const startOfLocalDay = (epochMs: number): number => {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The baby's day turns over at 04:00, not midnight: a 00:30 bedtime is still "tonight", and
 *  a 02:00 feed belongs to the night before, not to a new day. */
const DAY_TURN_MS = 4 * HOUR;

/** 04:00 starting the baby-day `epochMs` belongs to. */
const dayAnchor = (epochMs: number): number => startOfLocalDay(epochMs - DAY_TURN_MS) + DAY_TURN_MS;

/** Noon of the evening `epochMs` belongs to: the coming one through the day and the evening,
 *  the one just gone in the small hours. */
const eveningNoon = (epochMs: number): number => dayAnchor(epochMs) + 8 * HOUR;

/**
 * Days the rolling statistics cover — Napper's window — and the fortnight they widen to
 * when a week holds fewer than three of something, so sparse logging degrades gracefully.
 */
const ROLLING_DAYS = 7;
const ROLLING_DAYS_WIDE = 14;
const SLEEP_LOOKBACK_MS = ROLLING_DAYS_WIDE * DAY;

/** A sample with its age in days, for the week-then-fortnight widening. */
interface Aged {
  v: number;
  age: number;
}
/** The week's values, or the fortnight's when the week has fewer than three. */
const rolling = (samples: Aged[]): number[] => {
  const week = samples.filter((x) => x.age < ROLLING_DAYS).map((x) => x.v);
  return week.length >= 3 ? week : samples.filter((x) => x.age < ROLLING_DAYS_WIDE).map((x) => x.v);
};

/** Narrowest window worth showing (half-width): a rhythm logged to the minute still isn't
 *  that precise, and a ±3 min window would promise more than any source claims. */
const MIN_HALF_WINDOW = 15 * MIN;

type SleepEntry = Extract<TimelineEntry, { activity: "sleep" }>;

/**
 * The nights of the last fortnight before `until`, newest first — each the chain `lastNight`
 * builds (through its wakings and the 03:00 feed), so a false start at 19:00 resettled at
 * 19:45 counts as a 19:00 bedtime and a 03:00–04:30 stretch never passes for a morning wake.
 * `age` is in days before `until`'s evening.
 */
function recentNights(entries: TimelineEntry[], until: number): { startMs: number; endMs: number; age: number }[] {
  const out: { startMs: number; endMs: number; age: number }[] = [];
  const tonight = eveningNoon(until);
  for (let age = 1; age <= ROLLING_DAYS_WIDE; age++) {
    const evening = tonight - age * DAY;
    // As of noon the day after that evening: the night is over, the morning nap not yet in.
    const night = lastNight(entries, Math.min(evening + DAY, until));
    if (night && eveningNoon(night.startMs) === evening) {
      out.push({ startMs: night.startMs, endMs: night.endMs, age });
      continue;
    }
    // No chain to build (a night logged in odd pieces, or not at all after the onset): the
    // evening's first long sleep still marks a bedtime, even without a wake to go with it.
    const onset = entries
      .filter((e) => e.activity === "sleep" && e.endMs != null && e.endMs - e.startMs >= 90 * MIN && e.endMs <= until && isEveningOnset(e.startMs) && eveningNoon(e.startMs) === evening)
      .reduce<number | null>((a, e) => (a == null || e.startMs < a ? e.startMs : a), null);
    if (onset != null) out.push({ startMs: onset, endMs: NaN, age });
  }
  return out;
}

/**
 * Tonight's bedtime, from the clock times of recent bedtimes.
 *
 * Bedtime is driven by the body clock rather than by how long the baby has been awake, and it
 * settles early (the cortisol and melatonin rhythms appear at ~8–9 weeks). It is also what
 * parents log most reliably: in practice the night is always logged and the naps often
 * aren't, which leaves the wake-window model with nothing to measure from by evening. Napper
 * keeps it on the clock too — a skipped nap moves its bedtime a quarter of an hour at most.
 *
 * The onset is where each evening's night chain begins (see `recentNights`), a rolling week
 * of them, median ± IQR.
 */
function predictBedtime(entries: TimelineEntry[], now: number): ActivityPrediction | null {
  const evening = eveningNoon(now);
  // Tonight's night has already begun: there's no bedtime left to predict.
  const begun = entries.some(
    (e) => e.activity === "sleep" && e.endMs != null && e.endMs - e.startMs >= 90 * MIN && isEveningOnset(e.startMs) && eveningNoon(e.startMs) === evening && e.startMs <= now,
  );
  if (begun) return null;
  const mins = rolling(recentNights(entries, now).map((n) => ({ v: sinceNoon(n.startMs), age: n.age })));
  if (mins.length < 3) return null;
  const w = recencyWeights(mins.length);
  const med = weightedQuantile(mins, w, 0.5) * MIN;
  const half = Math.max((weightedQuantile(mins, w, 0.75) - weightedQuantile(mins, w, 0.25)) / 2, MIN_HALF_WINDOW / MIN) * MIN;
  // Confidence from how tightly bedtimes cluster, not from the coefficient of variation:
  // minutes since noon have an arbitrary origin, so a CV of them would mean nothing.
  const W = w.reduce((a, b) => a + b, 0);
  const effN = (W * W) / w.reduce((a, b) => a + b * b, 0);
  const confidence = Math.round(clamp(effN / 6, 0, 1) * clamp(1 - (2 * half) / (2 * HOUR), 0, 1) * 100) / 100;
  return {
    activity: "sleep",
    kind: "bedtime",
    etaMs: evening + med,
    lowMs: evening + med - half,
    highMs: evening + med + half,
    basis: "pattern",
    confidence,
  };
}

// ── day plan ──────────────────────────────────────────────────────────────────
//
// Modelled on Napper's, as far as it is known. A master's thesis done at Napper (Fernandez-
// Rajal i Sabala, Turku/KTH 2024, on 13.5M logs) describes the production model's inputs: for
// each nap NUMBER of the day, this baby's 7-day rolling mean/std of start time and duration,
// blended with the mean/std of babies the same age on the same nap count; the day re-anchored
// on the logged morning wake-up, every logged nap adjusting the remaining wake windows; bedtime
// on the clock; a 7-day learning phase before the schedule is the baby's own. We have no cohort
// data, so the published age tables stand in for the cohort, and the blend is a shrinkage:
// n days of this baby's own against COHORT_WEIGHT days of the table.

/** How many days of the baby's own logs it takes to count as much as the age table. */
const COHORT_WEIGHT = 3;
/** Days of logs before the schedule stops being "by age" — Napper's learning phase. */
export const LEARNING_DAYS = 7;

/** This baby's own mean over n days, pulled toward the table by COHORT_WEIGHT days' worth. */
const shrink = (own: number, n: number, prior: number) => (n * own + COHORT_WEIGHT * prior) / (n + COHORT_WEIGHT);

/**
 * Naps a day by age — [from month, fewest, most]. Stepped, not interpolated: a count is
 * discrete, and the steps ARE the transitions (4→3 at five to seven months, 3→2 at eight to
 * fifteen, 2→1 at sixteen to eighteen — Napper's blog, matching the Zurich cohort). Wide on
 * purpose; the length of this family's actual day decides within them (see `planDay`).
 */
const NAP_COUNT: [number, number, number][] = [
  [0, 4, 6],
  [2, 4, 5],
  [3, 3, 4],
  [5, 2, 4],
  [8, 2, 3],
  [12, 1, 2],
  [16, 1, 1],
];

function napCountBand(months: number): { min: number; max: number } {
  if (!(months >= 0)) return { min: 2, max: 3 };
  let band = NAP_COUNT[0];
  for (const b of NAP_COUNT) if (months >= b[0]) band = b;
  return { min: band[1], max: band[2] };
}

/** Cold-start nap length (ms) by age: catnaps early on, consolidating as the count drops. */
function napLengthPrior(months: number): number {
  if (!(months >= 0)) return 60 * MIN;
  if (months < 4) return 45 * MIN;
  if (months < 9) return 60 * MIN;
  if (months < 15) return 75 * MIN;
  return 100 * MIN;
}

/** Where a wake window sits in the day: after the night, after a nap, or before bed. */
type Position = "first" | "mid" | "last";

/** Where in the age band each position's cold-start window falls. The first is the shortest
 *  (every source agrees) and the one before bed the longest. */
const POSITION_RAMP: Record<Position, number> = { first: 0.25, mid: 0.6, last: 1 };

/** A chained guess — a nap planned after one that is itself only planned — loses this much
 *  confidence per hop. */
const HOP_DECAY = 0.6;

export interface PlannedSleep {
  kind: "nap" | "bedtime";
  /** Nap number in the day, from 1 (0 for bedtime). */
  ordinal: number;
  startMs: number;
  endMs: number;
  /** Onset window. A logged sleep's is just its start. */
  lowMs: number;
  highMs: number;
  /** done: logged. running: the sleep timer. planned: still to come. missed: its window has
   *  passed with nothing logged — it may well have happened unlogged, so the plan stands. */
  status: "done" | "running" | "planned" | "missed";
  basis: "pattern" | "age";
  confidence: number;
  /** Planned naps this one is chained on — 0 when it runs from a logged wake. */
  hops: number;
  entryId?: number;
}

export interface DayPlan {
  /** This morning's wake, when known. */
  wakeMs: number | null;
  /** Today's naps in order, then bedtime (absent once the night has begun). */
  sleeps: PlannedSleep[];
  /** Days of the past week with the wake-up and naps logged — the learning phase's progress
   *  out of `LEARNING_DAYS`. */
  learningDays: number;
}

/** Mean and spread of a sample. */
interface Stat {
  n: number;
  mean: number;
  sd: number;
}
function stat(values: number[]): Stat | null {
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length);
  return { n: values.length, mean, sd };
}

interface NapStats {
  /** Days of the past week with the wake-up logged and at least one nap. */
  daysLearned: number;
  /** Naps a day, over the days with the wake-up logged and a nap. */
  count: Stat | null;
  /** The last window of the day — the last nap's end to that evening's bedtime — over the
   *  days that have both. It sizes how much of the day the naps must fill. */
  lastWindow: Stat | null;
  /** Per nap number: the wake window before it, its length, and its start as an offset from
   *  the morning wake — each winsorized into the age band before averaging, so one odd day
   *  can't drag a seven-day mean. */
  byOrdinal: Map<number, { window: Stat | null; length: Stat | null; offset: Stat | null }>;
  /** Wake windows by position from EVERY logged pair, wake-up on record or not — the fallback
   *  when a day's naps weren't numbered. */
  byPosition: Record<"first" | "mid", number[]>;
}

/**
 * This baby's own nap statistics from the days before `until`'s — Napper's per-nap-number
 * rolling week, with the fortnight behind it when the week is thin. A day counts for the
 * numbered statistics only when its wake-up is on record (without it, "nap 1" might be the
 * third); the position statistics take every pair.
 */
function learnNaps(entries: TimelineEntry[], sleeps: SleepEntry[], until: number, minMs: number, maxMs: number): NapStats {
  const today = dayAnchor(until);
  const naps = sleeps.filter((s) => isNap(s) && s.startMs < today && until - s.startMs <= SLEEP_LOOKBACK_MS);
  const byDay = new Map<number, SleepEntry[]>();
  for (const s of naps) {
    const day = dayAnchor(s.startMs);
    const list = byDay.get(day);
    if (list) list.push(s);
    else byDay.set(day, [s]);
  }
  const counts: Aged[] = [];
  const lastWindows: Aged[] = [];
  const onsets = new Map<number, number>(); // evening noon → the night's onset
  for (const n of recentNights(entries, until)) onsets.set(eveningNoon(n.startMs), n.startMs);
  const windows = new Map<number, Aged[]>();
  const lengths = new Map<number, Aged[]>();
  const offsets = new Map<number, Aged[]>();
  const push = (m: Map<number, Aged[]>, k: number, v: number, age: number) => {
    const list = m.get(k) ?? [];
    list.push({ v, age });
    m.set(k, list);
  };
  let daysLearned = 0;
  for (const [day, list] of byDay) {
    const night = lastNight(entries, day + 8 * HOUR);
    if (!night || night.endMs < day || night.endMs > day + 9 * HOUR) continue;
    const age = (today - day) / DAY;
    if (age < ROLLING_DAYS) daysLearned++;
    list.sort((a, b) => a.startMs - b.startMs);
    counts.push({ v: list.length, age });
    const onset = onsets.get(day + 8 * HOUR);
    const lastEnd = list[list.length - 1].endMs as number;
    if (onset != null && onset - lastEnd >= 10 * MIN && onset - lastEnd <= maxMs * 1.5) lastWindows.push({ v: clamp(onset - lastEnd, minMs * 0.8, maxMs * 1.3), age });
    let prevEnd = night.endMs;
    list.forEach((s, i) => {
      const gap = s.startMs - prevEnd;
      if (gap >= 10 * MIN && gap <= maxMs * 1.5) push(windows, i + 1, clamp(gap, minMs * 0.8, maxMs * 1.3), age);
      push(lengths, i + 1, clamp((s.endMs as number) - s.startMs, 20 * MIN, 150 * MIN), age);
      push(offsets, i + 1, s.startMs - night.endMs, age);
      prevEnd = s.endMs as number;
    });
  }
  const byOrdinal = new Map<number, { window: Stat | null; length: Stat | null; offset: Stat | null }>();
  for (const k of new Set([...windows.keys(), ...lengths.keys(), ...offsets.keys()])) {
    byOrdinal.set(k, {
      window: stat(rolling(windows.get(k) ?? [])),
      length: stat(rolling(lengths.get(k) ?? [])),
      offset: stat(rolling(offsets.get(k) ?? [])),
    });
  }

  // Positions, from every consecutive pair that ends in a nap (the window before bed comes
  // from the bedtime model; with naps so often unlogged it would otherwise learn a five-hour
  // "window" that never was), newest first.
  const byPosition = { first: [] as number[], mid: [] as number[] };
  const done = sleeps.filter((s) => (s.endMs as number) <= until);
  for (let i = done.length - 1; i > 0; i--) {
    const a = done[i - 1];
    const b = done[i];
    const wake = a.endMs as number;
    if (until - wake > SLEEP_LOOKBACK_MS) break;
    if (!isNap(b)) continue;
    const gap = b.startMs - wake;
    if (gap < 10 * MIN || gap > maxMs * 1.5) continue;
    byPosition[isNap(a) ? "mid" : "first"].push(gap);
  }
  return { daysLearned, count: stat(rolling(counts)), lastWindow: stat(rolling(lastWindows)), byOrdinal, byPosition };
}

/**
 * Today's sleep schedule: the naps already logged, the ones still to come, and bedtime.
 *
 * Bedtime comes from the clock (see `predictBedtime`); between this morning's wake and it,
 * the remaining naps are laid out one wake window after another — the first window of the
 * day shortest, the later ones longer — stretched or squeezed within the age band so the day
 * ends at bedtime, with as many naps as the day has room for inside the age's range. A logged
 * nap re-anchors everything after it: the next window runs from its real end, and is cut by
 * a fifth when it was a short one (sleep pressure isn't relieved — Owlet predicts from the
 * previous sleep's length, Huckleberry recalculates after a short nap; consultants put it at
 * 15–60 min, no study gives a factor).
 *
 * Every number is this baby's own where there are logs — the window before nap N, nap N's
 * length, nap N's usual offset from the wake-up (the plan meets that halfway: a settled body
 * clock doesn't move with every late wake) — shrunk toward the age table by `shrink`, so one
 * logged day nudges the table and a week replaces it. The table alone until then.
 *
 * A planned nap whose window passes unlogged stays in the plan as "missed": most likely it
 * happened in the pram or on a shoulder, so the schedule holds rather than declaring the
 * baby awake since dawn. What's lost is certainty, so each guess chained on a guess carries
 * less confidence than the one before.
 */
export function planDay(
  entries: TimelineEntry[],
  birthDate: string | null | undefined,
  now: number,
  runningSleepStartMs: number | null = null,
): DayPlan | null {
  const months = ageInMonths(birthDate, now);
  const sleeps = entries
    .filter((e): e is SleepEntry => e.activity === "sleep" && e.endMs != null && (e.endMs as number) <= now)
    .sort((a, b) => a.startMs - b.startMs);
  const anchor = dayAnchor(now);

  // This morning's wake: the end of the night (chained through its wakings by `lastNight`),
  // when it ended this morning. A night still running has a predicted end instead.
  let wakeMs: number | null = null;
  const night = lastNight(entries, now);
  if (night && night.endMs >= anchor && night.endMs <= anchor + 9 * HOUR) wakeMs = night.endMs;
  const runningNight = runningSleepStartMs != null && isNightSleep(runningSleepStartMs) && now - runningSleepStartMs >= 3 * HOUR;
  if (runningNight) {
    const se = predictSleepEnd(entries, birthDate, runningSleepStartMs);
    wakeMs = Math.max(se?.endMs ?? runningSleepStartMs + 10.5 * HOUR, now + 5 * MIN);
  }

  const band = wakeWindowBand(months);
  const minMs = band.min * MIN;
  const maxMs = band.max * MIN;
  const stats = learnNaps(entries, sleeps, now, minMs, maxMs);

  // Nap N's length: this baby's own for that number, shrunk toward the time-of-day sampler
  // (or the age prior when that has nothing to go on).
  const lengthFor = (ordinal: number, startMs: number): { ms: number; basis: "pattern" | "age"; confidence: number } => {
    const se = predictNapLength(sleeps, months, startMs);
    const prior = se.confidence >= 0.3 ? se.endMs - startMs : napLengthPrior(months);
    const own = stats.byOrdinal.get(ordinal)?.length;
    if (own) return { ms: shrink(own.mean, own.n, prior), basis: "pattern", confidence: Math.max(se.confidence, clamp(own.n / LEARNING_DAYS, 0, 1)) };
    return { ms: prior, basis: se.confidence >= 0.3 ? "pattern" : "age", confidence: se.confidence };
  };

  // Today's logged naps, oldest first, then the running one with its predicted end.
  const floor = wakeMs ?? anchor;
  const items: PlannedSleep[] = sleeps
    .filter((s) => s.startMs >= floor && isNap(s))
    .map((s, i) => ({
      kind: "nap" as const,
      ordinal: i + 1,
      startMs: s.startMs,
      endMs: s.endMs as number,
      lowMs: s.startMs,
      highMs: s.startMs,
      status: "done" as const,
      basis: "pattern" as const,
      confidence: 1,
      hops: 0,
      entryId: s.id,
    }));
  if (runningSleepStartMs != null && !runningNight && runningSleepStartMs >= floor && !isNightSleep(runningSleepStartMs)) {
    const len = lengthFor(items.length + 1, runningSleepStartMs);
    items.push({
      kind: "nap",
      ordinal: items.length + 1,
      startMs: runningSleepStartMs,
      endMs: Math.max(runningSleepStartMs + len.ms, now + 5 * MIN),
      lowMs: runningSleepStartMs,
      highMs: runningSleepStartMs,
      status: "running",
      basis: len.basis,
      confidence: len.confidence,
      hops: 0,
    });
  }
  const last = items[items.length - 1];
  // Nothing to plan from: no wake this morning and no nap today. (A wake from yesterday
  // evening would plan naps through the night.)
  const cursor = last ? last.endMs : wakeMs;
  if (cursor == null) return null;

  // The wake window before nap N: this baby's own for that number shrunk toward the table,
  // else the position's median from every logged pair, else the table's ramp.
  const priorFor = (pos: Position) => minMs + (maxMs - minMs) * POSITION_RAMP[pos];
  const window = (ordinal: number, pos: Position): { ms: number; lo: number; hi: number; basis: "pattern" | "age"; confidence: number } => {
    const own = pos === "last" ? null : stats.byOrdinal.get(ordinal)?.window;
    if (own) {
      const ms = shrink(own.mean, own.n, priorFor(pos));
      const half = Math.max(own.sd, MIN_HALF_WINDOW);
      return { ms, lo: ms - half, hi: ms + half, basis: "pattern", confidence: clamp(0.25 + 0.75 * clamp(own.n / LEARNING_DAYS, 0, 1) * clamp(1 - own.sd / HOUR, 0, 1), 0.25, 1) };
    }
    const sample = pos === "last" ? [] : stats.byPosition[pos];
    if (sample.length >= 3) {
      const w = recencyWeights(sample.length);
      const q = (p: number) => clamp(weightedQuantile(sample, w, p), minMs, maxMs);
      return { ms: q(0.5), lo: q(0.25), hi: q(0.75), basis: "pattern", confidence: weightedConfidence(sample, w) };
    }
    const ms = priorFor(pos);
    return { ms, lo: ms * 0.8, hi: ms * 1.2, basis: "age", confidence: AGE_BASIS_CONFIDENCE };
  };
  const recentNaps = sleeps.filter((s) => isNap(s) && cursor! - s.startMs <= SLEEP_LOOKBACK_MS).map((s) => (s.endMs as number) - s.startMs);
  const usualNap = recentNaps.length >= 3 ? weightedQuantile(recentNaps, recentNaps.map(() => 1), 0.5) : napLengthPrior(months);
  // Short last nap → shorter next window.
  const shortNap = last != null && last.endMs - last.startMs < Math.min(45 * MIN, usualNap / 2);

  // How many naps are left: this baby's own count shrunk toward the age's range, narrowed to
  // what the time until bedtime has room for — a long day fits one more nap, a short one
  // fewer. The bedtime is the evening the cursor falls in, so a night in progress plans the
  // morning after it rather than the evening gone.
  const bed = predictBedtime(entries, Math.max(now, cursor));
  // The count: this baby's own week outright once it holds five days — a child on one nap
  // at ten months is on one nap, whatever the table's "2–3" says, and the blend was too
  // sticky to let go (it planned a morning nap every day) — a blend before that.
  const countBand = napCountBand(months);
  const own = stats.count;
  const learned = own ? Math.round(own.n >= 5 ? own.mean : shrink(own.mean, own.n, (countBand.min + countBand.max) / 2)) : null;
  const lo = Math.max(0, (learned ?? countBand.min) - items.length);
  const hi = Math.max(lo, (learned ?? countBand.max) - items.length);
  const positions = (r: number): Position[] => Array.from({ length: r }, (_, i) => (i === 0 && items.length === 0 ? "first" : "mid"));
  const unscaled = (r: number) => positions(r).reduce((sum, pos, i) => sum + window(items.length + i + 1, pos).ms, 0);
  // The window before bed: this baby's own, shrunk toward the table's longest. The table's
  // maximum alone (five hours at a year) once squeezed a two-nap day down to one nap.
  const lastWindow = stats.lastWindow ? shrink(stats.lastWindow.mean, stats.lastWindow.n, priorFor("last")) : priorFor("last");
  let remaining: number;
  if (bed == null) remaining = Math.round((lo + hi) / 2);
  else {
    const span = bed.etaMs - cursor;
    let best = { r: lo, err: Infinity };
    for (let r = Math.max(0, lo - 1); r <= hi + 1; r++) {
      const total = unscaled(r) + r * usualNap + lastWindow;
      const err = Math.abs(span - total) + (r < lo || r > hi ? 45 * MIN : 0);
      if (err < best.err) best = { r, err };
    }
    remaining = best.r;
  }

  // Lay the naps out from the cursor, stretching or squeezing the windows (within the age
  // band) so the day ends at bedtime; whatever is left before bed is the last window.
  for (;;) {
    const pos = positions(remaining);
    let scale = 1;
    if (bed != null && remaining > 0) {
      const room = bed.etaMs - cursor - remaining * usualNap - lastWindow;
      scale = clamp(room / unscaled(remaining), 0.5, 2);
    }
    const planned: PlannedSleep[] = [];
    let t = cursor;
    for (let i = 0; i < remaining; i++) {
      const ordinal = items.length + i + 1;
      const w = window(ordinal, pos[i]);
      // The day's slack stretches the table's guesses, never a window the baby's own logs
      // pin down — stretched, a known five-hour window became seven and the nap landed late.
      const factor = (i === 0 && shortNap ? 0.8 : 1) * (w.basis === "pattern" ? 1 : scale);
      // Halfway to nap N's usual offset from the wake-up, when the day has one and it's close
      // enough to be the same nap.
      const usual = stats.byOrdinal.get(ordinal)?.offset;
      const rhythm = usual != null && usual.n >= 3 && usual.sd <= 45 * MIN && wakeMs != null ? wakeMs + usual.mean : null;
      // The baby's own window may run past the table's longest (a child on one nap at ten
      // months stays up five and a half hours; the table says four) — the table's only
      // bounds the table's own guesses.
      const cap = w.basis === "pattern" ? maxMs * 1.3 : maxMs;
      const at = (ms: number) => {
        const byWindow = t + clamp(ms * factor, minMs * 0.8, cap);
        return rhythm != null && Math.abs(rhythm - byWindow) <= 90 * MIN ? (byWindow + rhythm) / 2 : byWindow;
      };
      const startMs = at(w.ms);
      const len = lengthFor(ordinal, startMs);
      const endMs = startMs + len.ms;
      const lowMs = Math.min(at(w.lo), startMs - MIN_HALF_WINDOW);
      const highMs = Math.max(at(w.hi), startMs + MIN_HALF_WINDOW);
      const anchored = i === 0 ? 1 : HOP_DECAY ** i;
      planned.push({
        kind: "nap",
        ordinal,
        startMs,
        endMs,
        lowMs,
        highMs,
        status: now > highMs + Math.max(30 * MIN, highMs - lowMs) ? "missed" : "planned",
        basis: w.basis,
        confidence: Math.round(w.confidence * anchored * 100) / 100,
        hops: i,
      });
      t = endMs;
    }
    // No room left for the last window before bed: one nap fewer.
    if (bed != null && remaining > 0 && bed.etaMs - t < minMs * 0.8) {
      remaining--;
      continue;
    }
    items.push(...planned);
    break;
  }
  if (bed != null) {
    items.push({
      kind: "bedtime",
      ordinal: 0,
      startMs: bed.etaMs,
      endMs: bed.etaMs,
      lowMs: bed.lowMs,
      highMs: bed.highMs,
      status: "planned",
      basis: bed.basis,
      confidence: bed.confidence,
      hops: 0,
    });
  }
  return { wakeMs, sleeps: items, learningDays: stats.daysLearned };
}

/**
 * The next sleep: the first still to come in today's plan that is ANCHORED — a nap timed
 * from a logged wake, or bedtime, which is timed from the clock. A nap chained on a guess
 * belongs in the plan, not in a row that says "prediction": once a planned nap has passed
 * unlogged, this moves on to bedtime.
 */
function predictSleep(entries: TimelineEntry[], birthDate: string | null | undefined, now: number, runningSleepStartMs: number | null): ActivityPrediction | null {
  const plan = planDay(entries, birthDate, now, runningSleepStartMs);
  const next = plan?.sleeps.find((p) => p.status === "planned" && p.hops === 0);
  if (!next) return null;
  return {
    activity: "sleep",
    kind: next.kind,
    ...(next.kind === "nap" ? { ordinal: next.ordinal } : {}),
    etaMs: next.startMs,
    lowMs: next.lowMs,
    highMs: next.highMs,
    basis: next.basis,
    confidence: next.confidence,
  };
}

// ── sleep duration ────────────────────────────────────────────────────────────

export interface SleepEndPrediction {
  /** Predicted wake (epoch ms) for a sleep starting at `startMs`. */
  endMs: number;
  lowMs: number;
  highMs: number;
  basis: "pattern" | "age";
  confidence: number;
}

/**
 * Predict when a sleep STARTING at `startMs` will end.
 *
 * Two regimes, because they're driven by different clocks:
 *  - NIGHT (start 17:00–04:00): the morning wake time is circadian and one of the day's most
 *    stable anchors — predict the wake as the recency-weighted median of recent morning wake
 *    clock-times, clamped to a sane 6–14 h night.
 *  - NAP: durations cluster by position in the day, so sample recent nap durations in the
 *    matching time-of-day bin (recency-weighted median + IQR). Catnap bins are inherently
 *    noisy — the dispersion-based confidence stays low there, and callers should gate on it.
 */
export function predictSleepEnd(
  entries: TimelineEntry[],
  birthDate: string | null | undefined,
  startMs: number,
): SleepEndPrediction | null {
  const sleeps = entries.filter(
    (e): e is Extract<TimelineEntry, { activity: "sleep" }> => e.activity === "sleep" && e.endMs != null,
  );
  const startHour = new Date(startMs).getHours();
  // The night begins where THIS family's bedtime is (an hour's grace before it), not at a
  // fixed hour: a 19:00 doze is the night for a baby put down at 19:30 and an evening catnap
  // for one whose bedtime is 21:30. Without a bedtime on record, 17:00 stands in.
  const bed = predictBedtime(entries, startMs);
  const isNightStart = startHour < 4 || (bed != null ? startMs >= bed.lowMs - HOUR : startHour >= 17);

  if (isNightStart) {
    // Morning wake clock-times (minutes since midnight) of the recent nights, newest first —
    // the end of each night's chain, so a 03:00–04:30 stretch never passes for the wake.
    const wakes = rolling(
      recentNights(entries, startMs)
        .filter((n) => Number.isFinite(n.endMs))
        .map((n) => {
          const d = new Date(n.endMs);
          return { v: d.getHours() * 60 + d.getMinutes(), age: n.age };
        }),
    );
    const dayStart = new Date(startMs);
    dayStart.setHours(0, 0, 0, 0);
    const toEnd = (clockMin: number): number => {
      let end = dayStart.getTime() + clockMin * MIN;
      while (end <= startMs + 2 * HOUR) end += DAY; // a 20:00 start wakes TOMORROW morning
      return startMs + clamp(end - startMs, 6 * HOUR, 14 * HOUR);
    };
    if (wakes.length >= 3) {
      const w = recencyWeights(wakes.length);
      return {
        endMs: toEnd(weightedQuantile(wakes, w, 0.5)),
        lowMs: toEnd(weightedQuantile(wakes, w, 0.25)),
        highMs: toEnd(weightedQuantile(wakes, w, 0.75)),
        basis: "pattern",
        confidence: weightedConfidence(wakes, w),
      };
    }
    const end = startMs + 10.5 * HOUR;
    return { endMs: end, lowMs: end - HOUR, highMs: end + HOUR, basis: "age", confidence: AGE_BASIS_CONFIDENCE };
  }

  return predictNapLength(sleeps, ageInMonths(birthDate, startMs), startMs);
}

/** How long a nap starting at `startMs` should last — see `predictSleepEnd`. */
function predictNapLength(sleeps: SleepEntry[], months: number, startMs: number): SleepEndPrediction {
  // Recent nap durations, preferring the bin matching this start's time of day.
  const naps = sleeps
    .filter((e) => isNap(e))
    .map((e) => ({ dur: (e.endMs as number) - e.startMs, bin: wakeBin(e.startMs), at: e.startMs }))
    .filter((n) => n.dur >= 10 * MIN && n.dur <= 4 * HOUR)
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
  const bin = wakeBin(startMs);
  const matched = naps.filter((n) => n.bin === bin).map((n) => n.dur);
  const sample = matched.length >= 3 ? matched : naps.map((n) => n.dur);
  const bandLo = 25 * MIN;
  const bandHi = 2.5 * HOUR;
  if (sample.length >= 3) {
    const w = recencyWeights(sample.length);
    return {
      endMs: startMs + clamp(weightedQuantile(sample, w, 0.5), bandLo, bandHi),
      lowMs: startMs + clamp(weightedQuantile(sample, w, 0.25), bandLo, bandHi),
      highMs: startMs + clamp(weightedQuantile(sample, w, 0.75), bandLo, bandHi),
      basis: "pattern",
      confidence: weightedConfidence(sample, w),
    };
  }
  const prior = (months >= 0 && months < 4 ? 45 : 70) * MIN;
  return { endMs: startMs + prior, lowMs: startMs + prior * 0.6, highMs: startMs + prior * 1.5, basis: "age", confidence: AGE_BASIS_CONFIDENCE };
}

/**
 * Minimum time a passed eta stays on screen as "late by X" before the prediction expires.
 * The real bound scales with the prediction's own confidence window (see `predictionAlive`):
 * a feeding on a tight 2 h rhythm stays visible while it's meaningfully late, but a guess
 * blown past by many times its window is noise — "expected 16 h ago" under a "Prediction"
 * header reads as an event, not a forecast.
 */
export const PREDICTION_GRACE_MS = 60 * 60_000;

/** Whether an overdue prediction is still worth showing: alive until one window-width past
 *  the high bound (child- and activity-specific), with the flat grace as a floor. */
export const predictionAlive = (p: ActivityPrediction, now: number): boolean =>
  now < Math.max(p.highMs + (p.highMs - p.lowMs), p.etaMs + PREDICTION_GRACE_MS);

/**
 * Predict the next feeding, sleep onset, and diaper change for a child from their recent
 * timeline entries. Any activity without a usable (recent) anchor is simply omitted.
 */
export function predictNext(
  entries: TimelineEntry[],
  birthDate: string | null | undefined,
  now: number,
  /** A sleep timer in progress — its predicted end is where the rest of the day plans from. */
  runningSleepStartMs: number | null = null,
): Predictions {
  const months = ageInMonths(birthDate, now);
  // A robust day/night rhythm isn't present until ~6–12 weeks, so only split feeds/changes by
  // circadian period once the child is old enough; before that, pool all intervals.
  const useCircadian = !(months >= 0) || months >= 1.5;
  const out: Predictions = {};

  const feeding = predictInterval("feeding", startsOf(entries, "feeding"), feedingPrior(months), 5 * MIN, 14 * HOUR, now, useCircadian);
  if (feeding) out.feeding = feeding;

  const diaper = predictInterval("diaper", startsOf(entries, "diaper"), DIAPER_PRIOR, 5 * MIN, 14 * HOUR, now, useCircadian);
  if (diaper) out.diaper = diaper;

  const sleep = predictSleep(entries, birthDate, now, runningSleepStartMs);
  if (sleep) out.sleep = sleep;

  return out;
}
