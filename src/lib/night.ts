/**
 * Last-night summary — "Nuit : 19:45 – 07:02 · 2 réveils" — derived from logged sleep entries.
 *
 * Pure: a function of the already-fetched timeline and `now`. The night is reconstructed as a
 * CHAIN of sleep segments around midnight: anchor on the segment that crosses midnight (or, if
 * the night was logged in pieces, the longest evening/early-morning segment), then absorb
 * neighbouring segments separated by short gaps. Each gap is a night waking; the morning nap is
 * NOT absorbed because the morning wake window (~1 h+) exceeds the chaining gap.
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
  while (first > 0 && segs[first].start - segs[first - 1].end <= CHAIN_GAP_MS) first--;
  let last = anchor;
  while (last + 1 < segs.length && segs[last + 1].start - segs[last].end <= CHAIN_GAP_MS) last++;

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
