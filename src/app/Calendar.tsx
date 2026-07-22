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
import { ACTIVITY_ICON, PlusIcon, SunriseIcon, SunsetIcon } from "../ui/icons";
import { clockTime } from "../lib/datetime";
import { activityLabel } from "../lib/labels";
import { hm } from "../lib/format";
import { predictNext, predictSleepEnd, predictionAlive, type ActivityPrediction } from "../lib/predict";
import { tummyGoalForAge } from "../lib/tummy";
import { sunTimes } from "../lib/sun";
import { useEntriesInRange, useGeo, useNow, buzz } from "./hooks";
import { Timeline } from "./Timeline";

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
  onRetryList,
  onAdd,
  onEdit,
}: {
  client: BabyBuddyClient;
  childId: number | null;
  birthDate: string | null | undefined;
  listEntries: TimelineEntry[] | null;
  listUpdatedAt?: number;
  /** List-mode cold-start failure state + its retry, forwarded to `Timeline`. */
  listError?: boolean;
  onRetryList?: () => void;
  onAdd: () => void;
  onEdit: (e: TimelineEntry) => void;
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
        <Timeline entries={listEntries} updatedAt={listUpdatedAt} showAdd={false} onEdit={onEdit} error={listError} onRetry={onRetryList} />
      ) : mode === "summary" ? (
        <SummaryView entries={rangeEntries} prevEntries={prevEntries} range={range} birthDate={birthDate} />
      ) : mode === "day" ? (
        <RadialDay entries={rangeEntries} range={range} birthDate={birthDate} onEdit={onEdit} />
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
// A 24-h ring: midnight at the bottom, noon at the top, morning down the left and evening
// down the right — so the waking day arcs across the top. EVERYTHING lives on one fat ring:
// timed activities as rounded arc pills, instants as dots — each carrying its activity icon so
// the dial is legible at a glance. The centre shows the next-event prediction (today).
const RCX = 160;
const RCY = 160;
const R_RING = 122; // the single ring everything sits on
const RING_W = 30; // ring (and arc) thickness — fat enough to hold the icon badges

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
}: {
  entries: TimelineEntry[] | null;
  range: Range;
  birthDate: string | null | undefined;
  onEdit: (e: TimelineEntry) => void;
}) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const now = useNow(30_000);
  const dayStart = range.days[0];
  const dayEnd = addDays(dayStart, 1); // DST-safe: a local day can be 23 or 25 h
  const isToday = dayStart === startOfDay(now);
  const list = entries ?? [];

  const angleOf = (ms: number) => ((clamp(ms, dayStart, dayEnd) - dayStart) / (dayEnd - dayStart)) * 360 + 180;

  const sleeps = list.filter((e) => e.activity === "sleep" && e.endMs != null && e.endMs > dayStart && e.startMs < dayEnd);
  const bars = list.filter((e) => (e.activity === "feeding" || e.activity === "tummy") && e.startMs < dayEnd && (e.endMs ?? e.startMs) >= dayStart);
  const diapers = list.filter((e) => e.activity === "diaper" && e.startMs >= dayStart && e.startMs < dayEnd);
  const meds = list.filter((e) => e.activity === "medication" && e.startMs >= dayStart && e.startMs < dayEnd);

  let sleepMs = 0;
  for (const e of sleeps) sleepMs += Math.min(e.endMs as number, dayEnd) - Math.max(e.startMs, dayStart);
  // Day stats for the dial centre (past days): totals per activity.
  let tummyMs = 0;
  for (const e of bars) {
    if (e.activity !== "tummy") continue;
    tummyMs += Math.min(e.endMs ?? e.startMs, dayEnd) - Math.max(e.startMs, dayStart);
  }
  const feedCount = list.filter((e) => e.activity === "feeding" && e.startMs >= dayStart && e.startMs < dayEnd).length;

  // Predicted upcoming events (today only) — shown as dashed "ghost" markers on the ring.
  // Long-expired etas are dropped, same rule as the home panel.
  const preds = isToday
    ? (Object.values(predictNext(list, birthDate, now)) as ActivityPrediction[]).filter((p) => p.confidence >= 0.1 && predictionAlive(p, now))
    : [];
  const soonest = [...preds].sort((a, b) => a.etaMs - b.etaMs)[0];
  const predMarks = preds.filter((p) => p.etaMs > now && p.etaMs < dayEnd);

  // Sunrise / sunset for the viewed day (when we have a location).
  const geo = useGeo();
  const sun = geo ? sunTimes(dayStart + 12 * 3_600_000, geo.lat, geo.lng) : null;
  const sunMarks = sun
    ? ([
        { key: "sunrise", ms: sun.sunrise, color: "#f3c14e" },
        { key: "sunset", ms: sun.sunset, color: "#e8895b" },
      ] as const).filter((m) => m.ms >= dayStart && m.ms < dayEnd)
    : [];

  const hours = [0, 6, 12, 18];
  const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`;

  // Icon badge sitting on the ring at `deg` — a filled disc with the activity glyph, so every
  // marker is identifiable at a glance. `dashed` renders the predicted ("ghost") variant.
  // Clickable badges act as buttons (keyboard + AT) and carry an invisible r=16 hit circle:
  // the visible 21px disc alone is well under a finger's width.
  const badge = (
    key: string,
    deg: number,
    accent: string,
    Icon: (p: { size?: number }) => ReactNode,
    opts: { dashed?: boolean; onClick?: () => void; label?: string } = {},
  ) => {
    const c = polar(deg, R_RING);
    const clickable = !!opts.onClick;
    return (
      <g
        key={key}
        style={{ color: accent, cursor: clickable ? "pointer" : undefined }}
        onClick={opts.onClick}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? opts.label : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault(); // Space must not scroll the page
                opts.onClick?.();
              }
            : undefined
        }
      >
        {/* only on clickable badges — on a ghost/sun marker it would swallow taps meant
            for the arc underneath */}
        {clickable && <circle cx={c.x} cy={c.y} r={16} fill="transparent" pointerEvents="all" />}
        {/* tileBase, not bg: `bg` is a CSS gradient string, which SVG would paint as black */}
        <circle cx={c.x} cy={c.y} r={10.5} fill={palette.tileBase} stroke={accent} strokeWidth={1.6} strokeDasharray={opts.dashed ? "2.5 2.5" : undefined} />
        <g transform={`translate(${(c.x - 6.5).toFixed(2)}, ${(c.y - 6.5).toFixed(2)})`}>
          <Icon size={13} />
        </g>
      </g>
    );
  };
  const timeLabel = (key: string, deg: number, color: string, ms: number) => {
    const lp = polar(deg, R_RING + 26);
    return (
      <text key={key} x={lp.x} y={lp.y} fill={color} fontSize={10} fontWeight={800} textAnchor="middle" dominantBaseline="middle">
        {clockTime(ms)}
      </text>
    );
  };

  // The round linecap overshoots each path end by RING_W/2 (~28 min of angle), so a naively
  // drawn arc reads ~1 h longer than the event. Inset BOTH ends by the cap's angular size so the
  // visible pill spans exactly [start, end] — and when the event is too short for the caps to
  // fit, draw no arc at all: the icon badge alone marks it (a fixed-size marker can't lie about
  // duration the way a fat arc does).
  const CAP_DEG = (RING_W / 2 / R_RING) * (180 / Math.PI);
  const ringArc = (e: TimelineEntry) => {
    const rawEnd = Math.max(e.endMs ?? e.startMs, e.startMs);
    const a0 = angleOf(Math.max(e.startMs, dayStart));
    const a1 = angleOf(Math.min(rawEnd, dayEnd));
    if (a1 - a0 <= 2 * CAP_DEG + 0.5) return null; // shorter than the caps → badge only
    return (
      <path
        key={`${e.path}${e.id}`}
        d={arcPath(a0 + CAP_DEG, a1 - CAP_DEG, R_RING)}
        fill="none"
        stroke={palette.accents[e.activity].accent}
        strokeWidth={RING_W}
        strokeLinecap="round"
        opacity={e.activity === "sleep" ? 0.45 : 0.8}
        style={{ cursor: "pointer" }}
        onClick={() => onEdit(e)}
      />
    );
  };
  const midDeg = (e: TimelineEntry) => {
    const start = Math.max(e.startMs, dayStart);
    const end = Math.min(Math.max(e.endMs ?? e.startMs, e.startMs), dayEnd);
    return angleOf((start + end) / 2);
  };

  // All badges collected, sorted around the ring, then nudged apart so neighbours never overlap
  // (events close in time would otherwise stack their badges on top of each other).
  interface Mark {
    key: string;
    deg: number;
    accent: string;
    Icon: (p: { size?: number }) => ReactNode;
    dashed?: boolean;
    onClick?: () => void;
    /** Accessible name for a clickable badge (activity + start time). */
    label?: string;
    labelMs?: number;
  }
  const entryLabel = (e: TimelineEntry) => `${activityLabel(e.activity)} ${clockTime(e.startMs)}`;
  const marks: Mark[] = [
    ...[...sleeps, ...bars].map((e): Mark => ({ key: `b-${e.path}${e.id}`, deg: midDeg(e), accent: palette.accents[e.activity].accent, Icon: ACTIVITY_ICON[e.activity], onClick: () => onEdit(e), label: entryLabel(e) })),
    ...diapers.map((e): Mark => ({ key: `b-${e.path}${e.id}`, deg: angleOf(e.startMs), accent: palette.accents.diaper.accent, Icon: ACTIVITY_ICON.diaper, onClick: () => onEdit(e), label: entryLabel(e) })),
    ...meds.map((e): Mark => ({ key: `b-${e.path}${e.id}`, deg: angleOf(e.startMs), accent: palette.accents.medication.accent, Icon: ACTIVITY_ICON.medication, onClick: () => onEdit(e), label: entryLabel(e) })),
    ...predMarks.map((p): Mark => ({ key: `pb-${p.activity}`, deg: angleOf(p.etaMs), accent: palette.accents[p.activity].accent, Icon: ACTIVITY_ICON[p.activity], dashed: true, labelMs: p.etaMs })),
    ...sunMarks.map((m): Mark => ({ key: `sb-${m.key}`, deg: angleOf(m.ms), accent: m.color, Icon: m.key === "sunrise" ? SunriseIcon : SunsetIcon, labelMs: m.ms })),
  ].sort((a, b) => a.deg - b.deg);
  const MIN_SEP = 11; // ≈ badge diameter at the ring radius, in degrees
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].deg < marks[i - 1].deg + MIN_SEP) marks[i].deg = marks[i - 1].deg + MIN_SEP;
  }

  return (
    <div style={s.radialWrap}>
      <svg viewBox="0 0 320 320" style={s.radialSvg} role="img">
        {/* the single fat ring everything sits on */}
        <circle cx={RCX} cy={RCY} r={R_RING} fill="none" stroke={palette.surfaceBorder} strokeWidth={RING_W} opacity={0.35} />
        {[...sleeps, ...bars].map((e) => ringArc(e))}
        {/* predicted sleep: a dashed ghost arc spanning the expected onset → wake */}
        {predMarks
          .filter((p) => p.activity === "sleep")
          .map((p) => {
            const se = predictSleepEnd(list, birthDate, p.etaMs);
            if (!se || se.confidence < 0.3) return null;
            const a0 = angleOf(p.etaMs);
            const a1 = Math.max(angleOf(Math.min(se.endMs, dayEnd)), a0 + 2);
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
        {marks.map((m) => (
          <g key={m.key}>
            {badge(m.key, m.deg, m.accent, m.Icon, { dashed: m.dashed, onClick: m.onClick, label: m.label })}
            {m.labelMs != null && timeLabel(`${m.key}-t`, m.deg, m.accent, m.labelMs)}
          </g>
        ))}
        {/* "now" — a rounded radial tick crossing the ring, drawn on top of arcs and badges */}
        {isToday && now >= dayStart && now < dayEnd && (() => {
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
          const p = polar(angleOf(at.getTime()), R_RING - 26);
          return (
            <text key={h} x={p.x} y={p.y} fill={palette.textFainter} fontSize={10} fontWeight={700} textAnchor="middle" dominantBaseline="middle">
              {hourLabel(h)}
            </text>
          );
        })}
      </svg>

      <div style={s.radialCenter}>
        {soonest ? (
          (() => {
            // Same honesty as the home panel (±10 min = "now", older reads "late by X" — a
            // forecast, never past tense; expired etas are filtered out of `preds` above).
            // The circle fits ~12 glyphs of the serif; longer strings step the font down.
            const overdueMs = now - soonest.etaMs;
            const centerText =
              soonest.etaMs > now + 10 * 60_000
                ? t("cal.inDuration", { duration: hm(soonest.etaMs - now) })
                : overdueMs <= 10 * 60_000
                  ? t("home.dueNowExact")
                  : t("home.overdueBy", { late: hm(overdueMs) });
            return (
              <>
                <span style={s.radialSmall}>{t("home.upNext")}</span>
                <span style={{ ...s.radialBig, ...(centerText.length > 12 ? { fontSize: 23 } : {}) }}>{centerText}</span>
                <span style={{ ...s.radialActivity, color: palette.accents[soonest.activity].accent }}>{activityLabel(soonest.activity)}</span>
              </>
            );
          })()
        ) : (
          /* Past day (or nothing left to predict): the day's totals, icon per activity. */
          <div style={s.radialStats}>
            {(
              [
                { key: "sleep", value: hm(sleepMs) },
                { key: "feeding", value: `×${feedCount}` },
                { key: "diaper", value: `×${diapers.length}` },
                { key: "tummy", value: hm(tummyMs) },
              ] as const
            ).map(({ key, value }) => {
              const Icon = ACTIVITY_ICON[key];
              return (
                <div key={key} style={s.radialStatRow}>
                  <span style={{ color: palette.accents[key].accent, display: "grid", placeItems: "center" }}>
                    <Icon size={15} />
                  </span>
                  <span style={s.radialStatValue}>{value}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
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
              {layoutDay(blocks, dayStart).map((le) => renderBlock(le, hourPx, palette, onEdit, s))}
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
 * stacking invisibly. Classic interval-cluster algorithm: greedily assign each event the first
 * free lane; when nothing overlaps anymore, the finished cluster's events all share its lane
 * count as their width divisor. Instants (diapers) and very short events reserve a ~20-min slot
 * for layout purposes so simultaneous ones still get distinct lanes.
 */
/** Vertical position of an instant in a wall-clock-labelled grid: local h:mm × px/hour. This
 *  keeps blocks aligned with the hour lines even on 23/25-hour DST days. */
function wallClockY(ms: number, hourPx: number): number {
  const d = new Date(ms);
  return (d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600) * hourPx;
}

function layoutDay(entries: TimelineEntry[], dayStart: number): LaidOut[] {
  const dayEnd = addDays(dayStart, 1); // DST-safe
  const LAYOUT_MIN = 20 * 60_000;
  const evs = entries
    .filter((e) => Math.max(e.endMs ?? e.startMs, e.startMs) >= dayStart && e.startMs < dayEnd)
    .map((e) => {
      const clipStart = Math.max(e.startMs, dayStart);
      const clipEnd = Math.min(Math.max(e.endMs ?? e.startMs, e.startMs), dayEnd);
      return { e, clipStart, clipEnd, layoutEnd: Math.min(Math.max(clipEnd, clipStart + LAYOUT_MIN), dayEnd), lane: 0, lanes: 1 };
    })
    .sort((a, b) => a.clipStart - b.clipStart || b.layoutEnd - a.layoutEnd);

  const laneEnds: number[] = [];
  let cluster: typeof evs = [];
  const flush = () => {
    for (const ev of cluster) ev.lanes = laneEnds.length;
    laneEnds.length = 0;
    cluster = [];
  };
  for (const ev of evs) {
    if (laneEnds.length > 0 && laneEnds.every((end) => end <= ev.clipStart)) flush();
    let lane = laneEnds.findIndex((end) => end <= ev.clipStart);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = ev.layoutEnd;
    ev.lane = lane;
    cluster.push(ev);
  }
  flush();
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
    { key: "diaper", big: t("cal.perDay", { count: Math.round(stats.diaperCount / days) }), sub: t("cal.wetSolid", { wet: stats.wet, solid: stats.solid }) },
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
