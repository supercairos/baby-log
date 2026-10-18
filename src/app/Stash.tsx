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
import { useEffect, useMemo, useRef, useState } from "react";
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
import { ACTIVITY_ICON, CheckIcon, FridgeIcon, SnowflakeIcon, ThawIcon, ThermometerIcon, TrashIcon, type IconProps } from "../ui/icons";
import { shortDateTime } from "../lib/datetime";
import { fromLocalInput, toLocalInput } from "../lib/format";
import { stashWhereLabel } from "../lib/labels";
import {
  availableBottles,
  bottleKey,
  canBag,
  decodeStashNotes,
  encodeStashNotes,
  expiresAt,
  groupBags,
  isExpired,
  isExpiringSoon,
  isSpent,
  splitPortions,
  supplySummary,
  moveStash,
  STASH_LOCATIONS,
  toBottle,
  type StashBottle,
  type StashInfo,
  type StashLocation,
  type StashState,
  type TrackedBottle,
} from "../lib/stash";
import { buzz, scrollFieldIntoView, usePumpings, useNow } from "./hooks";
import { SheetShell } from "./sheets";

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

/** Milk still on offer (inventory, freezer, expired) runs oldest pumped first: the oldest
 *  bottle is the one to reach for. Logs — the history and the day's sessions — run newest
 *  first instead, like the journal: there you're looking for what just happened. */
const byPumped = (a: StashBottle, b: StashBottle) => a.pumpedMs - b.pumpedMs;
const byPumpedDesc = (a: StashBottle, b: StashBottle) => b.pumpedMs - a.pumpedMs;

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
/** The volume of the whole session a container belongs to — what the server's row holds. */
const sessionAmount = (b: StashBottle) => b.sessionAmount ?? b.amount;

