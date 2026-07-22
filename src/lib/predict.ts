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
 *   - Sleep/nap: the wake-window model — next onset ≈ last wake time + typical wake window. This
 *     is the behavioural proxy for the two-process model's homeostatic Process S; the time-of-day
 *     structure stands in for the circadian Process C. Wake windows lengthen with age (the age
 *     band is the cold-start prior + clamp) AND across the day, so observed windows are binned by
 *     time-of-day and the bin matching the last wake is used; the pre-bed bin gets headroom so
 *     bedtime isn't clamped to a nap ceiling.
 *   - Feeding & diaper: recency-weighted median of recent intervals, split by circadian period
 *     (day vs night) once a rhythm has emerged (~6 weeks) and predicted from the bucket matching
 *     the current period — daytime feeds run tighter than the long overnight stretch.
 *   - Non-stationarity: infant rhythms drift fastest in the early months, so all observed
 *     estimates are RECENCY-WEIGHTED (EWMA-style exponential decay) — recent days dominate while
 *     older data still informs. The weighted median keeps outlier-robustness; confidence uses the
 *     effective (not raw) sample size so a long-stale history can't masquerade as certainty.
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

/**
 * Day/night of a local timestamp. Daytime feeds/changes cluster tighter than the long
 * overnight stretch, so splitting by period removes the overnight bias from the daytime
 * estimate (day/night feeding rhythm consolidates ~2–4 months). Day = 07:00–19:00.
 */
const periodOf = (epochMs: number): "day" | "night" => {
  const h = new Date(epochMs).getHours();
  return h >= 7 && h < 19 ? "day" : "night";
};

const isDaytime = (epochMs: number): boolean => {
  const h = new Date(epochMs).getHours();
  return h >= 5 && h < 21;
};

/**
 * Recent gaps (ms) between consecutive starts (newest first), within a sane band, each tagged
 * with the period of the *earlier* event (the one the gap is measured from). Pulls up to `take`
 * so the day/night buckets each have enough samples.
 */
function recentIntervals(
  starts: number[],
  minGap: number,
  maxGap: number,
  take = 20,
): { gap: number; period: "day" | "night" }[] {
  const out: { gap: number; period: "day" | "night" }[] = [];
  for (let i = 0; i + 1 < starts.length && out.length < take; i++) {
    const gap = starts[i] - starts[i + 1];
    if (gap >= minGap && gap <= maxGap) out.push({ gap, period: periodOf(starts[i + 1]) });
  }
  return out;
}

// ── predictors ─────────────────────────────────────────────────────────────────

/**
 * Recency-weighted interval predictor for the rhythmic, point-in-time activities (feeding,
 * diaper). When the child is old enough for a circadian rhythm (`useCircadian`), it prefers the
 * day/night bucket matching the last event's period — daytime feeds run ~2–3 h apart while the
 * night stretches longer, so pooling both biases the daytime estimate. Recent observations are
 * weighted more (rhythms drift), and the estimate is a weighted median for outlier-robustness.
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

  const tagged = recentIntervals(starts, minGap, maxGap); // newest-first
  const period = periodOf(last);
  const matched = useCircadian ? tagged.filter((t) => t.period === period).map((t) => t.gap) : [];
  const sample = matched.length >= 3 ? matched : tagged.map((t) => t.gap);

  if (sample.length >= 3) {
    const w = recencyWeights(sample.length);
    return {
      activity,
      etaMs: last + weightedQuantile(sample, w, 0.5),
      lowMs: last + weightedQuantile(sample, w, 0.25),
      highMs: last + weightedQuantile(sample, w, 0.75),
      basis: "pattern",
      confidence: weightedConfidence(sample, w),
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
 * Time-of-day bin for a wake window, keyed by the wake (sleep END) hour. Wake windows lengthen
 * across the day — the first is shortest (high overnight sleep pressure), the pre-bed one is
 * longest — so binning beats a single daily median.
 */
const wakeBin = (epochMs: number): 0 | 1 | 2 => {
  const h = new Date(epochMs).getHours();
  return h < 10 ? 0 : h < 14 ? 1 : 2;
};

/**
 * Cold-start wake window (ms) from the age band, ramped by time of day: morning ≈ band.min,
 * evening ≈ band.max. Wake windows lengthen across the day — e.g. a 6-month-old's run ~2.0 h
 * (first nap) → ~2.75 h (pre-bed) per Huckleberry — so even without logged data the time of
 * day shapes the guess.
 */
