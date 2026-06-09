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
 * Methods:
 *   - Sleep/nap: the wake-window model — next onset ≈ last wake time + typical wake window.
 *     Wake windows lengthen with age, so the age band is both the cold-start prior and the clamp.
 *   - Feeding & diaper: rolling MEDIAN of recent intervals (median shrugs off cluster feeds and
 *     overnight gaps that would wreck a mean).
 *
 * Anchors older than a day are dropped: once logging lapses, the rhythm has likely reset and a
 * stale "overdue" hint would just be wrong.
 */
import type { ActivityKey, TimelineEntry } from "../api";

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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolation quantile (q in 0..1). */
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Confidence from sample size and dispersion (coefficient of variation). */
function intervalConfidence(intervals: number[]): number {
  const n = intervals.length;
  if (n < 1) return 0;
  const m = mean(intervals);
  if (!(m > 0)) return 0;
  const cv = Math.sqrt(mean(intervals.map((x) => (x - m) ** 2))) / m;
  const nScore = clamp(n / 6, 0, 1);
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
 * Age-appropriate wake-window band (minutes) — the cold-start prior AND the clamp for the
 * learned value. Source: consultant + clinical guidance (Huckleberry, Cleveland Clinic).
 */
function wakeWindowBand(months: number): { min: number; max: number } {
  if (!(months >= 0)) return { min: 90, max: 180 }; // unknown age → a safe middle band
  if (months < 3) return { min: 30, max: 90 };
  if (months < 4) return { min: 60, max: 120 };
  if (months < 6) return { min: 90, max: 150 };
  if (months < 7) return { min: 120, max: 180 };
  if (months < 10) return { min: 150, max: 210 };
  return { min: 180, max: 240 };
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

/** Gaps (ms) between consecutive starts (newest first), kept only within a sane band. */
function recentIntervals(starts: number[], minGap: number, maxGap: number, take = 8): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < starts.length && out.length < take; i++) {
    const gap = starts[i] - starts[i + 1];
    if (gap >= minGap && gap <= maxGap) out.push(gap);
  }
  return out;
}

const isDaytime = (epochMs: number): boolean => {
  const h = new Date(epochMs).getHours();
  return h >= 5 && h < 21;
};

// ── predictors ─────────────────────────────────────────────────────────────────

/** Median-interval predictor for the rhythmic, point-in-time activities (feeding, diaper). */
function predictInterval(
  activity: "feeding" | "diaper",
  starts: number[],
  prior: number,
  minGap: number,
  maxGap: number,
  now: number,
): ActivityPrediction | null {
  const last = starts[0];
  if (last == null || now - last > STALE_ANCHOR_MS) return null; // no/stale anchor
  const intervals = recentIntervals(starts, minGap, maxGap);
  if (intervals.length >= 3) {
    return {
      activity,
      etaMs: last + median(intervals),
      lowMs: last + quantile(intervals, 0.25),
      highMs: last + quantile(intervals, 0.75),
      basis: "pattern",
      confidence: intervalConfidence(intervals),
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

/** Wake-window predictor for the next sleep onset. */
function predictSleep(entries: TimelineEntry[], months: number, now: number): ActivityPrediction | null {
  const sleeps = entries
    .filter((e): e is Extract<TimelineEntry, { activity: "sleep" }> => e.activity === "sleep")
    .sort((a, b) => a.startMs - b.startMs); // oldest → newest

  // Last wake = the latest sleep END we have on record.
  let lastWake = -Infinity;
  for (const s of sleeps) if (s.endMs != null && s.endMs > lastWake) lastWake = s.endMs;
  if (!Number.isFinite(lastWake) || now - lastWake > STALE_ANCHOR_MS) return null;

  const band = wakeWindowBand(months);
  const minMs = band.min * MIN;
  const maxMs = band.max * MIN;

  // Observed daytime wake windows: gap between one sleep's end and the next sleep's start.
  // The 10-min..6-h gate drops night-waking blips and the overnight gap (a missing night-sleep
  // log would otherwise look like an absurd ~14-h "wake window").
  const windows: number[] = [];
  for (let i = 0; i + 1 < sleeps.length; i++) {
    const end = sleeps[i].endMs;
    if (end == null) continue;
    const gap = sleeps[i + 1].startMs - end;
    if (gap >= 10 * MIN && gap <= 6 * HOUR && isDaytime(end)) windows.push(gap);
  }

  if (windows.length >= 3) {
    const ww = clamp(median(windows), minMs, maxMs); // clamp to the age band, per SweetSpot
    return {
      activity: "sleep",
      etaMs: lastWake + ww,
      lowMs: lastWake + minMs,
      highMs: lastWake + maxMs,
      basis: "pattern",
      confidence: intervalConfidence(windows),
    };
  }
  return {
    activity: "sleep",
    etaMs: lastWake + (minMs + maxMs) / 2,
    lowMs: lastWake + minMs,
    highMs: lastWake + maxMs,
    basis: "age",
    confidence: AGE_BASIS_CONFIDENCE,
  };
}

/**
 * Predict the next feeding, sleep onset, and diaper change for a child from their recent
 * timeline entries. Any activity without a usable (recent) anchor is simply omitted.
 */
export function predictNext(
  entries: TimelineEntry[],
  birthDate: string | null | undefined,
  now: number,
): Predictions {
  const months = ageInMonths(birthDate, now);
  const out: Predictions = {};

  const feeding = predictInterval("feeding", startsOf(entries, "feeding"), feedingPrior(months), 5 * MIN, 14 * HOUR, now);
  if (feeding) out.feeding = feeding;

  const diaper = predictInterval("diaper", startsOf(entries, "diaper"), DIAPER_PRIOR, 5 * MIN, 14 * HOUR, now);
  if (diaper) out.diaper = diaper;

  const sleep = predictSleep(entries, months, now);
  if (sleep) out.sleep = sleep;

  return out;
}
