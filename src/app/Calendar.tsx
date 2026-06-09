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
import { ACTIVITY_ICON, PlusIcon } from "../ui/icons";
import { clockTime } from "../lib/datetime";
import { tummyGoalForAge } from "../lib/tummy";
import { useEntriesInRange, useNow, buzz } from "./hooks";
import { Timeline } from "./Timeline";

type CalMode = "day" | "week" | "list" | "summary";
const MODES: CalMode[] = ["day", "week", "list", "summary"];
const MODE_KEY = "baby-log:calmode";

const DAY_MS = 86_400_000;
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
/** Compact duration, e.g. "14h 10m" / "45m". */
const hm = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};

interface Range {
  from: number;
  to: number;
  days: number[];
}
function rangeFor(mode: CalMode, anchor: number): Range {
  if (mode === "day") return { from: anchor, to: anchor + DAY_MS, days: [anchor] };
  const from = startOfWeek(anchor); // week + summary
  return { from, to: from + 7 * DAY_MS, days: Array.from({ length: 7 }, (_, i) => addDays(from, i)) };
}

export function Calendar({
  client,
  childId,
  birthDate,
  listEntries,
  onAdd,
  onEdit,
  onDelete,
}: {
  client: BabyBuddyClient;
  childId: number | null;
  birthDate: string | null | undefined;
  listEntries: TimelineEntry[] | null;
  onAdd: () => void;
  onEdit: (e: TimelineEntry) => void;
  onDelete: (e: TimelineEntry) => void;
}) {
  const { s } = useStyles();
  const { t } = useTranslation();

  const [mode, setMode] = useState<CalMode>(() => {
    const v = localStorage.getItem(MODE_KEY) as CalMode | null;
    return v && MODES.includes(v) ? v : "week";
  });
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const now = useNow(60_000); // 1-min tick (drives "today" highlight + the now-line)
  const [hourPx, setHourPx] = useState(() => {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return v >= MIN_HOUR_PX && v <= MAX_HOUR_PX ? v : DEFAULT_HOUR_PX;
  });

  const pickMode = (m: CalMode) => {
    buzz();
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
  };
  // Pinch-to-zoom sets the vertical scale (px/hour); persist only when the gesture settles.
  const applyZoom = useCallback((px: number, persist: boolean) => {
    const n = Math.round(clamp(px, MIN_HOUR_PX, MAX_HOUR_PX));
    setHourPx(n);
    if (persist) localStorage.setItem(ZOOM_KEY, String(n));
  }, []);

  const range = useMemo(() => rangeFor(mode, anchor), [mode, anchor]);
  const { entries: rangeEntries } = useEntriesInRange(client, childId, range.from, range.to, mode !== "list");

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
        <Timeline entries={listEntries} showAdd={false} onEdit={onEdit} onDelete={onDelete} />
      ) : mode === "summary" ? (
        <SummaryView entries={rangeEntries} range={range} birthDate={birthDate} />
      ) : (
        <TimeGrid entries={rangeEntries} range={range} hourPx={hourPx} onZoom={applyZoom} onEdit={onEdit} />
      )}

      {/* Persistent, thumb-reachable add button pinned to the bottom of the view. */}
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
  const end = new Date(range.to - DAY_MS);
  const start = new Date(range.from);
  const sameMonth = start.getMonth() === end.getMonth();
  const startStr = start.toLocaleDateString(loc, { day: "numeric", ...(sameMonth ? {} : { month: "short" }) });
  const endStr = end.toLocaleDateString(loc, { day: "numeric", month: "short" });
  return `${startStr} – ${endStr}`;
}

// ── Day / Week time grid ────────────────────────────────────────────────────────
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
              {dayStart === todayStart && now < dayStart + DAY_MS && (
                <div style={{ ...s.nowLine, top: ((now - dayStart) / DAY_MS) * gridH }} />
              )}
              {blocks.map((e) => renderBlock(e, dayStart, gridH, palette, onEdit, s)).filter(Boolean)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function renderBlock(
  e: TimelineEntry,
  dayStart: number,
  gridH: number,
  palette: ReturnType<typeof useTheme>["palette"],
  onEdit: (e: TimelineEntry) => void,
  s: Record<string, CSSProperties>,
): ReactNode {
  const dayEnd = dayStart + DAY_MS;
  const accent = palette.accents[e.activity].accent;
  const start = e.startMs;
  const end = e.endMs ?? e.startMs;
  if (end < dayStart || start >= dayEnd) return null; // doesn't intersect this day

  const clipStart = Math.max(start, dayStart);
  const clipEnd = Math.min(Math.max(end, start), dayEnd);
  const top = ((clipStart - dayStart) / DAY_MS) * gridH;
  const key = `${e.path}${e.id}`;
  const common = { onClick: () => onEdit(e), "aria-label": `${e.activity} ${clockTime(e.startMs)}` };

  if (e.activity === "diaper") {
    return <button key={key} {...common} style={{ ...s.blkDiaper, top, background: accent }} />;
  }
  const h = Math.max(3, ((clipEnd - clipStart) / DAY_MS) * gridH);
  if (e.activity === "sleep") {
    return <button key={key} {...common} style={{ ...s.blkSleep, top, height: h, background: `${accent}3d`, borderLeft: `2px solid ${accent}` }} />;
  }
  // feeding / tummy — solid bar on top of any sleep block
  return <button key={key} {...common} style={{ ...s.blkBar, top, height: h, background: accent }} />;
}

// ── Summary ────────────────────────────────────────────────────────────────────
function SummaryView({
  entries,
  range,
  birthDate,
}: {
  entries: TimelineEntry[] | null;
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

  if (entries == null) return <div style={s.empty}><div className="spin" style={{ width: 28, height: 28, borderRadius: "50%", border: `3px solid ${palette.surfaceStrongBorder}`, borderTopColor: palette.accents.feeding.accent }} /></div>;

  const cards = [
    { key: "sleep", big: hm(stats.sleepMs / days), sub: t("cal.longest", { duration: hm(stats.longestSleep) }) },
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
