/**
 * Bottom sheets: feeding refinement (over a running timer), diaper logging, and the
 * shared add/edit entry sheet. Each renders its own sliding container; the scrim lives in
 * Home. Feeding method chips are filtered by type via METHODS_FOR_TYPE and self-correct.
 */
import {
  ACTIVITIES,
  DIAPER_STATES,
  MEDICATION_UNITS,
  METHODS_FOR_TYPE,
  type ActivityKey,
  type FeedingMethod,
  type FeedingType,
} from "../api";
import { useTranslation } from "react-i18next";
import { useStyles, useTheme } from "../theme";
import { activityLabel, feedMethodLabel, feedMethodOptions, feedTypeOptions, medicationMeta, medUnitLabel } from "../lib/labels";
import { fmt, toLocalInput, fromLocalInput } from "../lib/format";
import { ACTIVITY_ICON, TrashIcon } from "../ui/icons";
import { buzz } from "./hooks";
import { useFocusTrap } from "./useFocusTrap";
import type { EditDraft, EditTarget, RecentMed } from "./types";

/** Preset minimum-gap options (hours) offered for a medication's next dose. */
const MED_INTERVAL_HOURS = [4, 6, 8, 12, 24] as const;
const HOUR_MS = 3_600_000;

/**
 * Bottle-amount slider ladder — intelligent steps: 5 ml where precision matters (small bottles),
 * 10 ml through the common range, 25 ml at the top. The slider moves over indexes of this list;
 * index 0 = no amount.
 */
const ML_STEPS: number[] = [
  ...Array.from({ length: 19 }, (_, i) => 10 + i * 5), // 10..100 by 5
  ...Array.from({ length: 10 }, (_, i) => 110 + i * 10), // 110..200 by 10
  ...Array.from({ length: 4 }, (_, i) => 225 + i * 25), // 225..300 by 25
];
const mlToIdx = (ml: number | null): number =>
  ml == null ? 0 : 1 + ML_STEPS.reduce((best, v, i) => (Math.abs(v - ml) < Math.abs(ML_STEPS[best] - ml) ? i : best), 0);
const idxToMl = (idx: number): number | null => (idx <= 0 ? null : ML_STEPS[Math.min(idx, ML_STEPS.length) - 1]);

// ── Breast method as two toggles ───────────────────────────────────────────────
// Gauche and Droite are independently toggleable; both lit maps to the server's
// "both breasts" — no separate "Les deux" chip. Biberon stays an exclusive choice.
type BreastSide = "left breast" | "right breast";
const breastPressed = (m: FeedingMethod | null, side: BreastSide) => m === side || m === "both breasts";
function toggleBreast(current: FeedingMethod | null, side: BreastSide): FeedingMethod | null {
  const other: BreastSide = side === "left breast" ? "right breast" : "left breast";
  if (current === side) return null; // last lit side tapped → nothing selected
  if (current === "both breasts") return other;
  if (current === other) return "both breasts";
  return side;
}

