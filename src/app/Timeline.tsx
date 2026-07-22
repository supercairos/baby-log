/**
 * Timeline page — merged recent entries grouped Today / Yesterday / weekday-date, newest
 * first. Each row is tappable to edit; the trash button deletes. "Add entry" opens the
 * same sheet with an activity picker for backdated logging.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TimelineEntry } from "../api";
import { buzz, useNow } from "./hooks";
import { useStyles, useTheme } from "../theme";
import { ACTIVITY_ICON, ClockIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { fmt } from "../lib/format";
import { clockTime, dayLabel } from "../lib/datetime";
import { activityLabel, diaperMeta, feedingMeta, medicationMeta } from "../lib/labels";
import i18n, { currentLocale } from "../i18n";

/** The structured fields line + the free-text note (rendered on its own line below). */
function entryParts(e: TimelineEntry): { meta: string; note: string | null } {
  switch (e.activity) {
    case "feeding":
      return { meta: feedingMeta(e.type, e.method, e.amount), note: e.notes };
    case "diaper":
      return { meta: diaperMeta(e.wet, e.solid), note: e.notes };
    case "sleep":
      return { meta: e.nap ? i18n.t("timeline.nap") : "", note: e.notes };
    case "tummy":
      return { meta: "", note: e.milestone }; // tummy's free text lives in `milestone`
    case "medication":
      return { meta: medicationMeta(e.name, e.dosage, e.dosageUnit), note: e.notes };
  }
}

function groupByDay(entries: TimelineEntry[]): { label: string; items: TimelineEntry[] }[] {
  const out: { label: string; items: TimelineEntry[] }[] = [];
  for (const e of entries) {
    const label = dayLabel(e.startMs);
    let group = out.find((g) => g.label === label);
    if (!group) {
      group = { label, items: [] };
      out.push(group);
    }
    group.items.push(e);
  }
  return out;
}

/** Localized "5 sec. ago" / "2 min ago" via the platform formatter — no per-unit translations. */
function relativeAgo(ms: number): string {
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto", style: "short" });
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return rtf.format(-s, "second");
  const m = Math.round(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  return rtf.format(-Math.round(m / 60), "hour");
}

/** A subtle "● updated Xs ago" line confirming the timeline is auto-refreshing. Self-ticks every
 *  5s in its own component so the (potentially long) entry list never re-renders on the clock. */
function Freshness({ updatedAt }: { updatedAt: number }) {
  const { palette } = useTheme();
  const { t } = useTranslation();
  const now = useNow(5000);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0 0 12px", color: palette.textFaint, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.2 }}>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: palette.accents.diaper.accent }} />
      {t("timeline.updated", { ago: relativeAgo(now - updatedAt) })}
    </div>
  );
}

