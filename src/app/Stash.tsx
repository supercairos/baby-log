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
 * They render the SAME row and share the same writer, so a bottle looks and behaves
 * identically wherever you meet it — you can put the day's session in the freezer from the
 * dial page without going to the inventory first.
 *
 * Both read expiry rather than store it — see lib/stash.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  deleteEntryMutation,
  enqueueMutation,
  flushOutbox,
  updateEntryMutation,
  type BabyBuddyClient,
  type TimelineEntry,
} from "../api";
import { useStyles, useTheme } from "../theme";
import { ACTIVITY_ICON, FridgeIcon, SnowflakeIcon, ThawIcon, ThermometerIcon, type IconProps } from "../ui/icons";
import { shortDateTime } from "../lib/datetime";
import { stashWhereLabel } from "../lib/labels";
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

// ── Shared writer ────────────────────────────────────────────────────────────
/**
 * Every stash mutation, plus the optimistic overlay that keeps a tap from looking like it
 * did nothing. Shared by both views so the day list and the inventory can never drift on
 * how a change is written or when the optimistic state stands down.
 *
 * `refresh` is whatever re-reads the caller's own data (the stash query on the inventory,
 * the calendar range on the day list).
 */
function useStashWriter(client: BabyBuddyClient, refresh: () => Promise<unknown>, onWriteFailed: (err: unknown) => void) {
  /**
   * Queued location/state changes. The overlay RETIRES as soon as the server agrees. Left in
   * place it would mask reality: a write that dead-letters, or the other caregiver marking
   * the same bottle used, would keep showing our local guess — and for a moved bottle that
   * means displaying a fabricated expiry date for milk someone is going to feed a baby.
   */
  const [pending, setPending] = useState<Record<number, StashInfo>>({});
  /** Deleted here but not yet gone from the server's response. */
  const [removed, setRemoved] = useState<Set<number>>(new Set());

  const drop = (id: number) =>
    setPending((p) => {
      if (!(id in p)) return p;
      const rest = { ...p };
      delete rest[id];
      return rest;
    });

  /** Push the queue now rather than waiting on the 45 s auto-flush: Background Sync is
   *  unavailable on iOS, so `requestOutboxSync` returns false there and nothing else would
   *  drain it while the user is still looking at the screen. */
  const run = (id: number, enqueued: Promise<unknown>) =>
    enqueued
      .then(() => flushOutbox(client).catch(() => null))
      .then(async (summary) => {
        await refresh();
        // Retire the overlay only once the queue is actually clear. Offline, the write is
        // durably queued and `remaining` stays above zero — dropping the overlay there would
        // snap the row back, so the tap would look like it did nothing and the parent would
        // tap again, queuing a duplicate. That's the case the outbox exists to handle.
        if (!summary || summary.remaining > 0) return;
        drop(id);
      })
      .catch((err: unknown) => {
        // The ENQUEUE failed (IndexedDB unavailable / over quota): the write never became
        // durable and will never retry. Saying nothing would leave the row showing a change
        // that is never going to happen.
        drop(id);
        setRemoved((r) => {
          if (!r.has(id)) return r;
          const next = new Set(r);
          next.delete(id);
          return next;
        });
        onWriteFailed(err);
      });

  const apply = (bottle: StashBottle, next: StashInfo) => {
    buzz();
    setPending((p) => ({ ...p, [bottle.id]: next }));
    void run(
      bottle.id,
      // `amount` rides along because the server requires it on every write to a pumping row,
      // PATCH included — sending only `notes` would be rejected.
      enqueueMutation(updateEntryMutation(bottle.id, { path: "/api/pumping/", body: { amount: bottle.amount, notes: encodeStashNotes(next) } })),
    );
  };

  /** Remove the entry outright. Offered only on ARCHIVED bottles — a spent row is history,
   *  and this is how a mis-logged session finally goes away. */
  const remove = (bottle: StashBottle) => {
    buzz();
    setRemoved((r) => new Set(r).add(bottle.id));
    void run(bottle.id, enqueueMutation(deleteEntryMutation(bottle.id, "/api/pumping/")));
  };

  /** Fold the queued changes over a freshly fetched list. */
  const overlay = (raw: StashBottle[]): StashBottle[] =>
    raw
      .filter((b) => !removed.has(b.id))
      .map((b) => {
        const want = pending[b.id];
        // The overlay applies only while the server still disagrees, so a fetch that has
        // caught up wins on its own without anything having to clear state.
        return want && b.notes !== encodeStashNotes(want) ? { ...b, stash: want } : b;
      });

  return { apply, remove, overlay };
}

// ── Shared row ───────────────────────────────────────────────────────────────
/**
 * One bottle, wherever it appears. Identity line (icon · amount · where · when · freshness),
 * then the actions on their own full-width row — inline chips would squeeze the reading line
 * on a narrow phone.
 */
