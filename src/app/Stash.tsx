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
  flushOutbox,
  updateEntryMutation,
  type BabyBuddyClient,
  type TimelineEntry,
} from "../api";
import { useStyles, useTheme } from "../theme";
import { ACTIVITY_ICON, FridgeIcon, SnowflakeIcon, ThawIcon, ThermometerIcon, type IconProps } from "../ui/icons";
import { clockTime, shortDateTime } from "../lib/datetime";
import {
  availableBottles,
  decodeStashNotes,
  encodeStashNotes,
  expiresAt,
  isExpired,
  isExpiringSoon,
  isSpent,
  moveStash,
  toBottle,
  type StashBottle,
  type StashInfo,
  type StashLocation,
  type TrackedBottle,
} from "../lib/stash";
import { buzz, usePumpings, useNow } from "./hooks";

/** A timeline entry already narrowed to pumping — what Calendar hands the day list. */
export type PumpingEntry = Extract<TimelineEntry, { activity: "pumping" }>;

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
    // Same rule that raises the Home warning, so a bottle flagged there is visibly flagged
    // here too — one predicate, not two that can drift apart.
    const color = isExpiringSoon(stash, now) ? palette.accents.feeding.accent : palette.textFaint;
    return { text: t("stash.expiresOn", { date: shortDateTime(at) }), color };
  };
}

// ── Day list (under the dial) ────────────────────────────────────────────────
/** `entries` arrives already narrowed to the day's pumping sessions (Calendar does the
 *  windowing), so this neither re-filters nor re-narrows. */
