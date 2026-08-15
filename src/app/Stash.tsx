/**
 * Milk stash — the two views over pumped bottles.
 *
 *  · `PumpDayList` sits under the day dial and is DAY-scoped: what was expressed on the day
 *    you're looking at. The dial deliberately draws no pump marks (pumping is the parent's
 *    activity, not something that happened to the baby), so this list is where the day's
 *    sessions surface.
 *  · `StashPage` is the inventory and is NOT day-scoped: what's in the fridge right now,
 *    soonest to turn first. Milk outlives the day it was pumped on, so "what do I use next"
 *    can't be answered from a single day's column.
 *
 * Both read expiry rather than store it — see lib/stash.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  enqueueMutation,
  updateEntryMutation,
  type BabyBuddyClient,
  type TimelineEntry,
} from "../api";
import { useStyles, useTheme } from "../theme";
import { ACTIVITY_ICON, FridgeIcon, SnowflakeIcon, ThawIcon, ThermometerIcon, type IconProps } from "../ui/icons";
import { clockTime, shortDateTime } from "../lib/datetime";
import {
  decodeStashNotes,
  encodeStashNotes,
  expiresAt,
  isAvailable,
  moveStash,
  toBottle,
  type StashBottle,
  type StashInfo,
  type StashLocation,
} from "../lib/stash";
import { buzz, usePumpings, useNow } from "./hooks";

/** Millilitres for display: litres once it stops being a sensible number of ml. */
function volume(ml: number): string {
  return ml >= 1000 ? `${(ml / 1000).toFixed(1)} L` : `${ml} ml`;
}

/** Where the bottle is kept, as a glyph. Keyed by location so it can't drift from the label. */
const STASH_ICON: Record<StashLocation, (p: IconProps) => React.ReactElement> = {
  fridge: FridgeIcon,
  freezer: SnowflakeIcon,
  room: ThermometerIcon,
  thawed: ThawIcon,
};

/** When a stored bottle lapses — the absolute moment, or that it already has. */
function useFreshness() {
  const { t } = useTranslation();
  const { palette } = useTheme();
  return (stash: StashInfo, now: number) => {
    const at = expiresAt(stash);
    if (at <= now) return { text: t("stash.expired"), color: palette.danger };
    // Under six hours it stops being background information and becomes a decision.
    const color = at - now < 6 * 3_600_000 ? palette.accents.feeding.accent : palette.textFaint;
    return { text: t("stash.expiresOn", { date: shortDateTime(at) }), color };
  };
}

