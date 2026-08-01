/**
 * Calendar — the timeline page's multi-mode view: Day / Week (time-grid heatmaps), List (the
 * classic grouped list), and Summary (period statistics). Day/Week/Summary fetch the visible
 * date range; List reuses the recent-entries list passed from Home so its optimistic delete /
 * tombstone behaviour is preserved.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BabyBuddyClient, TimelineEntry } from "../api";
import { useStyles, useTheme } from "../theme";
import { ACTIVITY_ICON, PlusIcon, RadioactiveDropIcon, RadioactiveIcon, SunriseIcon, SunsetIcon } from "../ui/icons";
import { clockTime } from "../lib/datetime";
import { activityLabel } from "../lib/labels";
import { useFocusTrap } from "./useFocusTrap";
import { hm } from "../lib/format";
import { predictNext, predictSleepEnd, predictionAlive, type ActivityPrediction } from "../lib/predict";
import { tummyGoalForAge } from "../lib/tummy";
import { sunTimes } from "../lib/sun";
import { useEntriesInRange, useGeo, useNow, buzz } from "./hooks";
import { EntryRow, Timeline } from "./Timeline";

type CalMode = "day" | "week" | "list" | "summary";
const MODES: CalMode[] = ["list", "day", "week", "summary"];

const DEFAULT_HOUR_PX = 24; // pixels per hour at default zoom (24 h ≈ 576 px)
const MIN_HOUR_PX = 14;
const MAX_HOUR_PX = 72;
const ZOOM_KEY = "baby-log:calzoom";
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Monday-start week containing `ms`. */
const startOfWeek = (ms: number): number => {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};
const addDays = (ms: number, n: number): number => {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface Range {
  from: number;
  to: number;
  days: number[];
}
// Boundaries go through addDays (Date.setDate) rather than `+ n * DAY_MS`: on DST transition
// days the local day is 23 or 25 hours, and fixed-ms arithmetic would shift the range by an
// hour — dropping (or borrowing) entries at the edge of the day/week.
function rangeFor(mode: CalMode, anchor: number): Range {
  if (mode === "day") return { from: anchor, to: addDays(anchor, 1), days: [anchor] };
  const from = startOfWeek(anchor); // week + summary
  return { from, to: addDays(from, 7), days: Array.from({ length: 7 }, (_, i) => addDays(from, i)) };
}

export function Calendar({
  client,
  childId,
  birthDate,
  listEntries,
  listUpdatedAt,
  listError,
  listHasMore,
  listLoadingMore,
  onListMore,
  onRetryList,
  onAdd,
  onEdit,
  showPredictions = true,
}: {
  client: BabyBuddyClient;
  childId: number | null;
  birthDate: string | null | undefined;
  listEntries: TimelineEntry[] | null;
  listUpdatedAt?: number;
  /** The list's tail is truncated (more history on the server) → auto-load as it scrolls in. */
  listHasMore?: boolean;
  listLoadingMore?: boolean;
  onListMore?: () => void;
  /** List-mode cold-start failure state + its retry, forwarded to `Timeline`. */
  listError?: boolean;
  onRetryList?: () => void;
  onAdd: () => void;
  onEdit: (e: TimelineEntry) => void;
  /** Off = the day dial hides its predicted ghost markers and centre eta (facts stay). */
  showPredictions?: boolean;
}) {
  const { s } = useStyles();
  const { t } = useTranslation();

  // Always open on the list — it's the workhorse view; the fancier modes are a tap away.
  const [mode, setMode] = useState<CalMode>("list");
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const now = useNow(60_000); // 1-min tick (drives "today" highlight + the now-line)
  const [hourPx, setHourPx] = useState(() => {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return v >= MIN_HOUR_PX && v <= MAX_HOUR_PX ? v : DEFAULT_HOUR_PX;
  });

  const pickMode = (m: CalMode) => {
    buzz();
    setMode(m);
  };
  // Pinch-to-zoom sets the vertical scale (px/hour); persist only when the gesture settles.
  const applyZoom = useCallback((px: number, persist: boolean) => {
    const n = Math.round(clamp(px, MIN_HOUR_PX, MAX_HOUR_PX));
    setHourPx(n);
    if (persist) localStorage.setItem(ZOOM_KEY, String(n));
  }, []);

  const range = useMemo(() => rangeFor(mode, anchor), [mode, anchor]);
  const { entries: rangeEntries } = useEntriesInRange(client, childId, range.from, range.to, mode !== "list");
  // Previous week, for the Résumé's week-over-week deltas.
  const { entries: prevEntries } = useEntriesInRange(client, childId, addDays(range.from, -7), range.from, mode === "summary");

  const step = (dir: -1 | 1) => {
    buzz();
    setAnchor((a) => addDays(a, dir * (mode === "day" ? 1 : 7)));
  };
  const isToday = useMemo(() => {
    const today = startOfDay(now);
    return mode === "day" ? anchor === today : startOfWeek(anchor) === startOfWeek(today);
  }, [anchor, mode, now]);

  return (
    <section style={s.cal}>
      <div style={s.segWrap} role="tablist" aria-label={t("nav.timeline")}>
        {MODES.map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => pickMode(m)} style={{ ...s.segBtn, ...(mode === m ? s.segBtnOn : {}) }}>
            {t(`cal.${m}`)}
          </button>
        ))}
      </div>

      {mode !== "list" && (
        <div style={s.periodNav}>
          <button onClick={() => step(-1)} style={s.periodArrow} aria-label={t("cal.previous")}>‹</button>
          <span style={s.periodLabel}>{periodLabel(mode, range)}</span>
          <button onClick={() => step(1)} style={s.periodArrow} aria-label={t("cal.next")} disabled={isToday} aria-disabled={isToday}>›</button>
          {!isToday && (
            <button onClick={() => { buzz(); setAnchor(startOfDay(now)); }} style={s.todayBtn}>{t("cal.today")}</button>
          )}
        </div>
      )}

      {mode === "list" ? (
        <Timeline entries={listEntries} updatedAt={listUpdatedAt} showAdd={false} onEdit={onEdit} error={listError} onRetry={onRetryList} hasMore={listHasMore} loadingMore={listLoadingMore} onMore={onListMore} />
      ) : mode === "summary" ? (
        <SummaryView entries={rangeEntries} prevEntries={prevEntries} range={range} birthDate={birthDate} />
      ) : mode === "day" ? (
        <RadialDay entries={rangeEntries} range={range} birthDate={birthDate} onEdit={onEdit} showPredictions={showPredictions} />
      ) : (
        <TimeGrid entries={rangeEntries} range={range} hourPx={hourPx} onZoom={applyZoom} onEdit={onEdit} />
      )}

      {/* Persistent, thumb-reachable add button floating at the bottom of the screen. */}
      <div style={s.addBar}>
        <button onClick={onAdd} style={{ ...s.addBtn, marginBottom: 0 }}>
          <span style={s.addPlus}><PlusIcon size={18} /></span>
          {t("timeline.addEntry")}
        </button>
      </div>
    </section>
  );
}

function periodLabel(mode: CalMode, range: Range): string {
  const loc = undefined; // active locale via toLocale*
  if (mode === "day") {
    return new Date(range.from).toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "short" });
  }
  const end = new Date(addDays(range.to, -1));
  const start = new Date(range.from);
  const sameMonth = start.getMonth() === end.getMonth();
  const startStr = start.toLocaleDateString(loc, { day: "numeric", ...(sameMonth ? {} : { month: "short" }) });
  const endStr = end.toLocaleDateString(loc, { day: "numeric", month: "short" });
  return `${startStr} – ${endStr}`;
}