function useStashWriter(client: BabyBuddyClient, refresh: () => Promise<unknown>, onWriteFailed: (err: unknown) => void) {
  /**
   * Queued location/state changes. The overlay RETIRES as soon as the server agrees. Left in
   * place it would mask reality: a write that dead-letters, or the other caregiver marking
   * the same bottle used, would keep showing our local guess — and for a moved bottle that
   * means displaying a fabricated expiry date for milk someone is going to feed a baby.
   */
  const [pending, setPending] = useState<Record<number, StashInfo>>({});
  /** The same, readable mid-tap: one action can write several containers of ONE session (its
   *  rest and a portion poured off it), and each write has to build on the one before. */
  const latest = useRef<Record<number, StashInfo>>({});
  /** Deleted here but not yet gone from the server's response. */
  const [removed, setRemoved] = useState<Set<number>>(new Set());

  const drop = (id: number) => {
    delete latest.current[id];
    setPending((p) => {
      if (!(id in p)) return p;
      const rest = { ...p };
      delete rest[id];
      return rest;
    });
  };

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

  /** Rewrite one session's whole stash record. `bottle` is any container of it — the
   *  session itself or a portion poured off it; the note always carries all of them. */
  const edit = (bottle: StashBottle, change: (entry: StashInfo) => StashInfo) => {
    const base = latest.current[bottle.id] ?? bottle.entry ?? bottle.stash;
    if (base == null) return;
    const next = change(base);
    latest.current[bottle.id] = next;
    setPending((p) => ({ ...p, [bottle.id]: next }));
    void run(
      bottle.id,
      // `amount` rides along because the server requires it on every write to a pumping row,
      // PATCH included — sending only `notes` would be rejected. It's the SESSION's amount:
      // a portion's volume lives in the note.
      enqueueMutation(updateEntryMutation(bottle.id, { path: "/api/pumping/", body: { amount: sessionAmount(bottle), notes: encodeStashNotes(next) } })),
    );
  };

  /** Give one container a new location/state. Only those travel: the human note, the pumping
   *  time, a portion's volume and the other containers of the session stay as they are. */
  const write = (bottle: StashBottle, next: StashInfo) => {
    const where = { loc: next.loc, at: next.at, state: next.state, bag: next.bag };
    edit(bottle, (entry) =>
      bottle.part == null
        ? { ...entry, ...where }
        : { ...entry, portions: entry.portions?.map((p, i) => (i === bottle.part ? { ...p, ...where } : p)) },
    );
  };

  /** A bag writes through to each session in it. */
  const apply = (bottle: StashBottle, next: StashInfo) => {
    buzz();
    for (const m of bottle.members ?? [bottle]) write(m, next);
  };

  /** Pour fridge bottles — each whole or only part of it — into one and freeze it. A partial
   *  pour leaves the rest in the fridge, where it was: a new portion takes the poured volume
   *  (see lib/stash). The freezer window runs from the oldest milk's pumping. */
  const bagIt = (picks: { bottle: TrackedBottle; ml: number }[], now: number) => {
    buzz();
    const bag = now;
    for (const { bottle, ml } of picks) {
      for (const m of (bottle.members as TrackedBottle[] | undefined) ?? [bottle]) {
        if (bottle.members != null || ml >= m.amount) {
          write(m, { ...moveStash(m.stash, "freezer", now), bag });
          continue;
        }
        const poured: StashInfo = { ...moveStash(m.stash, "freezer", now), bag, ml, note: "", portions: undefined };
        edit(m, (entry) => ({
          ...entry,
          // Pouring from a portion takes the volume from that portion, not from the session.
          portions: [...(entry.portions ?? []).map((p, i) => (i === m.part ? { ...p, ml: (p.ml ?? 0) - ml } : p)), poured],
        }));
      }
    }
  };

  /** Undo a mis-tapped bag: back to the fridge, the clock from when each was pumped — what
   *  a fridge bottle has unless someone moved it there later, and never later than that. A
   *  poured-off portion goes back into the rest of its bottle while that's still in the
   *  fridge, so the session reads as one bottle again. */
  const unbag = (bottle: StashBottle) => {
    buzz();
    // Highest portion first, so merging one back can't shift the index of the next.
    for (const m of [...(bottle.members ?? [bottle])].sort((a, b) => (b.part ?? -1) - (a.part ?? -1))) {
      if (m.stash == null) continue;
      const back = { bag: undefined, loc: "fridge" as const, at: m.pumpedMs };
      if (m.part == null) {
        write(m, { ...m.stash, ...back });
        continue;
      }
      edit(m, (entry) =>
        entry.state === "stored" && entry.loc === "fridge" && entry.bag == null
          ? { ...entry, portions: entry.portions?.filter((_, i) => i !== m.part) }
          : { ...entry, portions: entry.portions?.map((p, i) => (i === m.part ? { ...p, ...back } : p)) },
      );
    }
  };

  /** Remove the entry outright. Offered only on ARCHIVED bottles — a spent row is history,
   *  and this is how a mis-logged session finally goes away. */
  const remove = (bottle: StashBottle) => {
    buzz();
    setRemoved((r) => new Set(r).add(bottle.id));
    void run(bottle.id, enqueueMutation(deleteEntryMutation(bottle.id, "/api/pumping/")));
  };

  /** Fold the queued changes over a freshly fetched list — one item per SESSION; split it
   *  into containers afterwards. */
  const overlay = (raw: StashBottle[]): StashBottle[] =>
    raw
      .filter((b) => !removed.has(b.id))
      .map((b) => {
        const want = pending[b.id];
        // The overlay applies only while the server still disagrees, so a fetch that has
        // caught up wins on its own without anything having to clear state.
        return want && b.notes !== encodeStashNotes(want) ? { ...b, stash: want } : b;
      });

  return { apply, bagIt, unbag, remove, overlay };
}

/** What the pour slider stops on: every 5 ml, and the whole bottle at the top even when its
 *  volume isn't a round number. */