function StashRow({
  bottle,
  now,
  apply,
  remove,
}: {
  bottle: StashBottle;
  now: number;
  apply: (bottle: StashBottle, next: StashInfo) => void;
  remove: (bottle: StashBottle) => void;
}) {
  const { s, chipOn } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const freshness = useFreshness();
  const accent = palette.accents.pumping.accent;
  const stash = bottle.stash;

  // An entry with no stash prefix — written by Baby Buddy's own UI, or before this feature
  // existed. We don't know where it went, so it gets the pump glyph and no actions: the app
  // shouldn't invent a location, and it has nothing to reason about.
  const Icon = stash == null ? ACTIVITY_ICON.pumping : STASH_ICON[stash.loc];
  const gone = stash != null && isSpent(stash);
  const lapsed = stash != null && isExpired(stash, now);
  const f = stash != null && !gone ? freshness(stash, now) : null;

  return (
    <div style={{ ...s.entry, flexDirection: "column", alignItems: "stretch", gap: 14, padding: "16px 16px 14px", marginBottom: 12 }}>
      {/* Dim the IDENTITY line only, never the actions. Fading the whole row made the one
          control an archived bottle still has — restore — read as disabled. */}
      {/* Top-aligned, not centred: the left column is two lines and the right is one, so
          centring floated the expiry into the gap between them instead of sitting on the
          line it qualifies. It reads as a stray label, and worst on an expired row where
          the short "périmé" has nothing to line up against. */}
      <div style={{ ...s.entryTap, cursor: "default", gap: 14, alignItems: "flex-start", ...(gone ? { opacity: 0.55 } : {}) }}>
        <span style={{ ...s.entryIco, color: accent, background: `${accent}1a` }}>
          <Icon size={20} />
        </span>
        <div style={s.entryMid}>
          {/* Struck through, not removed — the volume is still part of the day's total.
              An explicit line-height, matched by the expiry opposite, so the two sit on the
              same line despite different font sizes — `entryLabel` otherwise inherits the
              serif's own metrics and the two drift apart. */}
          <div style={{ ...s.entryLabel, lineHeight: "20px", ...(gone ? { textDecoration: "line-through" } : {}) }}>
            {bottle.amount} ml
            {stash != null && <span style={s.entryMeta}> · {stashWhereLabel(stash)}</span>}
          </div>
          {/* Date, not just the clock: the freezer section holds bottles months apart, and
              two of them pumped at 09:52 would otherwise be indistinguishable. */}
          <div style={{ ...s.entryTime, marginTop: 2 }}>{shortDateTime(bottle.pumpedMs)}</div>
        </div>
        {/* A spent bottle has no deadline left to report, and a countdown beside "used"
            would read as though it were still on offer. */}
        {f && (
          <span style={{ ...s.entryTime, color: f.color, fontWeight: 700, textAlign: "right", lineHeight: "20px", flexShrink: 0 }}>
            {f.text}
          </span>
        )}
      </div>

      {stash != null && (
        <div style={s.chips}>
          {/* Archived rows keep undo — the bookkeeping tap is easy to mis-hit and nothing
              else in the app can put the state back. `at` is untouched, so the expiry
              recomputes from when it really went in: restore one too late and it reappears
              among the lapsed rather than looking fresh. */}
          {gone && (
            <>
              <button onClick={() => apply(bottle, { ...stash, state: "stored" })} style={s.chip}>
                {t("stash.restore")}
              </button>
              {/* The one place a pumping entry is really removed. Archived only: history is
                  kept by default, but a session logged in error has to be able to go. */}
              <button onClick={() => remove(bottle)} style={{ ...s.chip, color: palette.danger }}>
                {t("common.delete")}
              </button>
            </>
          )}
          {/* Past its window there is exactly one honest action. Offering "used" or a move on
              lapsed milk would be the app endorsing feeding it. */}
          {!gone && !lapsed && (
            <>
              <button onClick={() => apply(bottle, { ...stash, state: "used" })} style={{ ...s.chip, ...chipOn(palette.ok) }}>
                {t("stash.markUsed")}
              </button>
              {/* One forward chain: room → fridge → freezer → thawed. Milk left out and then
                  put away is an ordinary move. Nothing offers a way back — refreezing and
                  re-chilling thawed milk are exactly what the guidance rules out. */}
              {stash.loc === "room" && (
                <button onClick={() => apply(bottle, moveStash(stash, "fridge", now))} style={s.chip}>
                  {t("stash.moveToFridge")}
                </button>
              )}
              {stash.loc === "fridge" && (
                <button onClick={() => apply(bottle, moveStash(stash, "freezer", now))} style={s.chip}>
                  {t("stash.moveToFreezer")}
                </button>
              )}
              {stash.loc === "freezer" && (
                <button onClick={() => apply(bottle, moveStash(stash, "thawed", now))} style={s.chip}>
                  {t("stash.thaw")}
                </button>
              )}
            </>
          )}
          {!gone && (
            <button onClick={() => apply(bottle, { ...stash, state: "discarded" })} style={{ ...s.chip, color: palette.danger }}>
              {t("stash.discard")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Day list (under the dial) ────────────────────────────────────────────────
/** `entries` arrives already narrowed to the day's pumping sessions (Calendar does the
 *  windowing), so this neither re-filters nor re-narrows. */
export function PumpDayList({
  client,
  entries,
  onWriteFailed,
}: {
  client: BabyBuddyClient;
  entries: PumpingEntry[];
  onWriteFailed: (err: unknown) => void;
}) {
  const { s } = useStyles();
  const { t } = useTranslation();
  const now = useNow(60_000);
  const qc = useQueryClient();
  // The day list is fed by the calendar's range query, so that's what has to re-read after a
  // write; the inventory's own query is invalidated too, since both show the same bottle.
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["calendar"] }), qc.invalidateQueries({ queryKey: ["pumpings"] })]);
  const { apply, remove, overlay } = useStashWriter(client, refresh, onWriteFailed);

  // Newest first, like every other list in the app (the journal, the timeline merge).
  const bottles = overlay(
    [...entries]
      .sort((a, b) => b.startMs - a.startMs)
      .map((e) => ({
        id: e.id,
        amount: e.amount,
        pumpedMs: e.endMs ?? e.startMs,
        stash: decodeStashNotes(e.notes),
        notes: e.notes,
      })),
  );
  if (bottles.length === 0) return null;

  const total = bottles.reduce((sum, b) => sum + b.amount, 0);
  return (
    <section style={{ marginTop: 22 }}>
      <div style={s.sheetGroup}>
        {t("stash.dayTitle")} · {t("stash.total", { count: bottles.length, volume: volume(total) })}
      </div>
      {bottles.map((b) => (
        <StashRow key={b.id} bottle={b} now={now} apply={apply} remove={remove} />
      ))}
    </section>
  );
}

// ── Inventory page ───────────────────────────────────────────────────────────
export function StashPage({
  client,
  childId,
  onWriteFailed,
}: {
  client: BabyBuddyClient;
  childId: number | null;
  /** Surface a non-durable write the way Home's `submit` does — this page has no toast of
   *  its own, and a silently dropped change is worse here than anywhere else. */
  onWriteFailed: (err: unknown) => void;
}) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const now = useNow(60_000);
  const { pumpings, refresh } = usePumpings(client, childId);
  const [showFrozen, setShowFrozen] = useState(false);
  const [showSpent, setShowSpent] = useState(false);
  const { apply, remove, overlay } = useStashWriter(client, refresh, onWriteFailed);

  const bottles = useMemo(
    () => overlay((pumpings ?? []).map(toBottle).filter((b): b is StashBottle => b != null)),
    [pumpings, overlay],
  );

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
  /** Used or thrown away. Kept on screen — struck through — rather than auto-deleted: the
   *  session happened, it counts toward supply, and a row that simply vanishes gives no way
   *  to tell a mis-tap from a real one. Newest first, since this is history. */
  const spent = useMemo(
    () =>
      bottles
        .filter((b): b is TrackedBottle => b.stash != null && isSpent(b.stash))
        .sort((a, b) => b.pumpedMs - a.pumpedMs),
    [bottles],
  );

  const totalMl = available.reduce((sum, b) => sum + b.amount, 0);
  const rows = (list: StashBottle[]) =>
    list.map((b) => <StashRow key={b.id} bottle={b} now={now} apply={apply} remove={remove} />);

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
          {rows(expired)}
        </>
      )}

      {rows(fresh)}

      {/* Frozen milk keeps for months, so it would bury the fridge — the part you actually
          choose from — under an ever-growing list. Collapsed to one line until asked for. */}
      {frozen.length > 0 && (
        <>
          <button onClick={() => { buzz(); setShowFrozen((v) => !v); }} style={{ ...s.chip, width: "100%", margin: "14px 0 12px" }}>
            {t("stash.freezerSummary", { count: frozen.length, volume: volume(frozen.reduce((sum, b) => sum + b.amount, 0)) })}
          </button>
          {showFrozen && rows(frozen)}
        </>
      )}

      {/* Used and dumped bottles, kept as history rather than deleted — collapsed so they
          don't bury the part of the list you actually choose from. */}
      {spent.length > 0 && (
        <>
          <button onClick={() => { buzz(); setShowSpent((v) => !v); }} style={{ ...s.chip, width: "100%", margin: "14px 0 12px" }}>
            {t("stash.spentSummary", { count: spent.length, volume: volume(spent.reduce((sum, b) => sum + b.amount, 0)) })}
          </button>
          {showSpent && rows(spent)}
        </>
      )}

      {/* Which table is in force, and the caveat both sources stress. */}
      <div style={{ ...s.sheetHint, marginTop: 18 }}>{t("stash.source")}</div>
    </section>
  );
}
