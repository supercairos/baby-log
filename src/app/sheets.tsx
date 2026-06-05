/**
 * Bottom sheets: feeding refinement (over a running timer), diaper logging, and the
 * shared add/edit entry sheet. Each renders its own sliding container; the scrim lives in
 * Home. Feeding method chips are filtered by type via METHODS_FOR_TYPE and self-correct.
 */
import {
  ACTIVITIES,
  DIAPER_STATES,
  METHODS_FOR_TYPE,
  type ActivityKey,
  type FeedingMethod,
  type FeedingType,
} from "../api";
import { useTranslation } from "react-i18next";
import { useStyles, useTheme } from "../theme";
import { activityLabel, feedMethodOptions, feedTypeOptions } from "../lib/labels";
import { fmt, toLocalInput, fromLocalInput } from "../lib/format";
import { ACTIVITY_ICON, TrashIcon } from "../ui/icons";
import { buzz } from "./hooks";
import { useFocusTrap } from "./useFocusTrap";
import type { EditDraft, EditTarget } from "./types";

function SheetShell({ open, label, children }: { open: boolean; label: string; children: React.ReactNode }) {
  const { s } = useStyles();
  const ref = useFocusTrap<HTMLDivElement>(open);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal={open}
      aria-label={label}
      tabIndex={-1}
      inert={!open || undefined}
      style={{ ...s.sheet, ...(open ? s.sheetOn : {}) }}
    >
      {children}
    </div>
  );
}