// ── Radial day clock ─────────────────────────────────────────────────────────────
// A bedtime-to-bedtime arc, open at the bottom: bedtime sits bottom-left, the night runs up
// the left, the waking day across the top, and the next bedtime lands bottom-right.
// EVERYTHING lives on one fat ring: timed activities as rounded arc pills, instants as dots —
// each carrying its activity icon so the dial is legible at a glance. The centre shows the
// next-event prediction (today) or the day's totals.
const RCX = 160;
const RCY = 160;
const R_RING = 118; // the single band everything lives on
const RING_W = 40; // band (and arc) thickness
const ARC_SPAN = 300; // degrees the window covers; the rest is the bottom opening
const ARC_START = 180 + (360 - ARC_SPAN) / 2; // gap centred on the bottom

const polar = (deg: number, rad: number) => {
  const a = (deg * Math.PI) / 180;
  return { x: RCX + rad * Math.sin(a), y: RCY - rad * Math.cos(a) };
};
const arcPath = (a0: number, a1: number, rad: number): string => {
  const s = polar(a0, rad);
  const e = polar(a1, rad);
  const large = (a1 - a0 + 360) % 360 > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${rad} ${rad} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
};

function RadialDay({
  entries,
  range,
  birthDate,
  onEdit,
  showPredictions = true,
}: {
  entries: TimelineEntry[] | null;
  range: Range;
  birthDate: string | null | undefined;
  onEdit: (e: TimelineEntry) => void;
  showPredictions?: boolean;
}) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const now = useNow(30_000);
  const dayStart = range.days[0];
  const dayEnd = addDays(dayStart, 1); // DST-safe: a local day can be 23 or 25 h
  const isToday = dayStart === startOfDay(now);
  const list = entries ?? [];
  // Which centre slide is showing — tap cycles; modulo at read time keeps it valid across days.
  const [statIdx, setStatIdx] = useState(0);
  // Entries behind a folded tick ("2× 🍼") — non-null opens the picker sheet.
  const [pick, setPick] = useState<TimelineEntry[] | null>(null);
  const pickRef = useFocusTrap<HTMLDivElement>(pick != null);
  useEffect(() => setPick(null), [dayStart]); // day navigation invalidates the selection
  useEffect(() => {
    if (pick == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPick(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick]);

  // Bedtime-to-bedtime "baby day": each edge anchors on the night sleep crossing that
  // midnight (fallback 21:00 when none is logged, e.g. tonight's). The arc leaves ARC_GAP°
  // open at the bottom — bedtime bottom-left, morning up the left, next bedtime bottom-right.
  const bedAnchor = (midnight: number): number => {
    const crossing = list.find(
      (e) => e.activity === "sleep" && e.startMs < midnight && e.startMs > midnight - 8 * 3_600_000 && (e.endMs ?? e.startMs) > midnight,
    );
    return crossing ? crossing.startMs : midnight - 3 * 3_600_000;
  };
  const winStart = bedAnchor(dayStart);
  const winEnd = bedAnchor(dayEnd);

  const angleOf = (ms: number) => ARC_START + ((clamp(ms, winStart, winEnd) - winStart) / (winEnd - winStart)) * ARC_SPAN;

  const sleeps = list.filter((e) => e.activity === "sleep" && e.endMs != null && e.endMs > winStart && e.startMs < winEnd);
  const bars = list.filter((e) => (e.activity === "feeding" || e.activity === "tummy") && e.startMs < winEnd && (e.endMs ?? e.startMs) >= winStart);
  const diapers = list.filter((e): e is Extract<TimelineEntry, { activity: "diaper" }> => e.activity === "diaper" && e.startMs >= winStart && e.startMs < winEnd);
  const meds = list.filter((e) => e.activity === "medication" && e.startMs >= winStart && e.startMs < winEnd);

  let sleepMs = 0;
  for (const e of sleeps) sleepMs += Math.min(e.endMs as number, winEnd) - Math.max(e.startMs, winStart);
  // Day stats for the dial centre (past days) and the composition bar: totals per activity.
  let tummyMs = 0;
  let feedMs = 0;
  for (const e of bars) {
    const span = Math.min(e.endMs ?? e.startMs, winEnd) - Math.max(e.startMs, winStart);
    if (e.activity === "tummy") tummyMs += span;
    else feedMs += span;
  }
  const feedCount = list.filter((e) => e.activity === "feeding" && e.startMs >= winStart && e.startMs < winEnd).length;
  // Wet/solid overlap ("les deux" counts in both), matching the Résumé's split.
  const wetCount = diapers.filter((e) => e.wet).length;
  const solidCount = diapers.filter((e) => e.solid).length;
  // Awake = the elapsed window minus everything logged (never counts future time today).
  const barEnd = Math.min(Math.max(now, winStart + 60_000), winEnd);
  const awakeMs = Math.max(0, barEnd - winStart - sleepMs - tummyMs - feedMs);

  // Predicted upcoming events (today only) — shown as dashed "ghost" markers on the ring.
  // Long-expired etas are dropped, same rule as the home panel.
  const preds = isToday && showPredictions
    ? (Object.values(predictNext(list, birthDate, now)) as ActivityPrediction[]).filter((p) => p.confidence >= 0.1 && predictionAlive(p, now))
    : [];
  const soonest = [...preds].sort((a, b) => a.etaMs - b.etaMs)[0];
  const predMarks = preds.filter((p) => p.etaMs > now && p.etaMs < winEnd);

  // Sunrise / sunset for the viewed day (when we have a location).
  const geo = useGeo();
  const sun = geo ? sunTimes(dayStart + 12 * 3_600_000, geo.lat, geo.lng) : null;
  // Today's sunset often falls AFTER the anticipated bedtime edge (21:00 fallback) — keep it:
  // anything belonging to the calendar day stays, clamped by angleOf to the arc end.
  const sunMarks = sun
    ? ([
        { key: "sunrise", ms: sun.sunrise, color: "#f3c14e" },
        { key: "sunset", ms: sun.sunset, color: "#e8895b" },
      ] as const).filter((m) => m.ms >= winStart && m.ms < Math.max(winEnd, dayEnd))
    : [];

  // 24-hour scale, a label every 3 h — matches the clock format used everywhere else.
  const hours = [0, 3, 6, 9, 12, 15, 18, 21];
  const hourLabel = (h: number) => `${String(h).padStart(2, "0")}h`;

  // Clickable marks act as buttons (keyboard + AT). The visible mark IS the hit target — no
  // hidden enlarged hit zones: neighbouring marks sit close on a busy day, and an invisible
  // halo makes taps land on the wrong entry.
  const entryLabel = (e: TimelineEntry) => `${activityLabel(e.activity)} ${clockTime(e.startMs)}`;
  const timeLabel = (key: string, deg: number, color: string, ms: number) => {
    const lp = polar(deg, R_RING + RING_W / 2 + 28);
    return (
      <text key={key} x={lp.x} y={lp.y} fill={color} fontSize={10} fontWeight={800} textAnchor="middle" dominantBaseline="middle">
        {clockTime(ms)}
      </text>
    );
  };

  // Watch-dial vocabulary: EVERY mark fills the band's height and its visual length along
  // the band IS its true [start, end] span. Long events are full-band pills — the round caps
  // overshoot each end by half the width, so the path is inset to keep the visible pill on
  // [start, end]. Events too short for those fat caps keep the full band height but shorten
  // their tip rounding instead (radius = half the span — same rounded-rect family, so the
  // shapes morph continuously). Only a near-instant span (under ~25 min, unreadable as a
  // length) renders as a radial tick — a watch index.
  const CAP_DEG = (RING_W / 2 / R_RING) * (180 / Math.PI);
  const clippedAngles = (e: TimelineEntry): [number, number] => [
    angleOf(Math.max(e.startMs, winStart)),
    angleOf(Math.min(Math.max(e.endMs ?? e.startMs, e.startMs), winEnd)),
  ];
  const midDeg = (e: TimelineEntry) => {
    const [a0, a1] = clippedAngles(e);
    return (a0 + a1) / 2;
  };
  /** Clipped span length in px along the band — the mark's visual length. */
  const spanPx = (e: TimelineEntry) => {
    const [a0, a1] = clippedAngles(e);
    return ((a1 - a0) / 180) * Math.PI * R_RING;
  };
  /** Too short to read as a length → joins the tick layer instead of the arc layer. */
  const isTick = (e: TimelineEntry) => spanPx(e) < 10;
  const spanArc = (e: TimelineEntry) => {
    const [a0, a1] = clippedAngles(e);
    const accent = palette.accents[e.activity].accent;
    const len = spanPx(e);
    const opacity = e.activity === "sleep" ? 0.45 : 0.9;
    // Short-span capsule: a radial stroke whose round caps reach the band edges — full band
    // height, width = the true span, tip rounding len/2. Drawn at its band-lane slot (the
    // collision pass may nudge it off dead-centre; the width stays truthful).
    const half = Math.max(0, RING_W - len) / 2;
    const cDeg = capsuleDeg.get(e) ?? midDeg(e);
    const p1 = polar(cDeg, R_RING - half);
    const p2 = polar(cDeg, R_RING + half);
    // Pill inset never crosses the mid-span (degenerate zero-length arcs render nothing).
    const capIn = Math.min(CAP_DEG, (a1 - a0) / 2 - 0.01);
    return (
      <g
        key={`${e.path}${e.id}`}
        style={{ color: accent, cursor: "pointer" }}
        onClick={() => onEdit(e)}
        role="button"
        tabIndex={0}
        aria-label={entryLabel(e)}
        onKeyDown={(ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault(); // Space must not scroll the page
          onEdit(e);
        }}
      >
        {len < RING_W ? (
          <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="currentColor" strokeWidth={len} strokeLinecap="round" opacity={opacity} />
        ) : (
          <path d={arcPath(a0 + capIn, a1 - capIn, R_RING)} fill="none" stroke="currentColor" strokeWidth={RING_W} strokeLinecap="round" opacity={opacity} />
        )}
      </g>
    );
  };

  // The tick layer — watch indices crossing the band radially: instants, predictions and any
  // span too short for the fat caps. Layered strokes encode the diaper type — solid = selles,
  // hollow = pipi, hollow with a centre thread = les deux; color is identity, as everywhere.
  // Collision handling lives in the shared band lane below.
  interface Tick {
    key: string;
    deg: number;
    accent: string;
    kind: "solid" | "hollow" | "thread";
    Icon: (p: { size?: number }) => ReactNode;
    dashed?: boolean;
    onClick?: () => void;
    label?: string;
    labelMs?: number;
    /** ≥2 = a folded run of same-glyph events; the orbit shows "N×" and tap opens a picker. */
    count?: number;
  }
  // Same-glyph events in a tight run fold into ONE tick — a cluster feed or a burst of
  // changes reads as a single "N×" mark instead of a smear of nudged ticks.
  const FOLD_MS = 25 * 60_000; // one tick-width of time: the same threshold that makes a tick
  interface TickSeed {
    entry: TimelineEntry;
    ms: number;
    deg: number;
    fold: string;
    kind: Tick["kind"];
    Icon: Tick["Icon"];
  }
  const seeds: TickSeed[] = [
    ...[...sleeps, ...bars].filter(isTick).map((e): TickSeed => ({ entry: e, ms: e.startMs, deg: midDeg(e), fold: e.activity, kind: "solid", Icon: ACTIVITY_ICON[e.activity] })),
    // Orbit glyph mirrors the tick's coding: drop = wet, trefoil = solid, trefoil+drop = both.
    // The fold key includes the diaper kind so a pipi run never swallows a selles change.
    ...diapers.map((e): TickSeed => ({ entry: e, ms: e.startMs, deg: angleOf(e.startMs), fold: `diaper-${e.wet}-${e.solid}`, kind: e.wet && e.solid ? "thread" : e.solid ? "solid" : "hollow", Icon: e.wet && e.solid ? RadioactiveDropIcon : e.solid ? RadioactiveIcon : ACTIVITY_ICON.diaper })),
    ...meds.map((e): TickSeed => ({ entry: e, ms: e.startMs, deg: angleOf(e.startMs), fold: "medication", kind: "solid", Icon: ACTIVITY_ICON.medication })),
  ].sort((a, b) => a.ms - b.ms);
  // A fold only merges CONSECUTIVE same-glyph events: any event of another type landing
  // in between (another tick kind, a capsule, a sleep) breaks the run — "feed, change,
  // feed" stays three marks even when it all happens within FOLD_MS.
  const stream: { ms: number; fold: string; seed?: TickSeed }[] = [
    ...seeds.map((s) => ({ ms: s.ms, fold: s.fold, seed: s })),
    ...[...sleeps, ...bars].filter((e) => !isTick(e)).map((e) => ({ ms: e.startMs, fold: `x-${e.path}${e.id}` })),
  ].sort((a, b) => a.ms - b.ms);
  const groups: TickSeed[][] = [];
  for (let i = 0; i < stream.length; i++) {
    const it = stream[i];
    if (!it.seed) continue;
    const prev = stream[i - 1];
    const open = groups[groups.length - 1];
    if (open && prev?.seed && prev.fold === it.fold && it.ms - prev.ms <= FOLD_MS) open.push(it.seed);
    else groups.push([it.seed]);
  }
  const ticks: Tick[] = [
    ...groups.map((g): Tick => {
      const { entry: e, deg, kind, Icon } = g[0];
      const accent = palette.accents[e.activity].accent;
      if (g.length === 1) return { key: `d-${e.path}${e.id}`, deg, accent, kind, Icon, onClick: () => onEdit(e), label: entryLabel(e) };
      const members = g.map((s) => s.entry);
      return {
        key: `d-${e.path}${e.id}`,
        deg: g.reduce((sum, s) => sum + s.deg, 0) / g.length,
        accent,
        kind,
        Icon,
        count: g.length,
        onClick: () => setPick(members),
        label: `${g.length}× ${activityLabel(e.activity)}`,
      };
    }),
    ...predMarks.map((p): Tick => ({ key: `pd-${p.activity}`, deg: angleOf(p.etaMs), accent: palette.accents[p.activity].accent, kind: "hollow", Icon: ACTIVITY_ICON[p.activity], dashed: true, labelMs: p.etaMs })),
  ];
  const ARC_END = ARC_START + ARC_SPAN;
  // ── The band lane ────────────────────────────────────────────────────────────
  // One band, no overlaps. Sleeps (and any full-width pill) are the anchored skeleton of
  // the day: they never move and nothing may be drawn across them. They carve the band
  // into free segments; the movable marks (ticks + capsules) lay out inside the segment
  // holding their true position — a mark whose instant falls INSIDE a sleep (a feed logged
  // during a nap) snaps to the nearest sleep edge instead of sitting on top of it. Within
  // a segment marks keep their true width and nudge apart minimally — position gives way,
  // width never lies — and an over-full segment compresses instead of spilling onto a
  // neighbouring sleep or past the arc tips onto the bare page.
  const TICK_HW = 2.75; // half a tick's slot in degrees — matches the old 5.5° separation
  const LANE_GAP = 0.4;
  interface LaneItem {
    deg: number;
    hw: number;
    tick?: Tick;
    capsule?: TimelineEntry;
  }
  const capsules = bars.filter((e) => !isTick(e) && spanPx(e) < RING_W);
  const movables: LaneItem[] = [
    ...capsules.map((e): LaneItem => {
      const [a0, a1] = clippedAngles(e);
      return { deg: (a0 + a1) / 2, hw: (a1 - a0) / 2, capsule: e };
    }),
    ...ticks.map((t): LaneItem => ({ deg: t.deg, hw: TICK_HW, tick: t })),
  ];
  const fixedSpans = [...sleeps, ...bars]
    .filter((e) => !isTick(e) && (e.activity === "sleep" || spanPx(e) >= RING_W))
    .map((e) => clippedAngles(e))
    .sort((a, b) => a[0] - b[0]);
  const blocked: [number, number][] = [];
  for (const [a, b] of fixedSpans) {
    const last = blocked[blocked.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else blocked.push([a, b]);
  }
  const segments: [number, number][] = [];
  let segLo = ARC_START;
  for (const [a, b] of blocked) {
    if (a > segLo) segments.push([segLo, a]);
    segLo = Math.max(segLo, b);
  }
  if (segLo < ARC_END) segments.push([segLo, ARC_END]);
  if (segments.length === 0) segments.push([ARC_START, ARC_END]); // a fully-slept window
  const buckets: LaneItem[][] = segments.map(() => []);
  for (const it of movables) {
    let d = it.deg;
    for (const [a, b] of blocked) {
      if (d > a && d < b) {
        d = d - a < b - d ? a : b; // inside a sleep → nearest edge
        break;
      }
    }
    let idx = segments.findIndex(([a, b]) => d >= a && d <= b);
    if (idx === -1) idx = d < segments[0][0] ? 0 : segments.length - 1;
    it.deg = d;
    buckets[idx].push(it);
  }
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const items = buckets[sIdx].sort((a, b) => a.deg - b.deg);
    if (items.length === 0) continue;
    const [lo, hi] = segments[sIdx];
    const need = items.reduce((sum, it) => sum + 2 * it.hw, 0) + LANE_GAP * (items.length + 1);
    const k = Math.min(1, (hi - lo) / need); // over-full → compress slots, never spill
    // Forward min pass, backward max pass, forward again: with k guaranteeing fit, three
    // passes settle every mark inside [lo, hi] with its neighbours respected.
    const fwd = () => {
      let min = lo + LANE_GAP * k;
      for (const it of items) {
        const w = it.hw * k;
        if (it.deg < min + w) it.deg = min + w;
        min = it.deg + w + LANE_GAP * k;
      }
    };
    fwd();
    let max = hi - LANE_GAP * k;
    for (let i = items.length - 1; i >= 0; i--) {
      const w = items[i].hw * k;
      if (items[i].deg > max - w) items[i].deg = max - w;
      max = items[i].deg - w - LANE_GAP * k;
    }
    fwd();
  }
  /** Placed band position per capsule; ticks carry theirs on the Tick itself. */
  const capsuleDeg = new Map<TimelineEntry, number>();
  for (const it of movables) {
    if (it.tick) it.tick.deg = it.deg;
    else if (it.capsule) capsuleDeg.set(it.capsule, it.deg);
  }

  // A quiet icon orbit just outside the band: one bare glyph per mark (no discs, no leader
  // lines — radial proximity does the linking). Each glyph is anchored to its mark's placed
  // angle and may drift only a FEW degrees to keep neighbouring glyphs apart — enough to
  // separate a pair, never enough to visually detach from its mark (folding handles the
  // same-type crowds). Sun marks live inside; predicted ("ghost") glyphs render half-faded.
  const ICON_R = R_RING + RING_W / 2 + 13;
  interface OrbitIcon {
    key: string;
    deg: number;
    /** The mark's placed angle — the icon's home it may only drift ICON_DRIFT away from. */
    anchor: number;
    color: string;
    Icon: (p: { size?: number }) => ReactNode;
    ghost?: boolean;
    labelMs?: number;
    count?: number;
  }
  const icons: OrbitIcon[] = [
    ...[...sleeps, ...bars].filter((e) => !isTick(e)).map((e): OrbitIcon => {
      const deg = capsuleDeg.get(e) ?? midDeg(e);
      return { key: `i-${e.path}${e.id}`, deg, anchor: deg, color: palette.accents[e.activity].accent, Icon: ACTIVITY_ICON[e.activity] };
    }),
    ...ticks.map((t): OrbitIcon => ({ key: `i-${t.key}`, deg: t.deg, anchor: t.deg, color: t.accent, Icon: t.Icon, ghost: t.dashed, labelMs: t.labelMs, count: t.count })),
  ].sort((a, b) => a.deg - b.deg);
  const ICON_DRIFT = 3.5; // ≈9 px along the orbit — a nudge, not a relocation
  const isep = (15 / ICON_R) * (180 / Math.PI) + 0.6; // one glyph width + breathing room
  for (let i = 1; i < icons.length; i++) {
    if (icons[i].deg < icons[i - 1].deg + isep) icons[i].deg = Math.min(icons[i - 1].deg + isep, icons[i].anchor + ICON_DRIFT);
  }
  if (icons.length > 0) {
    icons[icons.length - 1].deg = Math.min(icons[icons.length - 1].deg, ARC_END);
    for (let i = icons.length - 2; i >= 0; i--) {
      if (icons[i].deg > icons[i + 1].deg - isep) icons[i].deg = Math.max(icons[i + 1].deg - isep, icons[i].anchor - ICON_DRIFT);
    }
  }
  const tick = (m: Tick) => {
    const p1 = polar(m.deg, R_RING - (RING_W / 2 - 5));
    const p2 = polar(m.deg, R_RING + (RING_W / 2 - 5));
    const line = (stroke: string, w: number, dashed?: boolean) => (
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={stroke} strokeWidth={w} strokeLinecap="round" strokeDasharray={dashed ? "2.5 3.5" : undefined} />
    );
    const clickable = !!m.onClick;
    return (
      <g
        key={m.key}
        style={{ color: m.accent, cursor: clickable ? "pointer" : undefined }}
        onClick={m.onClick}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? m.label : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault(); // Space must not scroll the page
                m.onClick?.();
              }
            : undefined
        }
      >
        {line("currentColor", 8.5, m.dashed)}
        {m.kind !== "solid" && line(palette.tileBase, 4)}
        {m.kind === "thread" && line("currentColor", 1.6)}
      </g>
    );
  };

  return (
    <>
    <div style={s.radialWrap}>
      {/* Canvas extends below the open arc so the window-edge date labels sit UNDER the dial
          (never overlaying the marks near the arc ends). */}
      <svg viewBox="0 0 320 316" style={s.radialSvg} role="img">
        {/* the single fat ring everything sits on — an open arc, not a full circle. Inset by
            the round-cap overshoot so its visible tips land exactly on ARC_START/ARC_END —
            an event at a window edge must visually reach the end of the ring. */}
        <path d={arcPath(ARC_START + CAP_DEG, ARC_START + ARC_SPAN - CAP_DEG, R_RING)} fill="none" stroke={palette.surfaceBorder} strokeWidth={RING_W} strokeLinecap="round" opacity={0.55} />
        {/* hourly graduations hugging the band's inner edge — a quiet clock scale that makes
            positions readable at a glance. The 3-hour anchors are the text labels themselves,
            so those hours skip their tick. Wall-clock stepping stays truthful across DST. */}
        {(() => {
          const marks: ReactNode[] = [];
          const d = new Date(winStart);
          d.setMinutes(0, 0, 0);
          for (;;) {
            d.setHours(d.getHours() + 1);
            const ms = d.getTime();
            if (ms >= winEnd) break;
            if (d.getHours() % 3 === 0) continue;
            const p1 = polar(angleOf(ms), R_RING - RING_W / 2 - 4);
            const p2 = polar(angleOf(ms), R_RING - RING_W / 2 - 8);
            marks.push(<line key={ms} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={palette.textFainter} strokeWidth={1.5} strokeLinecap="round" opacity={0.5} />);
          }
          return marks;
        })()}
        {[...sleeps, ...bars].filter((e) => !isTick(e)).map((e) => spanArc(e))}
        {/* predicted sleep: a dashed ghost arc spanning the expected onset → wake */}
        {predMarks
          .filter((p) => p.activity === "sleep")
          .map((p) => {
            const se = predictSleepEnd(list, birthDate, p.etaMs);
            if (!se || se.confidence < 0.3) return null;
            const a0 = angleOf(p.etaMs);
            const a1 = Math.max(angleOf(Math.min(se.endMs, winEnd)), a0 + 2);
            return (
              <path
                key="pred-sleep-arc"
                d={arcPath(a0, a1, R_RING)}
                fill="none"
                stroke={palette.accents.sleep.accent}
                strokeWidth={7}
                strokeLinecap="round"
                strokeDasharray="2.5 6"
                opacity={0.9}
              />
            );
          })}
        {/* instants + short events as watch-index ticks crossing the band */}
        {ticks.map((m) => tick(m))}
        {/* the icon orbit: one bare glyph per mark, just outside the band */}
        {icons.map((ic) => {
          const c = polar(ic.deg, ICON_R);
          const cp = polar(ic.deg, ICON_R + 13.5); // "N×" sits just outside its glyph, radially
          const Icon = ic.Icon;
          return (
            <g key={ic.key} style={{ color: ic.color }} opacity={ic.ghost ? 0.55 : 1} aria-hidden>
              <g transform={`translate(${(c.x - 7.5).toFixed(2)}, ${(c.y - 7.5).toFixed(2)})`}>
                <Icon size={15} />
              </g>
              {ic.count != null && (
                <text x={cp.x} y={cp.y} fill="currentColor" fontSize={9.5} fontWeight={800} textAnchor="middle" dominantBaseline="middle">
                  {ic.count}×
                </text>
              )}
              {ic.labelMs != null && timeLabel(`${ic.key}-t`, ic.deg, ic.color, ic.labelMs)}
            </g>
          );
        })}
        {/* sunrise / sunset INSIDE the ring (the outer orbit belongs to event glyphs), glyph
            stacked over its time; a colliding hour label yields (see the hours block) */}
        {sunMarks.map((m) => {
          const g = polar(angleOf(m.ms), R_RING - 34);
          const Icon = m.key === "sunrise" ? SunriseIcon : SunsetIcon;
          return (
            <g key={`sun-${m.key}`} style={{ color: m.color }} aria-hidden>
              <g transform={`translate(${(g.x - 7).toFixed(2)}, ${(g.y - 13).toFixed(2)})`}>
                <Icon size={14} />
              </g>
              <text x={g.x} y={g.y + 11} fill={m.color} fontSize={9.5} fontWeight={800} textAnchor="middle">
                {clockTime(m.ms)}
              </text>
            </g>
          );
        })}
        {/* "now" — a rounded radial tick crossing the ring, drawn on top of arcs and badges */}
        {isToday && now >= winStart && now < winEnd && (() => {
          const deg = angleOf(now);
          const p1 = polar(deg, R_RING - RING_W / 2 - 5);
          const p2 = polar(deg, R_RING + RING_W / 2 + 5);
          /* Teardrop cap: a circle + tip triangle (their union reads as a drop), with the tail
             rotated to point at `toward` — i.e. along the line. */
          // White on the dark theme; ink on the light paper theme, where white would wash out.
          const nowColor = palette.name === "dark" ? "#fff" : palette.text;
          const drop = (at: { x: number; y: number }, toward: { x: number; y: number }, key: string) => {
            const ang = (Math.atan2(toward.y - at.y, toward.x - at.x) * 180) / Math.PI - 90;
            return (
              <g key={key} transform={`translate(${at.x.toFixed(2)}, ${at.y.toFixed(2)}) rotate(${ang.toFixed(1)})`} fill={nowColor}>
                <circle r={4} />
                <path d="M 3.46 2 L 0 9 L -3.46 2 Z" />
              </g>
            );
          };
          return (
            /* thin line with teardrop caps at both ends */
            <g>
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={nowColor} strokeWidth={2} strokeLinecap="round" />
              {drop(p1, p2, "c1")}
              {drop(p2, p1, "c2")}
            </g>
          );
        })()}
        {/* hour scale sits INSIDE the ring so it can't collide with the marker time labels.
            Marks anchor to the actual LOCAL o'clock instant (setHours), so they stay truthful
            on 23/25-hour DST days where `dayStart + h * 3_600_000` drifts off the wall clock. */}
        {hours.map((h) => {
          const at = new Date(dayStart);
          at.setHours(h, 0, 0, 0);
          const ms = at.getTime();
          if (ms < winStart || ms >= winEnd) return null; // outside the bedtime-to-bedtime window
          if (sunMarks.some((m) => Math.abs(angleOf(m.ms) - angleOf(ms)) < 10)) return null; // sun mark sits here
          const p = polar(angleOf(ms), R_RING - 26);
          return (
            <text key={h} x={p.x} y={p.y} fill={palette.textFainter} fontSize={10} fontWeight={700} textAnchor="middle" dominantBaseline="middle">
              {hourLabel(h)}
            </text>
          );
        })}
        {/* Window edges, labelled BELOW the dial under their arc ends: the horseshoe crosses
            midnight, so each end carries its own date + time (start = last night's bedtime).
            Nudged toward the open gap — the icon orbit can clamp a glyph exactly onto an arc
            end (same height as these labels), and the orbit sits OUTSIDE the tips, so moving
            inward guarantees clearance on both sides. */}
        {([
          { key: "win-start", ms: winStart, deg: ARC_START, dx: 16 },
          { key: "win-end", ms: winEnd, deg: ARC_END, dx: -16 },
        ] as const).map(({ key, ms, deg, dx }) => {
          const x = polar(deg, R_RING).x + dx;
          const d = new Date(ms);
          return (
            <text key={key} x={x} y={296} fill={palette.textMuted} fontSize={10} fontWeight={700} textAnchor="middle">
              <tspan x={x} dy={0}>{d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</tspan>
              <tspan x={x} dy={12}>{clockTime(ms)}</tspan>
            </text>
          );
        })}
      </svg>

      {/* Cycling centre: ONE stat at a time, tap to advance (prediction first when live).
          The page dots hint that there's more behind the tap. */}
      <div style={s.radialCenter}>
        {(() => {
          interface Slide {
            key: string;
            cap: string;
            capColor: string;
            big: string;
            sub?: string;
          }
          const slides: Slide[] = [
            { key: "sleep", cap: activityLabel("sleep"), capColor: palette.accents.sleep.accent, big: hm(sleepMs) },
            { key: "feeding", cap: activityLabel("feeding"), capColor: palette.accents.feeding.accent, big: `×${feedCount}`, sub: hm(feedMs) },
            { key: "wet", cap: t("diaper.wet"), capColor: palette.accents.diaper.accent, big: `×${wetCount}` },
            { key: "solid", cap: t("diaper.solid"), capColor: palette.accents.diaper.accent, big: `×${solidCount}` },
            { key: "tummy", cap: activityLabel("tummy"), capColor: palette.accents.tummy.accent, big: hm(tummyMs) },
            { key: "awake", cap: t("cal.awake"), capColor: palette.textMuted, big: hm(awakeMs) },
          ];
          const total = slides.length + (soonest ? 1 : 0);
          const idx = statIdx % total;
          const slide = soonest && idx === 0 ? null : slides[soonest ? idx - 1 : idx];
          return (
            <button
              onClick={() => {
                buzz();
                setStatIdx((i) => (i + 1) % total);
              }}
              aria-label={t("cal.nextStat")}
              style={{ pointerEvents: "auto", background: "none", border: "none", padding: 18, font: "inherit", color: "inherit", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}
            >
              {slide == null && soonest ? (
                (() => {
                  // Same honesty as the home panel (±10 min = "now", older reads late — a
                  // forecast, never past tense; expired etas are filtered out of `preds`
                  // above). A late eta splits over two lines so the serif keeps its size.
                  const overdueMs = now - soonest.etaMs;
                  const overdue = overdueMs > 10 * 60_000;
                  const centerText =
                    soonest.etaMs > now + 10 * 60_000
                      ? t("cal.inDuration", { duration: hm(soonest.etaMs - now) })
                      : overdue
                        ? hm(overdueMs)
                        : t("home.dueNowExact");
                  return (
                    <>
                      <span style={s.radialSmall}>{t("home.upNext")}</span>
                      {overdue && <span style={s.radialSmall}>{t("home.overdueByLabel")}</span>}
                      <span style={{ ...s.radialBig, ...(centerText.length > 12 ? { fontSize: 23 } : {}) }}>{centerText}</span>
                      <span style={{ ...s.radialActivity, color: palette.accents[soonest.activity].accent }}>{activityLabel(soonest.activity)}</span>
                    </>
                  );
                })()
              ) : slide ? (
                <>
                  <span style={{ ...s.radialSmall, color: slide.capColor }}>{slide.cap}</span>
                  <span style={s.radialBig}>{slide.big}</span>
                  {slide.sub != null && <span style={{ fontSize: 13, fontWeight: 800, color: palette.textMuted }}>{slide.sub}</span>}
                </>
              ) : null}
              <span aria-hidden style={{ display: "flex", gap: 4.5, marginTop: 7 }}>
                {Array.from({ length: total }, (_, i) => (
                  <span key={i} style={{ width: 4.5, height: 4.5, borderRadius: "50%", background: i === idx ? palette.textMuted : palette.surfaceStrongBorder }} />
                ))}
              </span>
            </button>
          );
        })()}
      </div>
    </div>

      {/* Day composition: one full-width stacked strip — how the (elapsed) bedtime-to-bedtime
          window divides between sleep, tummy, feeding and awake time. Fixed activity order,
          same as the week-grid lanes; every segment is directly labelled in the legend. */}
      {(() => {
        const segs = [
          { key: "sleep", ms: sleepMs, color: palette.accents.sleep.accent },
          { key: "tummy", ms: tummyMs, color: palette.accents.tummy.accent },
          { key: "feeding", ms: feedMs, color: palette.accents.feeding.accent },
          { key: "awake", ms: awakeMs, color: palette.surfaceStrongBorder },
        ] as const;
        return (
          <div style={s.dayBarWrap}>
            <div style={s.dayBar} role="img" aria-label={`${activityLabel("sleep")} ${hm(sleepMs)} · ${activityLabel("tummy")} ${hm(tummyMs)} · ${activityLabel("feeding")} ${hm(feedMs)} · ${t("cal.awake")} ${hm(awakeMs)}`}>
              {segs.filter((g) => g.ms > 0).map((g) => (
                <div key={g.key} style={{ ...s.dayBarSeg, flex: g.ms, background: g.color }} />
              ))}
            </div>
            {/* The day's full breakdown — the ring centre keeps only the hero. Wet and solid
                changes split out, glyph-coded like the dial (drop = pipi, trefoil = selles). */}
            <div style={s.dayBarLegend}>
              {(
                [
                  // Row 1: the durations (sleep, tummy, awake); row 2: the counts (feeds, wet, solid).
                  { key: "sleep", Icon: ACTIVITY_ICON.sleep, color: palette.accents.sleep.accent, text: hm(sleepMs) },
                  { key: "tummy", Icon: ACTIVITY_ICON.tummy, color: palette.accents.tummy.accent, text: hm(tummyMs) },
                  { key: "awake", Icon: null, color: palette.surfaceStrongBorder, text: `${t("cal.awake")} ${hm(awakeMs)}` },
                  { key: "feeding", Icon: ACTIVITY_ICON.feeding, color: palette.accents.feeding.accent, text: `×${feedCount} · ${hm(feedMs)}` },
                  { key: "wet", Icon: ACTIVITY_ICON.diaper, color: palette.accents.diaper.accent, text: `×${wetCount} ${t("diaper.wet").toLocaleLowerCase()}` },
                  { key: "solid", Icon: RadioactiveIcon, color: palette.accents.diaper.accent, text: `×${solidCount} ${t("diaper.solid").toLocaleLowerCase()}` },
                ] as const
              ).map(({ key, Icon, color, text }) => (
                <span key={key} style={s.dayBarLegendItem}>
                  {Icon ? (
                    <span aria-hidden style={{ color, display: "grid", placeItems: "center" }}>
                      <Icon size={14} />
                    </span>
                  ) : (
                    <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
                  )}
                  {text}
                </span>
              ))}
            </div>
          </div>
        );
      })()}
      {/* Folded-tick picker: several same-type entries share one "N×" mark — choose which
          one to edit. Same scrim + bottom-sheet chrome as every other sheet in the app. */}
      {pick != null && <button tabIndex={-1} style={{ ...s.scrim, cursor: "default" }} onClick={() => setPick(null)} aria-label={t("home.close")} />}
      <div
        ref={pickRef}
        role="dialog"
        aria-modal={pick != null}
        aria-label={t("cal.pickEntry")}
        tabIndex={-1}
        inert={pick == null || undefined}
        style={{ ...s.sheet, ...(pick != null ? s.sheetOn : {}) }}
      >
        <div style={s.sheetHandle} />
        <div style={s.sheetTitle}>{t("cal.pickEntry")}</div>
        {(pick ?? []).map((e) => (
          <EntryRow
            key={`${e.path}${e.id}`}
            entry={e}
            onEdit={(entry) => {
              buzz();
              setPick(null);
              onEdit(entry);
            }}
          />
        ))}
      </div>
    </>
  );
}

// ── Week time grid ───────────────────────────────────────────────────────────────
function TimeGrid({
  entries,
  range,
  hourPx,
  onZoom,
  onEdit,
}: {
  entries: TimelineEntry[] | null;
  range: Range;
  hourPx: number;
  onZoom: (px: number, persist: boolean) => void;
  onEdit: (e: TimelineEntry) => void;
}) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const gridH = 24 * hourPx;
  const now = useNow(60_000);
  const todayStart = startOfDay(now);

  // Hour gridlines + labels every 3 h.
  const hours = [0, 3, 6, 9, 12, 15, 18, 21];
  const hourLabel = (h: number) => {
    const ap = h < 12 ? "a" : "p";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}${ap}`;
  };

  // Open scrolled to the morning (so a zoomed-in grid doesn't start on the dead-of-night). Re-runs
  // when the viewed period changes, not on zoom — zooming keeps roughly where you were.
  const viewportRef = useRef<HTMLDivElement>(null);
  const periodKey = range.days[0];
  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 6 * hourPx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodKey]);

  // Pinch-to-zoom (two fingers) adjusts the vertical scale; one finger still scrolls. Native
  // non-passive listeners (attached once via refs) so we can preventDefault the browser's own
  // pinch-zoom without tearing down mid-gesture on each state update.
  const hourPxRef = useRef(hourPx);
  const onZoomRef = useRef(onZoom);
  useEffect(() => {
    hourPxRef.current = hourPx;
    onZoomRef.current = onZoom;
  });
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const dist = (ts: TouchList) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    const pinch = { active: false, baseDist: 0, basePx: 0 };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      pinch.active = true;
      pinch.baseDist = dist(e.touches);
      pinch.basePx = hourPxRef.current;
    };
    const onMove = (e: TouchEvent) => {
      if (pinch.active && e.touches.length === 2) {
        e.preventDefault();
        onZoomRef.current((pinch.basePx * dist(e.touches)) / (pinch.baseDist || 1), false);
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch.active && e.touches.length < 2) {
        pinch.active = false;
        onZoomRef.current(hourPxRef.current, true); // persist the settled scale
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  // Size the grid to the REAL space between its top and the floating add bar. Two things fight
  // otherwise: the style sheet's static maxHeight cap (58vh — wrong on iOS, where vh ≠ visible
  // viewport) and the zoom. Both now derive from one measurement: the bar is `position: fixed`,
  // so its rect top is the true usable bottom edge, browser chrome and safe-area included.
  // The element cap applies always (a pinched-in grid scrolls inside it); the default zoom is
  // fitted only when no explicit pinch choice is stored under ZOOM_KEY.
  useEffect(() => {
    const el = viewportRef.current;
    const head = el?.firstElementChild;
    if (!el || !head) return;
    const fit = () => {
      const bar = el.closest("section")?.lastElementChild;
      const bottom = bar ? bar.getBoundingClientRect().top : window.innerHeight - 96;
      const top = el.getBoundingClientRect().top + window.scrollY; // as if unscrolled
      const avail = Math.max(240, bottom - top - 10);
      el.style.maxHeight = `${Math.round(avail)}px`;
      if (localStorage.getItem(ZOOM_KEY) == null) {
        onZoomRef.current(Math.floor((avail - head.getBoundingClientRect().height) / 24), false);
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div ref={viewportRef} style={s.gridViewport}>
      <div style={s.gridHead}>
        <div style={s.gridAxisHead} />
        {range.days.map((d) => {
          const date = new Date(d);
          const today = d === todayStart;
          return (
            <div key={d} style={{ ...s.gridDayHead, ...(today ? s.gridDayHeadOn : {}) }}>
              <span style={s.gridDow}>{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span style={s.gridDayNum}>{date.getDate()}</span>
            </div>
          );
        })}
      </div>

      <div style={{ ...s.gridBody, height: gridH }}>
        <div style={s.gridAxis}>
          {hours.map((h) => (
            <span key={h} style={{ ...s.gridHourLabel, top: h * hourPx }}>{hourLabel(h)}</span>
          ))}
        </div>
        {range.days.map((dayStart) => {
          const blocks = entries ?? [];
          return (
            <div key={dayStart} style={s.gridCol}>
              {hours.map((h) => (
                <div key={h} style={{ ...s.gridLine, top: h * hourPx }} />
              ))}
              {dayStart === todayStart && now < addDays(dayStart, 1) && (
                <div style={{ ...s.nowLine, top: wallClockY(now, hourPx) }}>
                  {/* teardrop caps, tails pointing inward along the line */}
                  <span style={{ ...s.nowCap, left: 0, transform: "translate(-50%, -50%) rotate(-135deg)" }} />
                  <span style={{ ...s.nowCap, left: "100%", transform: "translate(-50%, -50%) rotate(45deg)" }} />
                </div>
              )}
              {layoutDay(blocks, dayStart, hourPx).map((le) => renderBlock(le, hourPx, palette, onEdit, s))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** An entry placed in the day column: clipped times plus its lane within the overlap cluster. */
interface LaidOut {
  e: TimelineEntry;
  clipStart: number;
  clipEnd: number;
  lane: number;
  lanes: number;
}

/**
 * Lane layout for one day column — concurrent events split the column side by side instead of
 * stacking invisibly. Two passes: cluster transitively-overlapping events, then hand out lanes
 * inside each cluster in a FIXED activity order (sleep, tummy, feeding, medication, diaper) so
 * concurrent blocks always read left→right the same way; start time only breaks ties within a
 * type. Non-overlapping events still share lanes, keeping the column as wide as possible.
 * The layout footprint of an event is exactly its DRAWN footprint — renderBlock clamps every
 * block to ≥6px tall, so short/instant events reserve 6px worth of time at the current zoom.
 * Anything more (the old flat 20 min) split lanes for blocks that visibly don't touch.
 */
const LANE_ORDER: Record<TimelineEntry["activity"], number> = { sleep: 0, tummy: 1, feeding: 2, medication: 3, diaper: 4 };
/** Vertical position of an instant in a wall-clock-labelled grid: local h:mm × px/hour. This
 *  keeps blocks aligned with the hour lines even on 23/25-hour DST days. */
function wallClockY(ms: number, hourPx: number): number {
  const d = new Date(ms);
  return (d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600) * hourPx;
}

function layoutDay(entries: TimelineEntry[], dayStart: number, hourPx: number): LaidOut[] {
  const dayEnd = addDays(dayStart, 1); // DST-safe
  const LAYOUT_MIN = (6 / hourPx) * 3_600_000; // the 6px minimum renderBlock draws, as time
  // Overlaps thinner than a pixel aren't visible — a sleep ending 16 s into a diaper change
  // must not split the column. Anything under 1px of drawn overlap counts as disjoint.
  const EPS = (1 / hourPx) * 3_600_000;
  const evs = entries
    .filter((e) => Math.max(e.endMs ?? e.startMs, e.startMs) >= dayStart && e.startMs < dayEnd)
    .map((e) => {
      const clipStart = Math.max(e.startMs, dayStart);
      const clipEnd = Math.min(Math.max(e.endMs ?? e.startMs, e.startMs), dayEnd);
      return { e, clipStart, clipEnd, layoutEnd: Math.min(Math.max(clipEnd, clipStart + LAYOUT_MIN), dayEnd), lane: 0, lanes: 1 };
    })
    .sort((a, b) => a.clipStart - b.clipStart || b.layoutEnd - a.layoutEnd);

  // Pass 1: split into clusters of transitively-overlapping events (evs is start-sorted).
  const clusters: (typeof evs)[] = [];
  let clusterEnd = -Infinity;
  for (const ev of evs) {
    if (ev.clipStart >= clusterEnd - EPS) clusters.push([]);
    clusters[clusters.length - 1].push(ev);
    clusterEnd = Math.max(clusterEnd, ev.layoutEnd);
  }

  // Pass 2: within a cluster, assign lanes in activity order. Each lane keeps its interval
  // list (assignment runs out of time order, so a single "last end" isn't enough).
  for (const cluster of clusters) {
    const lanes: { s: number; e: number }[][] = [];
    const ordered = [...cluster].sort((a, b) => LANE_ORDER[a.e.activity] - LANE_ORDER[b.e.activity] || a.clipStart - b.clipStart);
    for (const ev of ordered) {
      let lane = lanes.findIndex((ivs) => ivs.every((iv) => Math.min(iv.e, ev.layoutEnd) - Math.max(iv.s, ev.clipStart) <= EPS));
      if (lane === -1) {
        lane = lanes.length;
        lanes.push([]);
      }
      lanes[lane].push({ s: ev.clipStart, e: ev.layoutEnd });
      ev.lane = lane;
    }
    for (const ev of cluster) ev.lanes = lanes.length;
  }
  return evs;
}

function renderBlock(
  le: LaidOut,
  hourPx: number,
  palette: ReturnType<typeof useTheme>["palette"],
  onEdit: (e: TimelineEntry) => void,
  s: Record<string, CSSProperties>,
): ReactNode {
  const { e, clipStart, clipEnd, lane, lanes } = le;
  const accent = palette.accents[e.activity].accent;
  const top = wallClockY(clipStart, hourPx);
  const left = `calc(${((lane / lanes) * 100).toFixed(3)}% + 1px)`;
  const width = `calc(${(100 / lanes).toFixed(3)}% - 2px)`;
  const key = `${e.path}${e.id}`;
  const common = { onClick: () => onEdit(e), className: "cal-blk", "aria-label": `${e.activity} ${clockTime(e.startMs)}` };

  // Instant entries (diaper, medication) render as a small dot marker rather than a bar.
  if (e.activity === "diaper" || e.activity === "medication") {
    return <button key={key} {...common} style={{ ...s.blkDiaper, top, left, width, background: accent }} />;
  }
  const h = Math.max(6, ((clipEnd - clipStart) / 3_600_000) * hourPx);
  if (e.activity === "sleep") {
    return <button key={key} {...common} style={{ ...s.blkSleep, top, left, width, height: h, background: `${accent}3d`, borderLeft: `2px solid ${accent}` }} />;
  }
  // feeding / tummy — solid bar
  return <button key={key} {...common} style={{ ...s.blkBar, top, left, width, height: h, background: accent }} />;
}

// ── Summary ────────────────────────────────────────────────────────────────────
/** Signed compact duration for deltas, e.g. "+40m" / "−1h 05m". */
const signedHm = (ms: number): string => `${ms < 0 ? "−" : "+"}${hm(Math.abs(ms))}`;
const signedCount = (n: number): string => `${n < 0 ? "−" : "+"}${Math.abs(n)}`;

function SummaryView({
  entries,
  prevEntries,
  range,
  birthDate,
}: {
  entries: TimelineEntry[] | null;
  prevEntries: TimelineEntry[] | null;
  range: Range;
  birthDate: string | null | undefined;
}) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const now = useNow(60_000);

  const stats = useMemo(() => summarize(entries ?? [], range.from, range.to), [entries, range]);
  // Average over days that have actually begun, so a partial current week isn't deflated by
  // dividing across days that haven't happened yet.
  const days = Math.max(1, range.days.filter((d) => d <= now).length);
  const goal = tummyGoalForAge(birthDate, range.from);

  // Week-over-week deltas, per day. The previous period divides by the days the child actually
  // existed in it — for a baby born mid-week, dividing by 7 would deflate every "last week"
  // average and fake a surge in the deltas. Under 3 lived days the comparison is noise: hide it.
  const prev = useMemo(
    () => summarize(prevEntries ?? [], addDays(range.from, -7), range.from),
    [prevEntries, range],
  );
  const prevFrom = addDays(range.from, -7);
  const birthMs = birthDate ? Date.parse(birthDate) : NaN;
  const prevLifeDays = Number.isNaN(birthMs)
    ? 7
    : Array.from({ length: 7 }, (_, i) => addDays(prevFrom, i)).filter((d) => d >= startOfDay(birthMs)).length;
  const prevDays = clamp(prevLifeDays, 1, 7);
  const hasPrev = (prevEntries?.length ?? 0) > 0 && prevLifeDays >= 3;
  const delta = {
    sleep: signedHm(stats.sleepMs / days - prev.sleepMs / prevDays),
    feeding: signedCount(Math.round(stats.feedCount / days - prev.feedCount / prevDays)),
    diaper: signedCount(Math.round(stats.diaperCount / days - prev.diaperCount / prevDays)),
    tummy: signedHm(stats.tummyMs / days - prev.tummyMs / prevDays),
  } as const;

  if (entries == null) return <div style={s.empty}><div className="spin" style={{ width: 28, height: 28, borderRadius: "50%", border: `3px solid ${palette.surfaceStrongBorder}`, borderTopColor: palette.accents.feeding.accent }} /></div>;

  const cards = [
    // "/day" on the value, like the other cards — a bare "9h 30m" reads as the week's total.
    { key: "sleep", big: t("cal.durationPerDay", { duration: hm(stats.sleepMs / days) }), sub: t("cal.longest", { duration: hm(stats.longestSleep) }) },
    { key: "feeding", big: t("cal.perDay", { count: Math.round(stats.feedCount / days) }), sub: stats.avgGap != null ? t("cal.everyInterval", { duration: hm(stats.avgGap) }) : "—" },
    { key: "diaper", big: t("cal.perDay", { count: Math.round(stats.diaperCount / days) }), sub: `${t("cal.wet", { count: stats.wet })} · ${t("cal.solid", { count: stats.solid })}` },
    { key: "tummy", big: t("cal.minPerDay", { value: Math.round(stats.tummyMs / days / 60_000) }), sub: t("cal.goalMin", { goal }) },
  ] as const;

  return (
    <div style={s.summaryGrid}>
      {cards.map((c) => {
        const accent = palette.accents[c.key].accent;
        const Icon = ACTIVITY_ICON[c.key];
        return (
          <div key={c.key} style={s.statCard}>
            <span style={{ ...s.statIcon, color: accent, background: `${accent}1a` }}><Icon size={18} /></span>
            <span style={s.statTitle}>{t(`activity.${c.key}`)}</span>
            <span style={s.statBig}>{c.big}</span>
            <span style={s.statSub}>{c.sub}</span>
            {hasPrev && <span style={s.statDelta}>{t("cal.vsLastWeek", { delta: delta[c.key] })}</span>}
          </div>
        );
      })}
    </div>
  );
}

function summarize(entries: TimelineEntry[], from: number, to: number) {
  let sleepMs = 0, longestSleep = 0, tummyMs = 0, wet = 0, solid = 0, diaperCount = 0;
  const feeds: number[] = [];
  for (const e of entries) {
    if (e.activity === "sleep" || e.activity === "tummy") {
      const start = Math.max(e.startMs, from);
      const end = Math.min(e.endMs ?? e.startMs, to);
      const overlap = Math.max(0, end - start);
      if (e.activity === "sleep") {
        sleepMs += overlap;
        const full = (e.endMs ?? e.startMs) - e.startMs;
        if (e.startMs >= from && e.startMs < to && full > longestSleep) longestSleep = full;
      } else tummyMs += overlap;
    } else if (e.startMs >= from && e.startMs < to) {
      if (e.activity === "feeding") feeds.push(e.startMs);
      else if (e.activity === "diaper") {
        diaperCount++;
        if (e.wet) wet++;
        if (e.solid) solid++;
      }
    }
  }
  feeds.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < feeds.length; i++) gaps.push(feeds[i] - feeds[i - 1]);
  return { sleepMs, longestSleep, tummyMs, wet, solid, diaperCount, feedCount: feeds.length, avgGap: gaps.length ? median(gaps) : null };
}
