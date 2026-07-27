/**
 * Last-night summary — "Nuit : 19:45 – 07:02 · 2 réveils" — derived from logged sleep entries.
 *
 * Pure: a function of the already-fetched timeline and `now`. The night is reconstructed as a
 * CHAIN of sleep segments around midnight: anchor on the segment that crosses midnight (or, if
 * the night was logged in pieces, the longest evening/early-morning segment), then absorb
 * neighbouring segments. A gap chains as a night waking when it's short (≤45 min), when it
 * falls entirely inside the core night hours (22:00–07:00), or when it contains a logged
 * feed/change (≤2 h) — a 3am feed routinely takes an hour before baby settles. The morning
 * nap is NOT absorbed: its wake window sits past 07:00 and exceeds the chaining gap.
 */
import type { TimelineEntry } from "../api";

export interface NightSummary {
  /** When the night began (fell asleep) and ended (morning wake), epoch ms. */
  startMs: number;
  endMs: number;
  /** Actual asleep time within the night (gaps excluded). */
  sleepMs: number;
  /** Number of night wakings (gaps ≥ 3 min between segments). */
  wakings: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A gap longer than this ends the night (it's the morning wake window, not a waking). */
const CHAIN_GAP_MS = 45 * MIN;
/** …unless the gap contains a logged feed or change: a night feed routinely takes 45–90 min
 *  before baby settles again, and that's still the same night, not the morning. */
const CARE_GAP_MS = 2 * HOUR;

export function lastNight(entries: TimelineEntry[], now: number): NightSummary | null {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const todayStart = d.getTime();
  const winStart = todayStart - 9 * HOUR; // 15:00 yesterday
  const winEnd = todayStart + 13 * HOUR;

  const segs = entries
    .filter((e) => e.activity === "sleep" && e.endMs != null)
    .map((e) => ({ start: e.startMs, end: e.endMs as number }))
    .filter((s) => s.end > winStart && s.start < winEnd && s.end <= now)
    .sort((a, b) => a.start - b.start);
  if (segs.length === 0) return null;

  // Core night hours: any waking that falls entirely between 22:00 and 07:00 belongs to the
  // night no matter how long it took to resettle.
  const coreStart = todayStart - 2 * HOUR;
  const coreEnd = todayStart + 7 * HOUR;
  // Care moments (feed / change starts) inside the window — a gap holding one chains as a
  // night waking even past CHAIN_GAP_MS.
  const care = entries
    .filter((e) => (e.activity === "feeding" || e.activity === "diaper") && e.startMs > winStart && e.startMs < winEnd)
    .map((e) => e.startMs);
  const chained = (prev: { end: number }, next: { start: number }): boolean => {
    const gap = next.start - prev.end;
    if (gap <= CHAIN_GAP_MS) return true;
    if (prev.end >= coreStart && next.start <= coreEnd) return true; // gap inside core night
    return gap <= CARE_GAP_MS && care.some((t) => t >= prev.end && t <= next.start);
  };

  // Anchor: the segment crossing midnight; else the longest one starting last evening / early
  // morning (a fully-logged night can be split into pieces that don't touch 00:00 exactly).
  let anchor = segs.findIndex((s) => s.start < todayStart && s.end > todayStart);
  if (anchor === -1) {
    let best = -1;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.start > todayStart + 3 * HOUR) continue; // started mid-morning → a nap
      if (best === -1 || s.end - s.start > segs[best].end - segs[best].start) best = i;
    }
    anchor = best;
  }
  if (anchor === -1) return null;

  let first = anchor;
  while (first > 0 && chained(segs[first - 1], segs[first])) first--;
  let last = anchor;
  while (last + 1 < segs.length && chained(segs[last], segs[last + 1])) last++;

  let sleepMs = 0;
  let wakings = 0;
  for (let i = first; i <= last; i++) {
    sleepMs += segs[i].end - segs[i].start;
    if (i > first && segs[i].start - segs[i - 1].end >= 3 * MIN) wakings++;
  }
  const startMs = segs[first].start;
  const endMs = segs[last].end;
  if (endMs - startMs < 3 * HOUR) return null; // too short to be "the night"
  return { startMs, endMs, sleepMs, wakings };
}