function BreastMethodChips({
  method,
  accent,
  onMethod,
}: {
  method: FeedingMethod | null;
  accent: string;
  onMethod: (m: FeedingMethod | null) => void;
}) {
  const { s, chipOn } = useStyles();
  const sides: BreastSide[] = ["left breast", "right breast"];
  return (
    <div style={s.chips}>
      {sides.map((side) => (
        <button
          key={side}
          aria-pressed={breastPressed(method, side)}
          onClick={() => { buzz(); onMethod(toggleBreast(method, side)); }}
          style={{ ...s.chip, ...(breastPressed(method, side) ? chipOn(accent) : {}) }}
        >
          {feedMethodLabel(side)}
        </button>
      ))}
      <button
        aria-pressed={method === "bottle"}
        onClick={() => { buzz(); onMethod("bottle"); }}
        style={{ ...s.chip, ...(method === "bottle" ? chipOn(accent) : {}) }}
      >
        {feedMethodLabel("bottle")}
      </button>
    </div>
  );
}

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
  started,
  elapsedMs,
  type,
  method,
  amount,
  onType,
  onMethod,
  onAmount,
  onDone,
}: {
  open: boolean;
  /** false = pre-start (details first, the CTA starts the timer); true = refining a running timer. */
  started: boolean;
  elapsedMs: number | null;
  type: FeedingType | null;
  method: FeedingMethod | null;
  amount: number | null;
  onType: (t: FeedingType) => void;
  onMethod: (m: FeedingMethod | null) => void;
  onAmount: (ml: number | null) => void;
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
      {started && (
        <div style={s.sheetRunning}>
          <span className="breathe" style={{ width: 6, height: 6, borderRadius: "50%", background: feed }} />
          {t("sheet.timerRunning")}
          {elapsedMs != null ? ` · ${fmt(elapsedMs)}` : ""} — {t("sheet.addDetailsHint")}
        </div>
      )}

      <div style={s.sheetGroup}>{t("sheet.type")}</div>
      <div style={s.chips}>
        {feedTypeOptions().map((opt) => (
          <button key={opt.id} aria-pressed={type === opt.id} onClick={() => onType(opt.id)} style={{ ...s.chip, ...(type === opt.id ? chipOn(feed) : {}) }}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* A single allowed method (formula/fortified → bottle) is auto-selected — don't ask.
          Breast milk gets the two-toggle chooser (both lit = "both breasts"). */}
      {type === "breast milk" ? (
        <>
          <div style={s.sheetGroup}>{t("sheet.method")}</div>
          <BreastMethodChips method={method} accent={feed} onMethod={onMethod} />
        </>
      ) : allowedMethods.length > 1 ? (
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
      ) : null}

      {/* Any bottle is measured — formula/fortified (always bottle) AND pumped breast milk. */}
      {method === "bottle" && (
        <>
          <div style={s.sheetGroup}>{t("sheet.amount")}</div>
          <div style={s.sliderRow}>
            <input
              type="range"
              min={0}
              max={ML_STEPS.length}
              step={1}
              value={mlToIdx(amount)}
              aria-label={t("sheet.amount")}
              onChange={(e) => onAmount(idxToMl(Number(e.target.value)))}
              style={{ ...s.slider, accentColor: feed }}
            />
            <span style={s.sliderValue}>{amount != null ? `${amount} ml` : "—"}</span>
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
  recentMeds,
  onPickKind,
  onSave,
  onDelete,
}: {
  target: EditTarget | null;
  draft: EditDraft | null;
  setDraft: (update: (d: EditDraft) => EditDraft) => void;
  recentMeds: RecentMed[];
  onPickKind: (key: ActivityKey) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const { s, chipOn } = useStyles();
  const { t } = useTranslation();
  const { palette } = useTheme();
  const feed = palette.accents.feeding.accent;
  const med = palette.accents.medication.accent;
  const open = !!(target && draft);

  if (!target || !draft) return <SheetShell open={false} label={t("sheet.entry")}>{null}</SheetShell>;

  const adding = target.isNew;
  const needsKind = adding && !target.activity;
  // Timed activities (feeding/sleep/tummy) get start+end; instant ones (diaper/medication) a single time.
  const isTimed = target.activity != null && ACTIVITIES[target.activity].timed;
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
          {/* A single allowed method (formula/fortified → bottle) is auto-selected — don't ask.
              Breast milk gets the two-toggle chooser (both lit = "both breasts"). */}
          {draft.type === "breast milk" ? (
            <>
              <div style={s.sheetGroup}>{t("sheet.method")}</div>
              <BreastMethodChips method={draft.method} accent={feed} onMethod={(m) => setDraft((d) => ({ ...d, method: m }))} />
            </>
          ) : allowed.length > 1 ? (
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
          ) : null}
          {/* Any bottle is measured — formula/fortified (always bottle) AND pumped breast milk. */}
          {draft.method === "bottle" && (
            <>
              <div style={s.sheetGroup}>{t("sheet.amount")}</div>
              <div style={s.sliderRow}>
                <input
                  type="range"
                  min={0}
                  max={ML_STEPS.length}
                  step={1}
                  value={mlToIdx(draft.amount)}
                  aria-label={t("sheet.amount")}
                  onChange={(e) => setDraft((d) => ({ ...d, amount: idxToMl(Number(e.target.value)) }))}
                  style={{ ...s.slider, accentColor: feed }}
                />
                <span style={s.sliderValue}>{draft.amount != null ? `${draft.amount} ml` : "—"}</span>
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

      {target.activity === "medication" && (
        <>
          {/* One-tap "repeat last dose": recent distinct meds prefill name + dose + interval. */}
          {recentMeds.length > 0 && (
            <>
              <div style={s.sheetGroup}>{t("sheet.recentDoses")}</div>
              <div style={s.chips}>
                {recentMeds.map((m) => {
                  const on =
                    draft.medName.trim().toLowerCase() === m.name.toLowerCase() &&
                    draft.dosage === m.dosage &&
                    draft.dosageUnit === m.dosageUnit;
                  return (
                    <button
                      key={m.name.toLowerCase()}
                      aria-pressed={on}
                      onClick={() => {
                        buzz();
                        setDraft((d) => ({ ...d, medName: m.name, dosage: m.dosage, dosageUnit: m.dosageUnit, nextDoseMs: m.nextDoseMs }));
                      }}
                      style={{ ...s.chip, ...(on ? chipOn(med) : {}) }}
                    >
                      {medicationMeta(m.name, m.dosage, m.dosageUnit)}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div style={s.sheetGroup}>{t("sheet.medName")}</div>
          <input
            type="text"
            value={draft.medName}
            onChange={(e) => setDraft((d) => ({ ...d, medName: e.target.value }))}
            placeholder={t("sheet.medNamePlaceholder")}
            autoComplete="off"
            style={s.timeInput}
          />
          <div style={s.sheetGroup}>{t("sheet.dose")}</div>
          <div style={s.sliderRow}>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={draft.dosage ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, dosage: e.target.value === "" ? null : Number(e.target.value) }))}
              placeholder="—"
              aria-label={t("sheet.dose")}
              style={{ ...s.timeInput, flex: "0 0 96px", width: 96 }}
            />
            <div style={s.chips}>
              {MEDICATION_UNITS.map((u) => (
                <button
                  key={u}
                  aria-pressed={draft.dosageUnit === u}
                  onClick={() => { buzz(); setDraft((d) => ({ ...d, dosageUnit: d.dosageUnit === u ? null : u })); }}
                  style={{ ...s.chip, ...(draft.dosageUnit === u ? chipOn(med) : {}) }}
                >
                  {medUnitLabel(u)}
                </button>
              ))}
            </div>
          </div>
          {/* Optional minimum gap before the next dose — powers the home-screen double-dose guard. */}
          <div style={s.sheetGroup}>{t("sheet.nextDoseAfter")}</div>
          <div style={s.chips}>
            {MED_INTERVAL_HOURS.map((h) => (
              <button
                key={h}
                aria-pressed={draft.nextDoseMs === h * HOUR_MS}
                onClick={() => { buzz(); setDraft((d) => ({ ...d, nextDoseMs: d.nextDoseMs === h * HOUR_MS ? null : h * HOUR_MS })); }}
                style={{ ...s.chip, ...(draft.nextDoseMs === h * HOUR_MS ? chipOn(med) : {}) }}
              >
                {t("sheet.hoursShort", { h })}
              </button>
            ))}
          </div>
        </>
      )}

      {target.activity && (
        <>
          {isTimed ? (
            /* Start + End side by side on one row, each labelled. */
            <div style={s.timeRow}>
              <div style={s.timeCol}>
                <div style={s.sheetGroup}>{t("sheet.start")}</div>
                <input
                  type="datetime-local"
                  value={toLocalInput(draft.startMs)}
                  onChange={(e) => setDraft((d) => ({ ...d, startMs: fromLocalInput(e.target.value) }))}
                  style={{ ...s.timeInput, ...s.timeInputCompact }}
                />
              </div>
              <div style={s.timeCol}>
                <div style={s.sheetGroup}>{t("sheet.end")}</div>
                <input
                  type="datetime-local"
                  value={toLocalInput(draft.endMs ?? draft.startMs)}
                  min={toLocalInput(draft.startMs)}
                  aria-invalid={endBeforeStart}
                  onChange={(e) => setDraft((d) => ({ ...d, endMs: fromLocalInput(e.target.value) }))}
                  style={{ ...s.timeInput, ...s.timeInputCompact }}
                />
              </div>
            </div>
          ) : (
            <>
              <div style={s.sheetGroup}>{t("sheet.time")}</div>
              <input
                type="datetime-local"
                value={toLocalInput(draft.startMs)}
                onChange={(e) => setDraft((d) => ({ ...d, startMs: fromLocalInput(e.target.value) }))}
                style={s.timeInput}
              />
            </>
          )}
          {isTimed && draft.endMs != null && (
            <div role="status" aria-live="polite" style={{ ...s.durReadout, ...(endBeforeStart ? s.durBad : {}) }}>
              {endBeforeStart ? t("sheet.endIsBeforeStart") : t("sheet.duration", { duration: fmt(draft.endMs - draft.startMs) })}
            </div>
          )}

          <div style={s.sheetGroup}>{t("sheet.notes")}</div>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            placeholder={t("sheet.notesPlaceholder")}
            rows={2}
            style={s.notesInput}
          />

          <button onClick={onSave} style={s.cta}>
            {adding ? t("sheet.addEntry") : t("sheet.saveChanges")}
          </button>
        </>
      )}
    </SheetShell>
  );
}