// ── Feeding refinement ────────────────────────────────────────────────────────
export function FeedingSheet({
  open,
  elapsedMs,
  type,
  method,
  onType,
  onMethod,
  onDone,
}: {
  open: boolean;
  elapsedMs: number | null;
  type: FeedingType | null;
  method: FeedingMethod | null;
  onType: (t: FeedingType) => void;
  onMethod: (m: FeedingMethod) => void;
  onDone: () => void;
}) {
  const { s, chipOn } = useStyles();
  const { t } = useTranslation();
  const feed = useTheme().palette.accents.feeding.accent;
  const allowedMethods = type ? METHODS_FOR_TYPE[type] : [];

  return (
    <SheetShell open={open} label={t("sheet.feedingDetails")}>
      <div style={s.sheetHandle} />
      <div style={s.sheetTitle}>{t("activity.feeding")}</div>
      <div style={s.sheetRunning}>
        <span className="breathe" style={{ width: 6, height: 6, borderRadius: "50%", background: feed }} />
        {t("sheet.timerRunning")}
        {elapsedMs != null ? ` · ${fmt(elapsedMs)}` : ""} — {t("sheet.addDetailsHint")}
      </div>

      <div style={s.sheetGroup}>{t("sheet.type")}</div>
      <div style={s.chips}>
        {feedTypeOptions().map((opt) => (
          <button key={opt.id} aria-pressed={type === opt.id} onClick={() => onType(opt.id)} style={{ ...s.chip, ...(type === opt.id ? chipOn(feed) : {}) }}>
            {opt.label}
          </button>
        ))}
      </div>

      {allowedMethods.length > 0 && (
        <>
          <div style={s.sheetGroup}>{t("sheet.method")}</div>
          <div style={s.chips}>
            {feedMethodOptions().filter((m) => allowedMethods.includes(m.id)).map((m) => (
              <button key={m.id} aria-pressed={method === m.id} onClick={() => onMethod(m.id)} style={{ ...s.chip, ...(method === m.id ? chipOn(feed) : {}) }}>
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}

      <button onClick={onDone} style={s.cta}>
        {t("common.done")}
      </button>
    </SheetShell>
  );
}

// ── Diaper ──────────────────────────────────────────────────────────────────
export function DiaperSheet({ open, onLog }: { open: boolean; onLog: (preset: { wet: boolean; solid: boolean; label: string }) => void }) {
  const { s } = useStyles();
  const { t } = useTranslation();
  return (
    <SheetShell open={open} label={t("sheet.logDiaper")}>
      <div style={s.sheetHandle} />
      <div style={s.sheetTitle}>{t("activity.diaper")}</div>
      <div style={s.diaperRow}>
        {DIAPER_STATES.map((o) => (
          <button key={o.id} onClick={() => onLog(o)} style={s.diaperBtn}>
            <span
              style={{
                ...s.diaperDot,
                background: o.solid && o.wet ? "linear-gradient(135deg,#a4c8a0,#c9a86a)" : o.solid ? "#c9a86a" : "#a4c8a0",
              }}
            />
            {t(`diaper.${o.id}`)}
          </button>
        ))}
      </div>
    </SheetShell>
  );
}

// ── Add / edit entry ──────────────────────────────────────────────────────────
export function EntrySheet({
  target,
  draft,
  setDraft,
  onPickKind,
  onSave,
  onDelete,
}: {
  target: EditTarget | null;
  draft: EditDraft | null;
  setDraft: (update: (d: EditDraft) => EditDraft) => void;
  onPickKind: (key: ActivityKey) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const { s, chipOn } = useStyles();
  const { t } = useTranslation();
  const { palette } = useTheme();
  const feed = palette.accents.feeding.accent;
  const open = !!(target && draft);

  if (!target || !draft) return <SheetShell open={false} label={t("sheet.entry")}>{null}</SheetShell>;

  const adding = target.isNew;
  const needsKind = adding && !target.activity;
  const isTimed = target.activity != null && target.activity !== "diaper";
  const allowed = draft.type ? METHODS_FOR_TYPE[draft.type] : [];
  const endBeforeStart = draft.endMs != null && draft.endMs < draft.startMs;
  const label = target.activity ? activityLabel(target.activity) : t("sheet.entry");

  return (
    <SheetShell open={open} label={adding ? t("sheet.addEntry") : t("sheet.editActivity", { activity: label })}>
      <div style={s.sheetHandle} />
      <div style={s.editHead}>
        <div style={s.sheetTitle}>
          {adding ? (target.activity ? t("sheet.addActivity", { activity: label }) : t("sheet.addEntry")) : t("sheet.editActivity", { activity: label })}
        </div>
        {!adding && (
          <button onClick={onDelete} style={s.editDel}>
            <TrashIcon size={16} />
            {t("common.delete")}
          </button>
        )}
      </div>

      {needsKind && (
        <>
          <div style={s.sheetGroup}>{t("sheet.activity")}</div>
          <div style={s.chips}>
            {(Object.keys(ACTIVITIES) as ActivityKey[]).map((key) => {
              const Icon = ACTIVITY_ICON[key];
              return (
                <button key={key} onClick={() => onPickKind(key)} style={{ ...s.chip, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: palette.accents[key].accent, display: "grid", placeItems: "center" }}>
                    <Icon size={17} />
                  </span>
                  {activityLabel(key)}
                </button>
              );
            })}
          </div>
        </>
      )}

      {target.activity === "feeding" && (
        <>
          <div style={s.sheetGroup}>{t("sheet.type")}</div>
          <div style={s.chips}>
            {feedTypeOptions().map((opt) => (
              <button
                key={opt.id}
                aria-pressed={draft.type === opt.id}
                onClick={() => {
                  buzz();
                  setDraft((d) => {
                    const al = METHODS_FOR_TYPE[opt.id];
                    const method = d.method && al.includes(d.method) ? d.method : (al.length === 1 ? al[0] : null);
                    return { ...d, type: opt.id, method };
                  });
                }}
                style={{ ...s.chip, ...(draft.type === opt.id ? chipOn(feed) : {}) }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {allowed.length > 0 && (
            <>
              <div style={s.sheetGroup}>{t("sheet.method")}</div>
              <div style={s.chips}>
                {feedMethodOptions().filter((m) => allowed.includes(m.id)).map((m) => (
                  <button
                    key={m.id}
                    aria-pressed={draft.method === m.id}
                    onClick={() => { buzz(); setDraft((d) => ({ ...d, method: m.id })); }}
                    style={{ ...s.chip, ...(draft.method === m.id ? chipOn(feed) : {}) }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {target.activity === "diaper" && (
        <>
          <div style={s.sheetGroup}>{t("sheet.contents")}</div>
          <div style={s.chips}>
            <button aria-pressed={draft.wet} onClick={() => { buzz(); setDraft((d) => ({ ...d, wet: !d.wet })); }} style={{ ...s.chip, ...(draft.wet ? chipOn("#a4c8a0") : {}) }}>
              {draft.wet ? "✓ " : ""}{t("diaper.wet")}
            </button>
            <button aria-pressed={draft.solid} onClick={() => { buzz(); setDraft((d) => ({ ...d, solid: !d.solid })); }} style={{ ...s.chip, ...(draft.solid ? chipOn("#c9a86a") : {}) }}>
              {draft.solid ? "✓ " : ""}{t("diaper.solid")}
            </button>
          </div>
        </>
      )}

      {target.activity && (
        <>
          <div style={s.sheetGroup}>{isTimed ? t("sheet.start") : t("sheet.time")}</div>
          <input
            type="datetime-local"
            value={toLocalInput(draft.startMs)}
            onChange={(e) => setDraft((d) => ({ ...d, startMs: fromLocalInput(e.target.value) }))}
            style={s.timeInput}
          />
          {isTimed && (
            <>
              <div style={s.sheetGroup}>{t("sheet.end")}</div>
              <input
                type="datetime-local"
                value={toLocalInput(draft.endMs ?? draft.startMs)}
                min={toLocalInput(draft.startMs)}
                aria-invalid={endBeforeStart}
                onChange={(e) => setDraft((d) => ({ ...d, endMs: fromLocalInput(e.target.value) }))}
                style={s.timeInput}
              />
              {draft.endMs != null && (
                <div role="status" aria-live="polite" style={{ ...s.durReadout, ...(endBeforeStart ? s.durBad : {}) }}>
                  {endBeforeStart ? t("sheet.endIsBeforeStart") : t("sheet.duration", { duration: fmt(draft.endMs - draft.startMs) })}
                </div>
              )}
            </>
          )}
          <button onClick={onSave} style={s.cta}>
            {adding ? t("sheet.addEntry") : t("sheet.saveChanges")}
          </button>
        </>
      )}
    </SheetShell>
  );
}