export function PumpDayList({ entries }: { entries: PumpingEntry[] }) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const now = useNow(60_000);
  const freshness = useFreshness();
  const accent = palette.accents.pumping.accent;
  const Icon = ACTIVITY_ICON.pumping;

  // Newest first, like every other list in the app (the journal, the timeline merge).
  const pumps = [...entries].sort((a, b) => b.startMs - a.startMs);
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
  const [showSpent, setShowSpent] = useState(false);
  /**
   * Writes go through the outbox, so the next server fetch can still show the old note for a
   * moment. Overlay the changes we've queued on top — same idea as the running-timers view
   * merging its outbox state, so a tap never appears to do nothing.
   *
   * The overlay RETIRES as soon as the server agrees. Left in place it would mask reality
   * forever: a write that dead-letters, or the other caregiver marking the same bottle used,
   * would keep showing our local guess — and for a moved bottle that means displaying a
   * fabricated expiry date for milk someone is going to feed a baby.
   */
  const [pending, setPending] = useState<Record<number, StashInfo>>({});

  const bottles = useMemo(() => {
    const raw = (pumpings ?? []).map(toBottle).filter((b): b is StashBottle => b != null);
    return raw.map((b) => {
      const want = pending[b.id];
      // The overlay applies only while the server still disagrees, so a fetch that has
      // caught up wins on its own without anything having to clear state.
      return want && b.notes !== encodeStashNotes(want) ? { ...b, stash: want } : b;
    });
  }, [pumpings, pending]);

  const available = useMemo(() => availableBottles(bottles, now), [bottles, now]);
  const fresh = available.filter((b) => b.stash.loc !== "freezer");
  const frozen = available.filter((b) => b.stash.loc === "freezer");
  /** Past its window but still kept — the bottle is physically in the fridge and needs
   *  binning, so hiding it is the one thing this screen must not do. */
  const expired = useMemo(
    () =>
      bottles
        .filter((b): b is TrackedBottle => b.stash != null && isExpired(b.stash, now))
        .sort((a, b) => expiresAt(a.stash) - expiresAt(b.stash)),
    [bottles, now],
  );
  /** Used or thrown away. Kept on screen — struck through — rather than deleted: the session
   *  happened, it counts toward supply, and a row that simply vanishes gives no way to tell
   *  a mis-tap from a real one. Newest first, since this is history. */
  const spent = useMemo(
    () =>
      bottles
        .filter((b): b is TrackedBottle => b.stash != null && isSpent(b.stash))
        .sort((a, b) => b.pumpedMs - a.pumpedMs),
    [bottles],
  );

  const apply = (bottle: TrackedBottle, next: StashInfo) => {
    buzz();
    setPending((p) => ({ ...p, [bottle.id]: next }));
    void enqueueMutation(
      // `amount` rides along because the server requires it on every write to a pumping row,
      // PATCH included — sending only `notes` would be rejected.
      updateEntryMutation(bottle.id, { path: "/api/pumping/", body: { amount: bottle.amount, notes: encodeStashNotes(next) } }),
    )
      // Push it now rather than waiting on the 45 s auto-flush: Background Sync is
      // unavailable on iOS, so `requestOutboxSync` returns false there and nothing else
      // would drain the queue while the user is still looking at the screen.
      .then(() => flushOutbox(client).catch(() => {}))
      .then(() => refresh())
      // Retire the overlay once the round-trip is done, whatever the outcome. If the write
      // landed the refetch already shows it; if it dead-lettered, the screen must fall back
      // to what the server actually holds rather than keep displaying a fabricated expiry.
      .finally(() =>
        setPending((p) => {
          if (!(bottle.id in p)) return p;
          const rest = { ...p };
          delete rest[bottle.id];
          return rest;
        }),
      );
  };

  /** Identity line (icon · amount · where · when · freshness), then the actions on their own
   *  full-width row — inline chips would squeeze the reading line on a narrow phone. */
  const row = (b: TrackedBottle) => {
    const f = freshness(b.stash, now);
    const lapsed = isExpired(b.stash, now);
    const gone = isSpent(b.stash);
    const LocIcon = STASH_ICON[b.stash.loc];
    // `s.entry` is a flex ROW (icon beside text) — stack it so the actions get their own
    // full-width line instead of being laid out as another column beside the icon.
    return (
      <div key={b.id} style={{ ...s.entry, flexDirection: "column", alignItems: "stretch", gap: 10, ...(gone ? { opacity: 0.55 } : {}) }}>
        <div style={{ ...s.entryTap, cursor: "default" }}>
          <span style={{ ...s.entryIco, color: accent, background: `${accent}1a` }}>
            <LocIcon size={20} />
          </span>
          <div style={s.entryMid}>
            {/* Struck through, not removed — the volume is still part of the day's total. */}
            <div style={{ ...s.entryLabel, ...(gone ? { textDecoration: "line-through" } : {}) }}>
              {b.amount} ml
              <span style={s.entryMeta}> · {t(gone ? `stash.${b.stash.state}` : `stash.loc.${b.stash.loc}`)}</span>
            </div>
            {/* Date, not just the clock: the freezer section holds bottles months apart, and
                two of them pumped at 09:52 would otherwise be indistinguishable. */}
            <div style={s.entryTime}>{shortDateTime(b.pumpedMs)}</div>
          </div>
          {/* Wraps rather than truncates — the expiry is the point of this screen. A spent
              bottle has no deadline left to report, and a countdown beside "used" would
              read as though it were still on offer. */}
          {!gone && <span style={{ ...s.entryTime, color: f.color, fontWeight: 700, textAlign: "right" }}>{f.text}</span>}
        </div>
        {/* Past its window there is exactly one honest action. Offering "used" or a move on
            lapsed milk would be the app endorsing feeding it. */}
        <div style={s.chips}>
          {/* Spent rows keep one action: undo. The bookkeeping tap is easy to mis-hit, and
              nothing else in the app can put the state back. `at` is untouched, so the
              expiry recomputes from when it really went in — a bottle restored too late
              reappears among the lapsed ones rather than looking fresh. */}
          {gone && (
            <button onClick={() => apply(b, { ...b.stash, state: "stored" })} style={s.chip}>
              {t("stash.restore")}
            </button>
          )}
          {!gone && !lapsed && (
            <>
              <button onClick={() => apply(b, { ...b.stash, state: "used" })} style={{ ...s.chip, ...chipOn(palette.ok) }}>
                {t("stash.markUsed")}
              </button>
              {/* One forward chain: room → fridge → freezer → thawed. Milk left out and then
                  put away is an ordinary move, and without this the only options for it were
                  "use" or "bin". Nothing offers a way back — refreezing and re-chilling
                  thawed milk are exactly what the guidance rules out. */}
              {b.stash.loc === "room" && (
                <button onClick={() => apply(b, moveStash(b.stash, "fridge", now))} style={s.chip}>
                  {t("stash.moveToFridge")}
                </button>
              )}
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
            </>
          )}
          {!gone && (
            <button onClick={() => apply(b, { ...b.stash, state: "discarded" })} style={{ ...s.chip, color: palette.danger }}>
              {t("stash.discard")}
            </button>
          )}
        </div>
      </div>
    );
  };

  const totalMl = available.reduce((sum, b) => sum + b.amount, 0);
  return (
    <section style={s.cal}>
      <div style={s.sheetGroup}>{t("stash.total", { count: available.length, volume: volume(totalMl) })}</div>

      {available.length === 0 && expired.length === 0 && spent.length === 0 && <div style={s.empty}>{t("stash.empty")}</div>}

      {/* Lapsed milk first, and loudly. It's still sitting in the fridge — dropping it off the
          list would leave the app's last word on it a reassuring countdown. */}
      {expired.length > 0 && (
        <>
          <div style={{ ...s.sheetGroup, color: palette.danger }}>
            {t("stash.expiredGroup", { count: expired.length, volume: volume(expired.reduce((sum, b) => sum + b.amount, 0)) })}
          </div>
          {expired.map(row)}
        </>
      )}

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

      {/* Used and dumped bottles, kept as history rather than deleted — collapsed so they
          don't bury the part of the list you actually choose from. */}
      {spent.length > 0 && (
        <>
          <button onClick={() => { buzz(); setShowSpent((v) => !v); }} style={{ ...s.chip, width: "100%", marginTop: 10 }}>
            {t("stash.spentSummary", { count: spent.length, volume: volume(spent.reduce((sum, b) => sum + b.amount, 0)) })}
          </button>
          {showSpent && spent.map(row)}
        </>
      )}

      {/* Which table is in force, and the caveat both sources stress. */}
      <div style={{ ...s.sheetHint, marginTop: 18 }}>{t("stash.source")}</div>
    </section>
  );
}