// ── Day list (under the dial) ────────────────────────────────────────────────
export function PumpDayList({ entries }: { entries: TimelineEntry[] }) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const now = useNow(60_000);
  const freshness = useFreshness();
  const accent = palette.accents.pumping.accent;
  const Icon = ACTIVITY_ICON.pumping;

  const pumps = entries
    .filter((e): e is Extract<TimelineEntry, { activity: "pumping" }> => e.activity === "pumping")
    .sort((a, b) => a.startMs - b.startMs);
  if (pumps.length === 0) return null;

  const total = pumps.reduce((sum, e) => sum + e.amount, 0);
  return (
    <section style={{ marginTop: 22 }}>
      <div style={s.sheetGroup}>
        {t("stash.dayTitle")} · {t("stash.total", { count: pumps.length, volume: volume(total) })}
      </div>
      {pumps.map((e) => {
        const stash = decodeStashNotes(e.notes);
        const fresh = stash && stash.state === "stored" ? freshness(stash, now) : null;
        const where = stash == null ? null : stash.state === "stored" ? t(`stash.loc.${stash.loc}`) : t(`stash.${stash.state}`);
        // Storage glyph once we know where it went; the pump itself for an untracked entry
        // (logged in Baby Buddy's own UI, or before this feature existed).
        const RowIcon = stash && stash.state === "stored" ? STASH_ICON[stash.loc] : Icon;
        return (
          <div key={e.id} style={s.entry}>
            <div style={{ ...s.entryTap, cursor: "default" }}>
              <span style={{ ...s.entryIco, color: accent, background: `${accent}1a` }}>
                <RowIcon size={20} />
              </span>
              <div style={s.entryMid}>
                <div style={s.entryLabel}>
                  {e.amount} ml
                  {where ? <span style={s.entryMeta}> · {where}</span> : null}
                </div>
                <div style={s.entryTime}>{clockTime(e.startMs)}</div>
              </div>
              {fresh && <span style={{ ...s.entryTime, color: fresh.color, fontWeight: 700, whiteSpace: "nowrap" }}>{fresh.text}</span>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ── Inventory page ───────────────────────────────────────────────────────────
export function StashPage({ client, childId }: { client: BabyBuddyClient; childId: number | null }) {
  const { s, chipOn } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const now = useNow(60_000);
  const freshness = useFreshness();
  const { pumpings, refresh } = usePumpings(client, childId);
  const accent = palette.accents.pumping.accent;
  const [showFrozen, setShowFrozen] = useState(false);
  /**
   * Writes go through the outbox, so the next server fetch can still show the old note for a
   * moment. Overlay the changes we've queued on top — same idea as the running-timers view
   * merging its outbox state, so a tap never appears to do nothing.
   */
  const [pending, setPending] = useState<Record<number, StashInfo>>({});

  const bottles = useMemo(() => {
    const list = (pumpings ?? []).map(toBottle).filter((b): b is StashBottle => b != null);
    return list.map((b) => (pending[b.id] ? { ...b, stash: pending[b.id] } : b));
  }, [pumpings, pending]);

  const available = useMemo(
    () =>
      bottles
        .filter((b): b is StashBottle & { stash: StashInfo } => b.stash != null && isAvailable(b.stash, now))
        .sort((a, b) => expiresAt(a.stash) - expiresAt(b.stash)),
    [bottles, now],
  );
  const fresh = available.filter((b) => b.stash.loc !== "freezer");
  const frozen = available.filter((b) => b.stash.loc === "freezer");

  const apply = (bottle: StashBottle & { stash: StashInfo }, next: StashInfo) => {
    buzz();
    setPending((p) => ({ ...p, [bottle.id]: next }));
    void enqueueMutation(
      // `amount` rides along because the server requires it on every write to a pumping row,
      // PATCH included — sending only `notes` would be rejected.
      updateEntryMutation(bottle.id, { path: "/api/pumping/", body: { amount: bottle.amount, notes: encodeStashNotes(next) } }),
    ).then(() => refresh());
  };

  /** Identity line (icon · amount · where · when · freshness), then the actions on their own
   *  full-width row — inline chips would squeeze the reading line on a narrow phone. */
  const row = (b: StashBottle & { stash: StashInfo }) => {
    const f = freshness(b.stash, now);
    const LocIcon = STASH_ICON[b.stash.loc];
    // `s.entry` is a flex ROW (icon beside text) — stack it so the actions get their own
    // full-width line instead of being laid out as another column beside the icon.
    return (
      <div key={b.id} style={{ ...s.entry, flexDirection: "column", alignItems: "stretch", gap: 10 }}>
        <div style={{ ...s.entryTap, cursor: "default" }}>
          <span style={{ ...s.entryIco, color: accent, background: `${accent}1a` }}>
            <LocIcon size={20} />
          </span>
          <div style={s.entryMid}>
            <div style={s.entryLabel}>
              {b.amount} ml
              <span style={s.entryMeta}> · {t(`stash.loc.${b.stash.loc}`)}</span>
            </div>
            <div style={s.entryTime}>{clockTime(b.pumpedMs)}</div>
          </div>
          {/* Wraps rather than truncates — the expiry is the point of this screen. */}
          <span style={{ ...s.entryTime, color: f.color, fontWeight: 700, textAlign: "right" }}>{f.text}</span>
        </div>
        <div style={s.chips}>
          <button onClick={() => apply(b, { ...b.stash, state: "used" })} style={{ ...s.chip, ...chipOn(palette.ok) }}>
            {t("stash.markUsed")}
          </button>
          {b.stash.loc === "fridge" && (
            <button onClick={() => apply(b, moveStash(b.stash, "freezer", now))} style={s.chip}>
              {t("stash.moveToFreezer")}
            </button>
          )}
          {b.stash.loc === "freezer" && (
            <button onClick={() => apply(b, moveStash(b.stash, "thawed", now))} style={s.chip}>
              {t("stash.thaw")}
            </button>
          )}
          <button onClick={() => apply(b, { ...b.stash, state: "discarded" })} style={{ ...s.chip, color: palette.danger }}>
            {t("stash.discard")}
          </button>
        </div>
      </div>
    );
  };

  const totalMl = available.reduce((sum, b) => sum + b.amount, 0);
  return (
    <section style={s.cal}>
      <div style={s.sheetGroup}>{t("stash.total", { count: available.length, volume: volume(totalMl) })}</div>

      {available.length === 0 && <div style={s.empty}>{t("stash.empty")}</div>}
      {fresh.map(row)}

      {/* Frozen milk keeps for months, so it would bury the fridge — the part you actually
          choose from — under an ever-growing list. Collapsed to one line until asked for. */}
      {frozen.length > 0 && (
        <>
          <button onClick={() => { buzz(); setShowFrozen((v) => !v); }} style={{ ...s.chip, width: "100%", marginTop: 10 }}>
            {t("stash.freezerSummary", { count: frozen.length, volume: volume(frozen.reduce((sum, b) => sum + b.amount, 0)) })}
          </button>
          {showFrozen && frozen.map(row)}
        </>
      )}

      {/* Which table is in force, and the caveat both sources stress. */}
      <div style={{ ...s.sheetHint, marginTop: 18 }}>{t("stash.source")}</div>
    </section>
  );
}
