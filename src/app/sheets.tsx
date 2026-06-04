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
import { useStyles, useTheme } from "../theme";
import { FEED_METHOD_OPTIONS, FEED_TYPE_OPTIONS } from "../lib/labels";
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
  const feed = useTheme().palette.accents.feeding.accent;
  const allowedMethods = type ? METHODS_FOR_TYPE[type] : [];

  return (
    <SheetShell open={open} label="Feeding details">
      <div style={s.sheetHandle} />
      <div style={s.sheetTitle}>Feeding</div>
      <div style={s.sheetRunning}>
        <span className="breathe" style={{ width: 6, height: 6, borderRadius: "50%", background: feed }} />
        Timer running{elapsedMs != null ? ` · ${fmt(elapsedMs)}` : ""} — add details if you like
      </div>

      <div style={s.sheetGroup}>Type</div>
      <div style={s.chips}>
        {FEED_TYPE_OPTIONS.map((t) => (
          <button key={t.id} aria-pressed={type === t.id} onClick={() => onType(t.id)} style={{ ...s.chip, ...(type === t.id ? chipOn(feed) : {}) }}>
            {t.label}
          </button>
        ))}
      </div>

      {allowedMethods.length > 0 && (
        <>
          <div style={s.sheetGroup}>Method</div>
          <div style={s.chips}>
            {FEED_METHOD_OPTIONS.filter((m) => allowedMethods.includes(m.id)).map((m) => (
              <button key={m.id} aria-pressed={method === m.id} onClick={() => onMethod(m.id)} style={{ ...s.chip, ...(method === m.id ? chipOn(feed) : {}) }}>
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}

      <button onClick={onDone} style={s.cta}>
        Done
      </button>
    </SheetShell>
  );
}

// ── Diaper ──────────────────────────────────────────────────────────────────
export function DiaperSheet({ open, onLog }: { open: boolean; onLog: (preset: { wet: boolean; solid: boolean; label: string }) => void }) {
  const { s } = useStyles();
  return (
    <SheetShell open={open} label="Log diaper">
      <div style={s.sheetHandle} />
      <div style={s.sheetTitle}>Diaper</div>
      <div style={s.diaperRow}>
        {DIAPER_STATES.map((o) => (
          <button key={o.id} onClick={() => onLog(o)} style={s.diaperBtn}>
            <span
              style={{
                ...s.diaperDot,
                background: o.solid && o.wet ? "linear-gradient(135deg,#a4c8a0,#c9a86a)" : o.solid ? "#c9a86a" : "#a4c8a0",
              }}
            />
            {o.label}
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
  const { palette } = useTheme();
  const feed = palette.accents.feeding.accent;
  const open = !!(target && draft);

  if (!target || !draft) return <SheetShell open={false} label="Entry">{null}</SheetShell>;

  const adding = target.isNew;
  const needsKind = adding && !target.activity;
  const isTimed = target.activity != null && target.activity !== "diaper";
  const allowed = draft.type ? METHODS_FOR_TYPE[draft.type] : [];
  const endBeforeStart = draft.endMs != null && draft.endMs < draft.startMs;
  const label = target.activity ? ACTIVITIES[target.activity].label : "entry";

  return (
    <SheetShell open={open} label={adding ? "Add entry" : `Edit ${label}`}>
      <div style={s.sheetHandle} />
      <div style={s.editHead}>
        <div style={s.sheetTitle}>{adding ? (target.activity ? `Add ${label}` : "Add entry") : `Edit ${label}`}</div>
        {!adding && (
          <button onClick={onDelete} style={s.editDel}>
            <TrashIcon size={16} />
            Delete
          </button>
        )}
      </div>

      {needsKind && (
        <>
          <div style={s.sheetGroup}>Activity</div>
          <div style={s.chips}>
            {(Object.keys(ACTIVITIES) as ActivityKey[]).map((key) => {
              const Icon = ACTIVITY_ICON[key];
              return (
                <button key={key} onClick={() => onPickKind(key)} style={{ ...s.chip, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: palette.accents[key].accent, display: "grid", placeItems: "center" }}>
                    <Icon size={17} />
                  </span>
                  {ACTIVITIES[key].label}
                </button>
              );
            })}
          </div>
        </>
      )}

      {target.activity === "feeding" && (
        <>
          <div style={s.sheetGroup}>Type</div>
          <div style={s.chips}>
            {FEED_TYPE_OPTIONS.map((t) => (
              <button
                key={t.id}
                aria-pressed={draft.type === t.id}
                onClick={() => {
                  buzz();
                  setDraft((d) => {
                    const al = METHODS_FOR_TYPE[t.id];
                    const method = d.method && al.includes(d.method) ? d.method : (al.length === 1 ? al[0] : null);
                    return { ...d, type: t.id, method };
                  });
                }}
                style={{ ...s.chip, ...(draft.type === t.id ? chipOn(feed) : {}) }}
              >
                {t.label}
              </button>
            ))}
          </div>
          {allowed.length > 0 && (
            <>
              <div style={s.sheetGroup}>Method</div>
              <div style={s.chips}>
                {FEED_METHOD_OPTIONS.filter((m) => allowed.includes(m.id)).map((m) => (
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
          <div style={s.sheetGroup}>Contents</div>
          <div style={s.chips}>
            <button aria-pressed={draft.wet} onClick={() => { buzz(); setDraft((d) => ({ ...d, wet: !d.wet })); }} style={{ ...s.chip, ...(draft.wet ? chipOn("#a4c8a0") : {}) }}>
              {draft.wet ? "✓ " : ""}Wet
            </button>
            <button aria-pressed={draft.solid} onClick={() => { buzz(); setDraft((d) => ({ ...d, solid: !d.solid })); }} style={{ ...s.chip, ...(draft.solid ? chipOn("#c9a86a") : {}) }}>
              {draft.solid ? "✓ " : ""}Solid
            </button>
          </div>
        </>
      )}

      {target.activity && (
        <>
          <div style={s.sheetGroup}>{isTimed ? "Start" : "Time"}</div>
          <input
            type="datetime-local"
            value={toLocalInput(draft.startMs)}
            onChange={(e) => setDraft((d) => ({ ...d, startMs: fromLocalInput(e.target.value) }))}
            style={s.timeInput}
          />
          {isTimed && (
            <>
              <div style={s.sheetGroup}>End</div>
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
                  {endBeforeStart ? "End is before start" : `Duration · ${fmt(draft.endMs - draft.startMs)}`}
                </div>
              )}
            </>
          )}
          <button onClick={onSave} style={s.cta}>
            {adding ? "Add entry" : "Save changes"}
          </button>
        </>
      )}
    </SheetShell>
  );
}