export function Timeline({
  entries,
  updatedAt,
  onAdd,
  onEdit,
  onDelete,
  showAdd = true,
}: {
  entries: TimelineEntry[] | null;
  updatedAt?: number;
  onAdd?: () => void;
  onEdit: (e: TimelineEntry) => void;
  onDelete: (e: TimelineEntry) => void;
  /** When false, the internal "Add entry" button is hidden (the calendar supplies its own). */
  showAdd?: boolean;
}) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();

  // "↑ N new" pill. The list always renders live data (new rows animate in), but when the user
  // has scrolled away from the top we surface how many entries arrived since they last saw it —
  // a background poll, the other caregiver, or the Home Assistant buttons. A 1px sentinel at the
  // top of the list, observed via IntersectionObserver, tells us when the newest rows are on
  // screen; at that point we auto-acknowledge, so the pill never nags while you're at the top and
  // never flags your own just-added entry. Tapping jumps back to the newest.
  const sectionRef = useRef<HTMLElement>(null);
  const obsRef = useRef<IntersectionObserver | null>(null);
  const newestKeyRef = useRef<string | null>(null);
  const [atTop, setAtTop] = useState(true);
  const [ackKey, setAckKey] = useState<string | null>(null);

  const newestKey = entries && entries.length ? `${entries[0].path}${entries[0].id}` : null;
  // Keep the current top key reachable from the (stable) observer callback below.
  useEffect(() => {
    newestKeyRef.current = newestKey;
  }, [newestKey]);

  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    obsRef.current?.disconnect();
    if (!node) return;
    const obs = new IntersectionObserver(([e]) => {
      setAtTop(e.isIntersecting);
      // The moment the newest rows scroll out of view, snapshot what was newest. Entries that
      // arrive after this are the "new" ones; anything seen while at the top is at/below the mark
      // and never counts — including the user's own just-added entry.
      if (!e.isIntersecting) setAckKey(newestKeyRef.current);
    });
    obs.observe(node);
    obsRef.current = obs;
  }, []);
  useEffect(() => () => obsRef.current?.disconnect(), []);

  // Entries newer than the snapshot sit above it (list is newest-first → its index = the count).
  const newCount = useMemo(() => {
    if (atTop || !entries || !ackKey) return 0;
    const idx = entries.findIndex((e) => `${e.path}${e.id}` === ackKey);
    return idx < 0 ? 0 : idx;
  }, [atTop, entries, ackKey]);

  const jumpToTop = () => {
    buzz();
    setAtTop(true); // hide the pill immediately; the observer reconfirms once the scroll lands
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section ref={sectionRef} style={s.timeline}>
      {newCount > 0 && (
        <button
          onClick={jumpToTop}
          style={{
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            // Clears the calendar's fixed "Add entry" bar, which floats at the very bottom.
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 92px)",
            zIndex: 999,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "11px 18px",
            borderRadius: 999,
            border: "none",
            background: palette.accents.feeding.accent,
            color: palette.onAccent,
            font: "inherit",
            fontWeight: 800,
            fontSize: 14,
            lineHeight: 1.2,
            boxShadow: "0 10px 34px rgba(0,0,0,.28)",
            cursor: "pointer",
          }}
        >
          <span aria-hidden style={{ fontSize: 16 }}>↑</span>
          {t("timeline.newEntries", { count: newCount })}
        </button>
      )}

      {updatedAt ? <Freshness updatedAt={updatedAt} /> : null}

      {showAdd && onAdd && (
        <button onClick={onAdd} style={s.addBtn}>
          <span style={s.addPlus}>
            <PlusIcon size={18} />
          </span>
          {t("timeline.addEntry")}
        </button>
      )}

      {entries == null ? (
        <div style={s.empty}>
          <div className="spin" style={{ width: 30, height: 30, borderRadius: "50%", border: `3px solid ${palette.surfaceStrongBorder}`, borderTopColor: palette.accents.feeding.accent }} />
        </div>
      ) : entries.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyIco}>
            <ClockIcon size={28} />
          </div>
          <div style={s.emptyTitle}>{t("timeline.noEntries")}</div>
          <div style={s.emptySub}>{t("timeline.noEntriesSub")}</div>
        </div>
      ) : (
        <>
          <div ref={sentinelRef} aria-hidden style={{ height: 1, marginBottom: -1 }} />
          {groupByDay(entries).map((group) => (
          <div key={group.label} style={s.daygroup}>
            <div style={s.dayhead}>{group.label}</div>
            {group.items.map((e) => {
              const accent = palette.accents[e.activity].accent;
              const Icon = ACTIVITY_ICON[e.activity];
              const { meta, note } = entryParts(e);
              return (
                <div key={`${e.path}${e.id}`} className="entry-in" style={s.entry}>
                  <button onClick={() => onEdit(e)} style={s.entryTap}>
                    <span style={{ ...s.entryIco, color: accent, background: `${accent}1a` }}>
                      <Icon size={20} />
                    </span>
                    <div style={s.entryMid}>
                      <div style={s.entryLabel}>
                        {activityLabel(e.activity)}
                        {meta ? <span style={s.entryMeta}> · {meta}</span> : null}
                      </div>
                      {note && <div style={s.entryNote}>“{note}”</div>}
                      <div style={s.entryTime}>
                        {clockTime(e.startMs)}
                        {e.endMs ? ` – ${clockTime(e.endMs)} · ${fmt(e.endMs - e.startMs)}` : ""}
                      </div>
                    </div>
                  </button>
                  <button onClick={() => onDelete(e)} style={s.entryDel} aria-label={t("common.delete")}>
                    <TrashIcon size={17} />
                  </button>
                </div>
              );
            })}
          </div>
          ))}
        </>
      )}
    </section>
  );
}
