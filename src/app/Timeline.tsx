/**
 * Timeline page — merged recent entries grouped Today / Yesterday / weekday-date, newest
 * first. Each row is tappable to edit; the trash button deletes. "Add entry" opens the
 * same sheet with an activity picker for backdated logging.
 */
import { useTranslation } from "react-i18next";
import type { TimelineEntry } from "../api";
import { useStyles, useTheme } from "../theme";
import { ACTIVITY_ICON, ClockIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { fmt } from "../lib/format";
import { clockTime, dayLabel } from "../lib/datetime";
import { activityLabel, diaperMeta, feedingMeta } from "../lib/labels";
import i18n from "../i18n";

function entryMeta(e: TimelineEntry): string {
  switch (e.activity) {
    case "feeding":
      return feedingMeta(e.type, e.method);
    case "diaper":
      return diaperMeta(e.wet, e.solid);
    case "sleep":
      return e.nap ? i18n.t("timeline.nap") : "";
    case "tummy":
      return e.milestone ?? "";
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

export function Timeline({
  entries,
  onAdd,
  onEdit,
  onDelete,
  showAdd = true,
}: {
  entries: TimelineEntry[] | null;
  onAdd?: () => void;
  onEdit: (e: TimelineEntry) => void;
  onDelete: (e: TimelineEntry) => void;
  /** When false, the internal "Add entry" button is hidden (the calendar supplies its own). */
  showAdd?: boolean;
}) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();

  return (
    <section style={s.timeline}>
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
        groupByDay(entries).map((group) => (
          <div key={group.label} style={s.daygroup}>
            <div style={s.dayhead}>{group.label}</div>
            {group.items.map((e) => {
              const accent = palette.accents[e.activity].accent;
              const Icon = ACTIVITY_ICON[e.activity];
              const meta = entryMeta(e);
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
        ))
      )}
    </section>
  );
}