function rampedWakeWindow(band: { min: number; max: number }, lastWake: number): number {
  const d = new Date(lastWake);
  const frac = clamp((d.getHours() + d.getMinutes() / 60 - 7) / 12, 0, 1); // 07:00→0, 19:00→1
  return (band.min + (band.max - band.min) * frac) * MIN;
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

  // Observed daytime wake windows (gap between a sleep's end and the next sleep's start), each
  // tagged with its time-of-day bin. The 10-min..6-h gate drops night-waking blips and the
  // overnight gap (a missing night-sleep log would otherwise look like an absurd "wake window").
  const windows: { gap: number; bin: 0 | 1 | 2 }[] = [];
  for (let i = 0; i + 1 < sleeps.length; i++) {
    const end = sleeps[i].endMs;
    if (end == null) continue;
    const gap = sleeps[i + 1].startMs - end;
    if (gap >= 10 * MIN && gap <= 6 * HOUR && isDaytime(end)) windows.push({ gap, bin: wakeBin(end) });
  }

  const bin = wakeBin(lastWake);
  // Reverse to newest-first so recency weighting favours the latest days.
  const matched = windows.filter((w) => w.bin === bin).map((w) => w.gap).reverse();
  const sample = matched.length >= 3 ? matched : windows.map((w) => w.gap).reverse();
  // The pre-bed (evening) window is the day's longest, so give the late bin headroom above the
  // nominal age band rather than clamping bedtime down to a daytime-nap ceiling.
  const cap = bin === 2 ? maxMs * 1.3 : maxMs;

  if (sample.length >= 3) {
    const wts = recencyWeights(sample.length);
    const ww = clamp(weightedQuantile(sample, wts, 0.5), minMs, cap); // clamp toward the age band
    return {
      activity: "sleep",
      etaMs: lastWake + ww,
      lowMs: lastWake + minMs,
      highMs: lastWake + cap,
      basis: "pattern",
      confidence: weightedConfidence(sample, wts),
    };
  }
  return {
    activity: "sleep",
    etaMs: lastWake + rampedWakeWindow(band, lastWake),
    lowMs: lastWake + minMs,
    highMs: lastWake + cap,
    basis: "age",
    confidence: AGE_BASIS_CONFIDENCE,
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
  const months = ageInMonths(birthDate, startMs);
  const sleeps = entries.filter(
    (e): e is Extract<TimelineEntry, { activity: "sleep" }> => e.activity === "sleep" && e.endMs != null,
  );
  const startHour = new Date(startMs).getHours();
  const isNightStart = startHour >= 17 || startHour < 4;

  if (isNightStart) {
    // Morning wake clock-times (minutes since midnight) of the final night segments, newest first.
    const wakes = sleeps
      .filter((e) => {
        const eh = new Date(e.endMs as number).getHours();
        return eh >= 4 && eh < 12 && (e.endMs as number) - e.startMs >= HOUR;
      })
      .sort((a, b) => (b.endMs as number) - (a.endMs as number))
      .slice(0, 10)
      .map((e) => {
        const d = new Date(e.endMs as number);
        return d.getHours() * 60 + d.getMinutes();
      });
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

  // Nap: recent daytime durations, preferring the bin matching this start's time of day.
  const naps = sleeps
    .filter((e) => isDaytime(e.startMs))
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
 * How long a passed eta stays on screen as "late by X" before the prediction is treated as
 * expired and hidden. Past this, the guess said nothing useful — showing "expected 16h ago"
 * under a "Prediction" header reads as an event, not a forecast.
 */
export const PREDICTION_GRACE_MS = 60 * 60_000;

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
  // A robust day/night rhythm isn't present until ~6–12 weeks, so only split feeds/changes by
  // circadian period once the child is old enough; before that, pool all intervals.
  const useCircadian = !(months >= 0) || months >= 1.5;
  const out: Predictions = {};

  const feeding = predictInterval("feeding", startsOf(entries, "feeding"), feedingPrior(months), 5 * MIN, 14 * HOUR, now, useCircadian);
  if (feeding) out.feeding = feeding;

  const diaper = predictInterval("diaper", startsOf(entries, "diaper"), DIAPER_PRIOR, 5 * MIN, 14 * HOUR, now, useCircadian);
  if (diaper) out.diaper = diaper;

  const sleep = predictSleep(entries, months, now);
  if (sleep) out.sleep = sleep;

  return out;
}