function pourSteps(amount: number): number[] {
  const steps: number[] = [];
  for (let ml = 5; ml < amount; ml += 5) steps.push(ml);
  return [...steps, amount];
}
const pourIdx = (amount: number, ml: number) => {
  const steps = pourSteps(amount);
  const i = steps.findIndex((v) => v >= ml);
  return i < 0 ? steps.length - 1 : i;
};

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
  unbag,
  onRestate,
  select,
}: {
  bottle: StashBottle;
  now: number;
  apply: (bottle: StashBottle, next: StashInfo) => void;
  remove: (bottle: StashBottle) => void;
  unbag: (bottle: StashBottle) => void;
  /** Open the state sheet on this bottle — see `StashStateSheet`. */
  onRestate: (bottle: TrackedBottle) => void;
  /** Picking bottles for a bag: the row becomes one checkbox and its actions step aside.
   *  `pour` is how much of it goes in — all of it unless the slider says otherwise. */
  select?: { checked: boolean; onToggle: () => void; pour: number; onPour: (ml: number) => void };
}) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const freshness = useFreshness();
  const accent = palette.accents.pumping.accent;
  const stash = bottle.stash;

  // An entry with no stash prefix — written by Baby Buddy's own UI, or before this feature
  // existed. We don't know where it went, so it gets the pump glyph and no actions: the app
  // shouldn't invent a location, and it has nothing to reason about.
  const gone = stash != null && isSpent(stash);
  const lapsed = stash != null && isExpired(stash, now);
  const f = stash != null && !gone ? freshness(stash, now) : null;
  // The state is the first thing to read off a bottle, so the glyph and its label carry it
  // in colour as well as words: where it's kept while it's on offer, then a check or a bin
  // once it's spent. Each location has its own colour as well as its own glyph, so a
  // fridge bottle and a freezer one never read alike. Lapsed milk keeps its location glyph
  // (it IS still in the fridge) but turns red, so it can't pass for a usable bottle.
  const Icon =
    stash == null ? ACTIVITY_ICON.pumping : stash.state === "used" ? CheckIcon : stash.state === "discarded" ? TrashIcon : STASH_ICON[stash.loc];
  const tone =
    stash == null ? accent : stash.state === "used" ? palette.ok : stash.state === "discarded" || lapsed ? palette.danger : palette.stashLoc[stash.loc];
  // Dim the amount and date of an archived bottle, never its state — the label is what says
  // why it's archived — nor the actions: fading those made restore read as disabled.
  const dim = gone ? { opacity: 0.55 } : {};
  // A bagged session met on its own — the day list only sees that day's sessions, and a
  // night's bag often spans midnight. Writing to it alone would split it from its bag, so
  // it's read-only here; the inventory shows and handles the whole bag.
  const bagged = stash?.bag != null;
  const readOnly = bagged && bottle.members == null;
  const where = stashWhereLabel(stash);
  const sessions = bottle.members != null && bottle.members.length > 1 ? bottle.members : null;
  const pick = palette.stashLoc.freezer;
  const frozenLabel =
    stash?.loc === "freezer"
      ? t("stash.frozenLabel", { pumped: shortDateTime(stash.pumpedAt ?? bottle.pumpedMs), frozen: shortDateTime(stash.at) })
      : null;

  return (
    <div
      {...(select ? { role: "checkbox", "aria-checked": select.checked, tabIndex: 0, onClick: select.onToggle } : {})}
      style={{
        ...s.entry,
        flexDirection: "column",
        alignItems: "stretch",
        gap: 14,
        padding: "16px 16px 14px",
        marginBottom: 12,
        ...(select ? { cursor: "pointer", boxShadow: select.checked ? `inset 0 0 0 2px ${pick}` : undefined } : {}),
      }}
    >
      {/* Top-aligned, not centred: the left column is two lines and the right is one, so
          centring floated the expiry into the gap between them instead of sitting on the
          line it qualifies. It reads as a stray label, and worst on an expired row where
          the short "périmé" has nothing to line up against. */}
      <div style={{ ...s.entryTap, cursor: "default", gap: 14, alignItems: "flex-start" }}>
        {select ? (
          <span style={{ ...s.entryIco, color: select.checked ? palette.onAccent : pick, background: select.checked ? pick : `${pick}1f`, boxShadow: `inset 0 0 0 1px ${pick}55` }}>
            {select.checked && <CheckIcon size={20} />}
          </span>
        ) : (
          <span style={{ ...s.entryIco, color: tone, background: `${tone}1f`, boxShadow: `inset 0 0 0 1px ${tone}55` }}>
            <Icon size={20} />
          </span>
        )}
        <div style={s.entryMid}>
          {/* Struck through, not removed — the volume is still part of the day's total.
              An explicit line-height, matched by the expiry opposite, so the two sit on the
              same line despite different font sizes — `entryLabel` otherwise inherits the
              serif's own metrics and the two drift apart. */}
          <div style={{ ...s.entryLabel, lineHeight: "20px", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span style={{ ...dim, ...(gone ? { textDecoration: "line-through" } : {}) }}>{bottle.amount} ml</span>
            {where != null && (
              <span style={{ ...s.entryMeta, fontWeight: 800, color: tone }}>{bagged ? t("stash.inBag", { where }) : where}</span>
            )}
          </div>
          {/* Date, not just the clock: the freezer section holds bottles months apart, and
              two of them pumped at 09:52 would otherwise be indistinguishable. */}
          {/* A combined bottle lists every session in it — what went in, and when. */}
          {(sessions || !frozenLabel) && (
            <div style={{ ...s.entryTime, marginTop: 2, ...dim }}>
              {sessions ? sessions.map((m) => `${m.amount} ml · ${shortDateTime(m.pumpedMs)}`).join(" + ") : shortDateTime(bottle.pumpedMs)}
            </div>
          )}
          {/* What the crèche wants written on a frozen bottle: when it was pumped (the first
              session, for a combined one) and when it went into the freezer. Worded to be
              copied onto the label as is. */}
          {frozenLabel && <div style={{ ...s.entryTime, marginTop: 2, ...dim }}>{frozenLabel}</div>}
        </div>
        {/* A spent bottle has no deadline left to report, and a countdown beside "used"
            would read as though it were still on offer. */}
        {f && (
          <span style={{ ...s.entryTime, color: f.color, fontWeight: 700, textAlign: "right", lineHeight: "20px", flexShrink: 0 }}>
            {f.text}
          </span>
        )}
      </div>

      {/* How much of a ticked bottle goes in — often not all of it: the rest stays in the
          fridge for the next feed. Its own taps mustn't untick the row it sits in. */}
      {select?.checked && pourSteps(bottle.amount).length > 1 && (
        <div style={s.sliderRow} onClick={(e) => e.stopPropagation()}>
          <input
            type="range"
            min={0}
            max={pourSteps(bottle.amount).length - 1}
            step={1}
            value={pourIdx(bottle.amount, select.pour)}
            aria-label={t("stash.pourAmount")}
            aria-valuetext={`${select.pour} ml`}
            onChange={(e) => select.onPour(pourSteps(bottle.amount)[Number(e.target.value)])}
            style={{ ...s.slider, accentColor: pick }}
          />
          <span style={{ ...s.sliderValue, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            {select.pour} ml
            {select.pour < bottle.amount && (
              <span style={{ ...s.entryTime, fontSize: 12, fontFamily: palette.body }}>{t("stash.pourRest", { volume: volume(bottle.amount - select.pour) })}</span>
            )}
          </span>
        </div>
      )}

      {stash != null && !readOnly && !select && (
        <div style={s.chips}>
          {/* Archived and lapsed rows get the state sheet rather than chips. Archived: the
              bookkeeping tap is easy to mis-hit and nothing else in the app can put the
              state back. Lapsed: the record itself may be wrong — a freeze logged late —
              and only a backdated move can say so (see `StashStateSheet`). */}
          {(gone || lapsed) && (
            <button onClick={() => { buzz(); onRestate({ ...bottle, stash }); }} style={s.chip}>
              {t("stash.restate")}
            </button>
          )}
          {/* The one place a pumping entry is really removed. Archived only: history is kept
              by default, but a session logged in error has to be able to go. Not on a bag —
              that would take several sessions with it in one tap — nor on a session split
              across containers, which would take the others with it. */}
          {gone && bottle.members == null && bottle.part == null && !stash.portions?.length && (
            <button onClick={() => remove(bottle)} style={{ ...s.chip, color: palette.danger }}>
              {t("common.delete")}
            </button>
          )}
          {/* Past its window there is exactly one honest action ON THE MILK. Offering "used"
              or a move on lapsed milk would be the app endorsing feeding it. */}
          {!gone && !lapsed && (
            <>
              {/* Secondary like its neighbours — a filled chip read as the row's current state
                  rather than an action. Green text keeps it findable, as red does for discard. */}
              <button onClick={() => apply(bottle, { ...stash, state: "used" })} style={{ ...s.chip, color: palette.ok }}>
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
              {/* Plain like its neighbours, even near the fridge deadline: a lit chip read as the
                  bottle's state ("frozen") rather than as an action. The expiry date already
                  turns amber when it's close. */}
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
              {/* Undo for a mis-tapped bag — see `unbag`. */}
              {bagged && stash.loc === "freezer" && (
                <button onClick={() => unbag(bottle)} style={s.chip}>
                  {t("stash.unbag")}
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

// ── Bottle-state sheet ───────────────────────────────────────────────────────
/**
 * Re-state a bottle: where it is (or that it's used / thrown away), and since when. The
 * row's chips are the fast path for what's happening NOW — a move stamps the clock, "used"
 * is one tap — while here the parent asserts what really happened, so every state is on
 * offer and the time can be backdated. Two cases need exactly that:
 *  · an archived bottle that was a mis-tap: pick the state it was in, and `at` is kept as it
 *    was, so one put back too late reappears among the lapsed rather than looking fresh;
 *  · a freeze logged late: a bottle the app shows lapsed in the fridge really went into the
 *    freezer the day before, and only a move dated BEFORE the fridge window ran out can say
 *    so. A move dated after it is refused (red readout, CTA off): that would be the app
 *    re-labelling lapsed milk as good for four months.
 * Dismissing the sheet changes nothing.
 */
type StateDraft = { loc: StashLocation; state: StashState; at: number };

function StashStateForm({ bottle, now, onApply }: { bottle: TrackedBottle; now: number; onApply: (next: StashInfo) => void }) {
  const { s, chipOn } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const freshness = useFreshness();
  const stash = bottle.stash;
  const [draft, setDraft] = useState<StateDraft>({ loc: stash.loc, state: stash.state, at: stash.at });

  // Back to the location it was in keeps its clock — the mis-tap undo; any other one is a
  // move, stamped now and backdatable below.
  const pickLoc = (loc: StashLocation) => {
    buzz();
    setDraft({ loc, state: "stored", at: loc === stash.loc ? stash.at : now });
  };
  const pickState = (state: StashState) => {
    buzz();
    setDraft((d) => ({ ...d, state }));
  };

  const next: StashInfo = { ...stash, loc: draft.loc, state: draft.state, at: draft.at };
  const stored = draft.state === "stored";
  // Dated after the bottle's previous window ran out, a move would re-label lapsed milk.
  const tooLate = stored && draft.loc !== stash.loc && draft.at > expiresAt(stash);
  const f = stored ? freshness(next, now) : null;
  const tone = !stored ? (draft.state === "used" ? palette.ok : palette.danger) : palette.stashLoc[draft.loc];
  // The picker's minute resolution can't say "09:52:30": a time typed as the pumping minute
  // must still pass as "not before it was pumped".
  const floor = bottle.pumpedMs - (bottle.pumpedMs % 60_000);

  return (
    <>
      <div style={s.sheetHint}>
        {bottle.amount} ml · {t("stash.pumpedOn", { date: shortDateTime(bottle.pumpedMs) })}
      </div>

      <div style={s.sheetGroup}>{t("sheet.storeIn")}</div>
      <div style={s.chips}>
        {STASH_LOCATIONS.map((loc) => {
          const on = stored && draft.loc === loc;
          return (
            <button key={loc} aria-pressed={on} onClick={() => pickLoc(loc)} style={{ ...s.chip, ...(on ? chipOn(palette.stashLoc[loc]) : {}) }}>
              {t(`stash.loc.${loc}`)}
            </button>
          );
        })}
        <button
          aria-pressed={draft.state === "used"}
          onClick={() => pickState("used")}
          style={{ ...s.chip, color: palette.ok, ...(draft.state === "used" ? chipOn(palette.ok) : {}) }}
        >
          {t("stash.markUsed")}
        </button>
        <button
          aria-pressed={draft.state === "discarded"}
          onClick={() => pickState("discarded")}
          style={{ ...s.chip, color: palette.danger, ...(draft.state === "discarded" ? chipOn(palette.danger) : {}) }}
        >
          {t("stash.discard")}
        </button>
      </div>

      {/* Only a stored bottle has a clock. Never before it was pumped, never in the future:
          `min`/`max` hold the picker's steppers and the handler re-checks typed input. */}
      {stored && f && (
        <>
          <div style={s.sheetGroup}>{t("stash.since")}</div>
          <input
            type="datetime-local"
            value={toLocalInput(draft.at)}
            min={toLocalInput(floor)}
            max={toLocalInput(now)}
            aria-label={t("stash.since")}
            aria-invalid={tooLate}
            onChange={(e) => {
              const ms = fromLocalInput(e.target.value);
              if (Number.isNaN(ms) || ms > now || ms < floor) return;
              setDraft((d) => ({ ...d, at: ms }));
            }}
            onFocus={scrollFieldIntoView}
            style={s.timeInput}
          />
          {/* What the choice means for the milk — the deadline it would get, or why it can't. */}
          <div role="status" aria-live="polite" style={{ ...s.durReadout, ...(tooLate ? s.durBad : { color: f.color }) }}>
            {tooLate ? t("stash.lapsedBefore") : f.text}
          </div>
        </>
      )}

      <button
        onClick={() => {
          if (tooLate) return;
          onApply(next);
        }}
        disabled={tooLate}
        style={{ ...s.cta, ...(tooLate ? s.ctaOff : { background: tone }) }}
      >
        {t("sheet.saveChanges")}
      </button>
    </>
  );
}

/** Scrim + sheet chrome around the form, hosted by whichever view the row was tapped in. */
function StashStateSheet({
  bottle,
  now,
  onApply,
  onClose,
}: {
  /** The bottle being re-stated, or null when closed. A snapshot taken at the tap — the
   *  views re-render on every clock tick, and the draft must not reset under the parent. */
  bottle: TrackedBottle | null;
  now: number;
  onApply: (bottle: TrackedBottle, next: StashInfo) => void;
  onClose: () => void;
}) {
  const { s } = useStyles();
  const { t } = useTranslation();
  const open = bottle != null;
  // The last bottle stays rendered while the sheet slides out, and each tap remounts the
  // form (`n` is its key) so a bottle reopened later starts from its current state rather
  // than the previous draft.
  const [shown, setShown] = useState<{ bottle: TrackedBottle; n: number } | null>(null);
  // Derived from the prop during render (React's "information from previous renders"), so
  // the form is up to date on the very render the sheet starts sliding in.
  if (bottle != null && bottle !== shown?.bottle) setShown({ bottle, n: (shown?.n ?? 0) + 1 });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {open && <button tabIndex={-1} style={{ ...s.scrim, cursor: "default" }} onClick={onClose} aria-label={t("home.close")} />}
      <SheetShell open={open} label={t("stash.restateTitle")}>
        <div style={s.sheetHandle} />
        <div style={s.sheetTitle}>{t("stash.restateTitle")}</div>
        {shown && <StashStateForm key={shown.n} bottle={shown.bottle} now={now} onApply={(next) => onApply(shown.bottle, next)} />}
      </SheetShell>
    </>
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
  const { apply, unbag, remove, overlay } = useStashWriter(client, refresh, onWriteFailed);
  const [restating, setRestating] = useState<TrackedBottle | null>(null);

  // Newest first: this is the day's log, not the inventory (see `byPumped`).
  const sessions = overlay(
    [...entries]
      .sort((a, b) => b.startMs - a.startMs)
      .map((e) => {
        const pumpedMs = e.endMs ?? e.startMs;
        return { id: e.id, amount: e.amount, pumpedMs, stash: decodeStashNotes(e.notes, pumpedMs), notes: e.notes };
      }),
  );
  if (sessions.length === 0) return null;
  // One row per container: a session partly poured into a combined bottle shows its rest
  // and the poured portion apart, since they're now kept in different places.
  const bottles = splitPortions(sessions);

  const total = sessions.reduce((sum, b) => sum + b.amount, 0);
  return (
    <section style={{ marginTop: 22 }}>
      <div style={s.sheetGroup}>
        {t("stash.dayTitle")} · {t("stash.total", { count: sessions.length, volume: volume(total) })}
      </div>
      {bottles.map((b) => (
        <StashRow key={bottleKey(b)} bottle={b} now={now} apply={apply} unbag={unbag} remove={remove} onRestate={setRestating} />
      ))}
      <StashStateSheet bottle={restating} now={now} onApply={(b, next) => { apply(b, next); setRestating(null); }} onClose={() => setRestating(null)} />
    </section>
  );
}

// ── Supply summary ───────────────────────────────────────────────────────────
/** Today against the recent daily average, side by side — see `supplySummary`. */
function SupplySummary({ bottles, now }: { bottles: StashBottle[]; now: number }) {
  const { s } = useStyles();
  const { palette } = useTheme();
  const { t } = useTranslation();
  const sum = useMemo(() => supplySummary(bottles, now), [bottles, now]);
  const accent = palette.accents.pumping.accent;

  const cell = (label: string, value: string, sub: string | null) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ ...s.entryTime, fontSize: 12.5 }}>{label}</div>
      <div style={{ fontFamily: palette.serif, fontSize: 24, fontWeight: 600, color: accent, lineHeight: 1.2, marginTop: 3 }}>{value}</div>
      {sub && <div style={{ ...s.entryTime, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ ...s.entry, gap: 16, padding: "14px 16px", marginBottom: 6, alignItems: "flex-start" }}>
      {cell(t("stash.supplyToday"), volume(sum.todayMl), t("stash.supplySessions", { count: sum.todayCount }))}
      {sum.avgMl != null && cell(t("stash.supplyAvg", { count: sum.avgDays }), t("stash.perDay", { volume: volume(sum.avgMl) }), null)}
    </div>
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
  /** Bottles picked for a bag (by `bottleKey`), or null when not bagging. */
  const [bagging, setBagging] = useState<Set<string> | null>(null);
  /** How much of each picked bottle goes in, when not all of it. */
  const [pours, setPours] = useState<Record<string, number>>({});
  const [restating, setRestating] = useState<TrackedBottle | null>(null);
  const { apply, bagIt, unbag, remove, overlay } = useStashWriter(client, refresh, onWriteFailed);

  /** One per session — supply counts what was expressed, so it reads these. */
  const bottles = useMemo(
    () => overlay((pumpings ?? []).map(toBottle).filter((b): b is StashBottle => b != null)),
    [pumpings, overlay],
  );
  /** One per physical container — every list below reads these. */
  const items = useMemo(() => groupBags(bottles), [bottles]);

  const available = useMemo(() => availableBottles(items, now).sort(byPumped), [items, now]);
  const baggable = available.filter((b) => canBag(b, now));
  const picked = bagging == null ? [] : baggable.filter((b) => bagging.has(bottleKey(b)));
  const pourOf = (b: StashBottle) => Math.min(pours[bottleKey(b)] ?? b.amount, b.amount);
  const pickedMl = picked.reduce((sum, b) => sum + pourOf(b), 0);
  const fresh = available.filter((b) => b.stash.loc !== "freezer");
  const frozen = available.filter((b) => b.stash.loc === "freezer");
  /** Past its window but still kept — the bottle is physically in the fridge and needs
   *  binning, so hiding it is the one thing this screen must not do. */
  const expired = useMemo(
    () =>
      items
        .filter((b): b is TrackedBottle => b.stash != null && isExpired(b.stash, now))
        .sort(byPumped),
    [items, now],
  );
  /** Used or thrown away. Kept on screen — struck through — rather than auto-deleted: the
   *  session happened, it counts toward supply, and a row that simply vanishes gives no way
   *  to tell a mis-tap from a real one. */
  const spent = useMemo(
    () =>
      items
        .filter((b): b is TrackedBottle => b.stash != null && isSpent(b.stash))
        .sort(byPumpedDesc),
    [items],
  );

  const totalMl = available.reduce((sum, b) => sum + b.amount, 0);
  const toggle = (id: string) => {
    buzz();
    setBagging((sel) => {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const rows = (list: StashBottle[]) =>
    list.map((b) => (
      <StashRow
        key={bottleKey(b)}
        bottle={b}
        now={now}
        apply={apply}
        unbag={unbag}
        remove={remove}
        onRestate={setRestating}
        select={
          bagging != null && canBag(b, now)
            ? {
                checked: bagging.has(bottleKey(b)),
                onToggle: () => toggle(bottleKey(b)),
                pour: pourOf(b),
                onPour: (ml) => setPours((p) => ({ ...p, [bottleKey(b)]: ml })),
              }
            : undefined
        }
      />
    ));
  const freeze = palette.stashLoc.freezer;

  return (
    <section style={s.cal}>
      {/* Every session, whatever became of the milk — supply is what was expressed. */}
      {bottles.length > 0 && <SupplySummary bottles={bottles} now={now} />}

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

      {/* Combine ("Regrouper"): the night's fridge bottles poured into one bottle before freezing. Every
          candidate starts ticked — that's the routine — and you untick what stays out. */}
      {bagging == null && baggable.length >= 2 && (
        <button
          onClick={() => { buzz(); setPours({}); setBagging(new Set(baggable.map(bottleKey))); }}
          style={{ ...s.chip, width: "100%", gap: 7, margin: "2px 0 12px" }}
        >
          <SnowflakeIcon size={16} />
          {t("stash.bagIt")}
        </button>
      )}
      {bagging != null && (
        <>
          <button
            onClick={() => { bagIt(picked.map((b) => ({ bottle: b, ml: pourOf(b) })), now); setBagging(null); }}
            disabled={picked.length < 2}
            style={{ ...s.cta, marginTop: 4, ...(picked.length < 2 ? s.ctaOff : { background: freeze }) }}
          >
            {t("stash.freezeBag", { volume: volume(pickedMl) })}
          </button>
          <button
            onClick={() => { buzz(); setBagging(null); }}
            style={{ ...s.sheetHint, display: "block", width: "100%", minHeight: 44, margin: "6px 0 8px", background: "none", border: "none", textAlign: "center" }}
          >
            {t("common.cancel")}
          </button>
        </>
      )}

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
          {/* A quiet text toggle, not a chip: history is bookkeeping, and a full-width chip
              gave it the same weight as the freezer — the part you actually draw from. */}
          <button
            onClick={() => { buzz(); setShowSpent((v) => !v); }}
            aria-expanded={showSpent}
            style={{ ...s.sheetHint, display: "block", width: "100%", minHeight: 44, margin: "22px 0 4px", padding: "8px 0", background: "none", border: "none", textAlign: "center" }}
          >
            {t("stash.spentSummary", { count: spent.length, volume: volume(spent.reduce((sum, b) => sum + b.amount, 0)) })} {showSpent ? "▴" : "▾"}
          </button>
          {showSpent && rows(spent)}
        </>
      )}

      <StashStateSheet bottle={restating} now={now} onApply={(b, next) => { apply(b, next); setRestating(null); }} onClose={() => setRestating(null)} />
    </section>
  );
}
