/**
 * Home shell — the thumb-first logging screen + timeline page, wired to the typed hooks and
 * the offline outbox. Reads are optimistic: a started timer shows instantly (from the local
 * outbox mapping) and reconciles with the server poll. All writes go through `submit()`,
 * which enqueues a Mutation, repaints, then flushes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  type BabyBuddyClient,
  type Connection,
  type EntryPatch,
  type FeedingMethod,
  type FeedingType,
  type Mutation,
  type TimelineEntry,
  type TimerActivityKey,
  ACTIVITIES,
  METHODS_FOR_TYPE,
  childName,
  consumeTimerMutation,
  createFeedingMutation,
  createSleepMutation,
  createTummyMutation,
  deleteEntryMutation,
  discardTimerMutation,
  enqueueMutation,
  flushOutbox,
  getLastFeedingChoice,
  logDiaperMutation,
  logMedicationMutation,
  mergeTimerMapping,
  onOutboxError,
  setTimerMapping,
  startOutboxAutoFlush,
  startTimerMutation,
  updateEntryMutation,
} from "../api";
import { useStyles, useTheme } from "../theme";
import {
  ACTIVITY_ICON,
  BellIcon,
  DisconnectIcon,
  EditIcon,
  HomeIcon,
  InstallIcon,
  MenuIcon,
  StopIcon,
  TrashIcon,
  ThemeIcon,
  TimelineIcon,
} from "../ui/icons";
import { SUPPORTED_LANGUAGES, LANGUAGE_NAMES, LANGUAGE_FLAGS, currentLanguage } from "../i18n";
import {
  clearTimerNotifications,
  notificationsSupported,
  requestNotificationPermission,
  showNapNotification,
  syncTimerNotifications,
} from "./notifications";
import { fmt, hm, iso, nowIso, nowMs, parseDurationMs, toDurationField } from "../lib/format";
import { clockTime, formatAge, greeting } from "../lib/datetime";
import { predictNext, predictSleepEnd, type ActivityPrediction } from "../lib/predict";
import { lastNight } from "../lib/night";
import { tummyProgress } from "../lib/tummy";
import { activityLabel, diaperMeta, feedingMeta } from "../lib/labels";
import {
  buzz,
  useChildren,
  useNow,
  usePwaInstall,
  useRunningTimers,
  useTimeline,
  useToast,
  type RunningTimer,
} from "./hooks";
import { DiaperSheet, EntrySheet, FeedingSheet } from "./sheets";
import { Calendar } from "./Calendar";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useFocusTrap } from "./useFocusTrap";
import type { EditDraft, EditTarget, RecentMed } from "./types";
import type { ActivityKey } from "../api";

const TILE_ORDER: ActivityKey[] = ["feeding", "sleep", "diaper", "tummy"];
const STALE_SLEEP_MS = 14 * 3600_000;

// Feeding sheet: `localId: null` = pre-start (details chosen BEFORE the timer exists — the
// CTA starts it); a real localId = refine mode over an already-running timer. `lastMethod`
// (pre-start only) is the previous feed's method, snapshotted at open so the "last time:
// left" hint doesn't chase the user's taps.
type Sheet = { type: "feeding"; localId: string | null; lastMethod?: FeedingMethod | null } | { type: "diaper" } | null;
type FeedSel = { type: FeedingType | null; method: FeedingMethod | null; amount?: number | null };

/** Breastfeeding alternates sides: propose the breast NOT used last time. "Both breasts"
 *  stays both; bottle/solid/none pass through unchanged. */
const otherBreast = (m: FeedingMethod | null | undefined): FeedingMethod | null =>
  m === "left breast" ? "right breast" : m === "right breast" ? "left breast" : (m ?? null);

export function Home({
  client,
  connection,
  onDisconnect,
}: {
  client: BabyBuddyClient;
  connection: Connection;
  onDisconnect: () => void;
}) {
  const { s, activeTile, runCardAccent, toastTone } = useStyles();
  const { palette, pref, cyclePref } = useTheme();
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const now = useNow();

  const { children, childId, selectChild } = useChildren(client);
  const { running, refresh: refreshRunning } = useRunningTimers(client, childId);
  const { entries, refresh: refreshTimeline, removeLocal, updatedAt: timelineUpdatedAt } = useTimeline(client, childId);
  const { toast, show } = useToast();
  const { canInstall, promptInstall } = usePwaInstall();

  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [feedSel, setFeedSel] = useState<FeedSel>({ type: null, method: null });
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [lastFeed, setLastFeed] = useState<Record<number, FeedSel>>({});
  const [notify, setNotify] = useState(() => localStorage.getItem("baby-log:notify") === "on");
  const [napAlert, setNapAlert] = useState(() => localStorage.getItem("baby-log:napalert") === "on");
  // The predicted-nap window we already notified for (bucketed), so the per-minute prediction
  // refresh can't re-fire the same alert.
  const napFired = useRef<number>(0);
  // Synchronous in-flight guard so a rapid double-tap can't start/stop the same thing twice
  // (the `running` state updates async, too late to dedupe taps).
  const pending = useRef<Set<string>>(new Set());

  const accentOf = (a: ActivityKey) => palette.accents[a].accent;
  const child = children?.find((c) => c.id === childId) ?? null;
  const childFirstName = child?.first_name ?? null; // shown in timer notifications
  const instanceHost = (() => {
    try {
      return new URL(connection.url).host;
    } catch {
      return connection.url;
    }
  })();

  // "Next ~" predictions for the activity tiles. Derived purely from the recent timeline +
  // the child's age (see lib/predict), so it recomputes for free on each timeline refetch.
  // Re-derived at most once a minute (and whenever entries/child change) — eta is otherwise
  // static, so there's no point recomputing it on every 1s clock tick.
  const nowMinute = Math.floor(now / 60_000);
  const predictions = useMemo(
    () => predictNext(entries ?? [], child?.birth_date, nowMinute * 60_000),
    [entries, child, nowMinute],
  );
  // Today's tummy-time total vs the age-recommended daily goal — shown as a row in the same
  // "up next" panel (not on the tile).
  const tummy = useMemo(
    () => (child ? tummyProgress(entries ?? [], child.birth_date, nowMinute * 60_000) : null),
    [entries, child, nowMinute],
  );
  // Confident-enough estimates, soonest first. An activity with a running timer is omitted
  // (it's already in progress); the rest stay visible alongside the running card(s).
  const upNext = useMemo(() => {
    const busy = new Set<string>(running.map((r) => r.activity));
    return (Object.values(predictions) as ActivityPrediction[])
      .filter((p) => p.confidence >= 0.1 && !busy.has(p.activity))
      .sort((a, b) => a.etaMs - b.etaMs);
  }, [predictions, running]);
  // Show the tummy stat unless a tummy timer is already running, and don't let a lone "0/x min"
  // row pre-empt the cold-start nudge (only surface it once there's tummy time logged or other
  // estimates to sit beside).
  const tummyBusy = running.some((r) => r.activity === "tummy");
  const showTummy = !!tummy && !tummyBusy && (tummy.todayMs > 0 || upNext.length > 0);
  // How long the predicted next sleep should last (shown beside its "up next" eta), and the
  // predicted wake for a RUNNING sleep timer (shown on its card).
  const nextSleepEnd = useMemo(
    () => (predictions.sleep ? predictSleepEnd(entries ?? [], child?.birth_date, predictions.sleep.etaMs) : null),
    [entries, child, predictions],
  );
  const runningSleep = running.find((r) => r.activity === "sleep");
  // Depend on the primitive startedMs, not the timer object: `find` returns a fresh reference
  // every render, and Home re-renders every second — the object dep would re-run the prediction at 1 Hz.
  const runningSleepStartedMs = runningSleep?.startedMs ?? null;
  const runningSleepEnd = useMemo(
    () => (runningSleepStartedMs != null ? predictSleepEnd(entries ?? [], child?.birth_date, runningSleepStartedMs) : null),
    [entries, child, runningSleepStartedMs],
  );
  // Last-night recap ("19:45 – 07:02 · 2 réveils") + today's bottle total (ml).
  const night = useMemo(() => lastNight(entries ?? [], nowMinute * 60_000), [entries, nowMinute]);
  // Most recent completed feeding, for the "what/when/how was the last feed" glance row
  // (entries are newest-first).
  const lastFeeding = useMemo(
    () => (entries ?? []).find((e): e is Extract<TimelineEntry, { activity: "feeding" }> => e.activity === "feeding") ?? null,
    [entries],
  );
  const mlToday = useMemo(() => {
    const dayStart = new Date(nowMinute * 60_000);
    dayStart.setHours(0, 0, 0, 0);
    let ml = 0;
    for (const e of entries ?? []) {
      if (e.activity === "feeding" && e.startMs >= dayStart.getTime() && e.amount != null) ml += e.amount;
    }
    return Math.round(ml);
  }, [entries, nowMinute]);
  // Recent distinct medications (newest-first, deduped by name) for the sheet's "repeat last
  // dose" chips — derived from the timeline already in memory, no extra fetch.
  const recentMeds = useMemo<RecentMed[]>(() => {
    const seen = new Map<string, RecentMed>();
    for (const e of entries ?? []) {
      if (e.activity !== "medication") continue;
      const name = e.name.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue; // entries are newest-first → first seen is the most recent
      seen.set(key, { name, dosage: e.dosage, dosageUnit: e.dosageUnit, nextDoseMs: parseDurationMs(e.nextDoseInterval) });
      if (seen.size >= 4) break;
    }
    return [...seen.values()];
  }, [entries]);
  // Double-dose guard: the most recent dose (within 48 h) that carries a next-dose interval.
  // Drives a home-screen row so a second caregiver sees when the next dose is due.
  const medGuard = useMemo(() => {
    const nowT = nowMinute * 60_000;
    let best: { name: string; lastMs: number; dueMs: number } | null = null;
    for (const e of entries ?? []) {
      if (e.activity !== "medication") continue;
      if (e.startMs > nowT || nowT - e.startMs > 48 * 3600_000) continue;
      const intervalMs = parseDurationMs(e.nextDoseInterval);
      if (intervalMs == null) continue;
      if (!best || e.startMs > best.lastMs) best = { name: e.name.trim() || t("activity.medication"), lastMs: e.startMs, dueMs: e.startMs + intervalMs };
    }
    return best;
  }, [entries, nowMinute, t]);
  // Precise age beside the "Tracking …" line (recomputed daily, not every tick).
  const ageLabel = useMemo(
    () => (child?.birth_date ? formatAge(child.birth_date, new Date(nowMinute * 60_000)) : ""),
    [child, nowMinute],
  );

  // Background outbox flushing (online/focus/interval) — covers retries beyond submit().
  useEffect(() => startOutboxAutoFlush(client), [client]);

  // Surface permanently-failed writes (rejected field, bad token, …) as a toast — they don't
  // retry, so the user would otherwise see a logged action silently vanish.
  useEffect(
    () =>
      onOutboxError((f) => {
        const known = new Set(["start-timer", "log-diaper", "log-medication", "update-entry", "delete-entry"]);
        const key = f.actionKind.startsWith("consume")
          ? "consume"
          : f.actionKind.startsWith("create")
            ? "create"
            : known.has(f.actionKind)
              ? f.actionKind
              : "generic";
        const reason =
          f.detail ??
          (f.status === 401 || f.status === 403
            ? t("error.notAuthorized")
            : f.status === 0
              ? t("error.network")
              : t("error.serverRejected", { status: f.status }));
        show(t("action.failed", { action: t(`action.${key}`), reason }), palette.danger, 4500);
      }),
    [t, show, palette.danger],
  );

  // Mirror running timers into OS notifications (with a Stop action) when enabled.
  useEffect(() => {
    if (notify) void syncTimerNotifications(running, childId, childFirstName);
  }, [notify, running, childId, childFirstName]);

  // Stopping a timer from its notification (handled in the SW) → refresh the open app.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: unknown } | null)?.type === "timers-changed") {
        refreshRunning();
        refreshTimeline();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [refreshRunning, refreshTimeline]);

  // Foreground-resume refresh. TanStack already polls (15s timers / 30s timeline) and refetches
  // on focus, but iOS standalone PWAs fire focus/visibility inconsistently, so a resume can be
  // missed and the app shows stale data until the next interval. Re-fetch running timers + the
  // timeline whenever the app comes back to the foreground (or reconnects) so events logged
  // elsewhere — the Home Assistant buttons or the other caregiver — appear right away.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      refreshRunning();
      refreshTimeline();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh); // iOS bfcache resume — focus often doesn't fire
    window.addEventListener("online", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [refreshRunning, refreshTimeline]);

  const toggleNotify = async () => {
    buzz();
    if (notify) {
      setNotify(false);
      localStorage.setItem("baby-log:notify", "off");
      await clearTimerNotifications();
      return;
    }
    if (!(await requestNotificationPermission())) {
      show(t("toast.notifBlocked"), palette.danger);
      return;
    }
    setNotify(true);
    localStorage.setItem("baby-log:notify", "on");
    await syncTimerNotifications(running, childId, childFirstName);
    show(running.length ? t("toast.alertsOn") : t("toast.alertsOnHint"), accentOf("feeding"));
  };

  const toggleNapAlert = async () => {
    buzz();
    if (napAlert) {
      setNapAlert(false);
      localStorage.setItem("baby-log:napalert", "off");
      return;
    }
    if (!(await requestNotificationPermission())) {
      show(t("toast.notifBlocked"), palette.danger);
      return;
    }
    setNapAlert(true);
    localStorage.setItem("baby-log:napalert", "on");
    show(t("toast.napAlertOn"), accentOf("sleep"));
  };

  // Nap-window alert: ~10 min before the predicted sleep onset, when the prediction comes from
  // the child's own pattern with decent confidence. Skipped during quiet hours (21:00–07:00),
  // while a sleep timer is already running, and re-fires at most once per predicted window
  // (the prediction refreshes every minute — the bucket guard absorbs that).
  useEffect(() => {
    if (!napAlert) return;
    const p = predictions.sleep;
    if (!p || p.basis !== "pattern" || p.confidence < 0.5) return;
    if (running.some((r) => r.activity === "sleep")) return;
    const fireAt = p.etaMs - 10 * 60_000;
    // Quiet hours apply to BOTH the predicted nap and the firing moment — a 07:05 prediction
    // must not buzz the phone at 06:55.
    const quiet = (ms: number) => {
      const h = new Date(ms).getHours();
      return h >= 21 || h < 7;
    };
    if (quiet(p.etaMs) || quiet(fireAt)) return;
    const bucket = Math.round(p.etaMs / (15 * 60_000));
    if (napFired.current === bucket) return;
    if (fireAt - Date.now() < -5 * 60_000) return; // the window already passed
    const id = window.setTimeout(() => {
      napFired.current = bucket;
      void showNapNotification(p.etaMs, childFirstName);
    }, Math.max(0, fireAt - Date.now()));
    return () => window.clearTimeout(id);
  }, [napAlert, predictions, running, childFirstName]);

  // Cycle the UI language (the choice is cached in localStorage by the detector).
  const cycleLanguage = () => {
    buzz();
    const idx = SUPPORTED_LANGUAGES.indexOf(currentLanguage());
    void i18n.changeLanguage(SUPPORTED_LANGUAGES[(idx + 1) % SUPPORTED_LANGUAGES.length]);
  };

  // Remember the child's last feeding choice (localStorage instant, server authoritative).
  useEffect(() => {
    if (childId == null) return;
    const cached = localStorage.getItem(`baby-log:lastfeed:${childId}`);
    if (cached) {
      try {
        // Seed from localStorage when the child changes (instant paint before the fetch).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLastFeed((p) => ({ ...p, [childId]: JSON.parse(cached) }));
      } catch {
        /* ignore */
      }
    }
    getLastFeedingChoice(client, childId)
      .then((choice) => {
        if (!choice) return;
        setLastFeed((p) => ({ ...p, [childId]: choice }));
        localStorage.setItem(`baby-log:lastfeed:${childId}`, JSON.stringify(choice));
      })
      .catch(() => {});
  }, [client, childId]);

  // ── write pipeline ──
  const submit = (m: Mutation) => {
    refreshRunning();
    void enqueueMutation(m)
      .then(() => flushOutbox(client))
      .then(() => {
        refreshRunning();
        refreshTimeline();
        void qc.invalidateQueries({ queryKey: ["calendar"] }); // refresh the calendar grids/summary
      })
      .catch(() => {});
  };

  const feedingFieldsFor = (
    sel: { type?: FeedingType | null; method?: FeedingMethod | null; amount?: number | null } | undefined,
  ): { type: FeedingType; method: FeedingMethod; amount: number | null } => {
    const type = sel?.type ?? "breast milk";
    const allowed = METHODS_FOR_TYPE[type];
    const method = sel?.method && allowed.includes(sel.method) ? sel.method : allowed[0];
    // Any bottle is measured (formula, fortified, pumped breast milk); drop it otherwise.
    return { type, method, amount: method === "bottle" ? (sel?.amount ?? null) : null };
  };

  const start = async (activity: TimerActivityKey, feedingSel?: FeedSel): Promise<string | null> => {
    if (childId == null) return null;
    const startedAt = nowIso();
    const { mutation, localId } = startTimerMutation(activity, childId, startedAt);
    const feeding = activity === "feeding" ? (feedingSel ?? lastFeed[childId]) : undefined;
    await setTimerMapping({ localId, startedAt, activity, childId, ...(feeding ? { feeding } : {}) });
    submit(mutation);
    show(t("toast.started", { activity: activityLabel(activity) }), accentOf(activity));
    return localId;
  };

  const stop = async (rt: RunningTimer) => {
    if (childId == null) return;
    const guard = `stop:${rt.key}`;
    if (pending.current.has(guard)) return;
    pending.current.add(guard);
    buzz();
    try {
      let localId = rt.localId;
      if (!localId) {
        // Server-only timer (another device) — mint a mapping so the stop resolves its id.
        localId = crypto.randomUUID();
        await setTimerMapping({ localId, serverId: rt.serverId, startedAt: new Date(rt.startedMs).toISOString(), activity: rt.activity, childId });
      }
      const durationMs = nowMs() - rt.startedMs;
      if (rt.activity === "feeding") {
        const fields = feedingFieldsFor(rt.feeding ?? feedSel);
        submit(consumeTimerMutation("feeding", localId, childId, fields));
        const next = { type: fields.type, method: fields.method, amount: fields.amount };
        setLastFeed((p) => ({ ...p, [childId]: next }));
        localStorage.setItem(`baby-log:lastfeed:${childId}`, JSON.stringify(next));
      } else if (rt.activity === "sleep") {
        submit(consumeTimerMutation("sleep", localId, childId));
      } else {
        submit(consumeTimerMutation("tummy", localId, childId));
      }
      if (sheet?.type === "feeding") setSheet(null);
      show(t("toast.saved", { activity: activityLabel(rt.activity), duration: fmt(durationMs) }), accentOf(rt.activity));
    } finally {
      pending.current.delete(guard);
    }
  };

  /** Discard a mistaken timer WITHOUT logging an entry (`DELETE /api/timers/<id>/` via the
   *  outbox) — per the spec, the escape hatch for an accidental start. */
  const discard = async (rt: RunningTimer) => {
    if (childId == null) return;
    const guard = `discard:${rt.key}`;
    if (pending.current.has(guard)) return;
    pending.current.add(guard);
    buzz();
    try {
      let localId = rt.localId;
      if (!localId) {
        // Server-only timer (another device) — mint a mapping so the discard resolves its id.
        localId = crypto.randomUUID();
        await setTimerMapping({ localId, serverId: rt.serverId, startedAt: new Date(rt.startedMs).toISOString(), activity: rt.activity, childId });
      }
      submit(discardTimerMutation(localId));
      if (sheet?.type === "feeding" && rt.activity === "feeding") setSheet(null);
      show(t("toast.timerDiscarded"), palette.danger);
    } finally {
      pending.current.delete(guard);
    }
  };

  /** Open the feeding refine sheet, minting a mapping first for a server-only timer. */
  const openFeedingRefine = async (rt: RunningTimer) => {
    if (childId == null) return;
    buzz();
    const sel: FeedSel = { type: rt.feeding?.type ?? null, method: rt.feeding?.method ?? null, amount: rt.feeding?.amount ?? null };
    let localId = rt.localId;
    if (!localId) {
      localId = crypto.randomUUID();
      await setTimerMapping({ localId, serverId: rt.serverId, startedAt: new Date(rt.startedMs).toISOString(), activity: "feeding", childId, feeding: sel });
      refreshRunning();
    }
    setFeedSel(sel);
    setSheet({ type: "feeding", localId });
  };

  const onActivity = async (activity: ActivityKey) => {
    buzz();
    const rt = running.find((r) => r.activity === activity);
    if (rt) {
      void stop(rt);
      return;
    }
    if (activity === "diaper") {
      setSheet({ type: "diaper" });
      return;
    }
    // Medication isn't a home tile and never runs as a timer — it's logged from the journal only.
    if (activity === "medication") return;
    if (activity === "feeding") {
      // Details BEFORE the timer: open the sheet pre-seeded with the last choice — proposing
      // the OTHER breast when the last feed was one-sided; the timer only starts when the CTA
      // is tapped (confirmFeeding). Closing the sheet = cancel.
      const last = childId != null ? lastFeed[childId] : undefined;
      setFeedSel(last ? { ...last, method: otherBreast(last.method) } : { type: null, method: null });
      setSheet({ type: "feeding", localId: null, lastMethod: last?.method ?? null });
      return;
    }
    const guard = `start:${activity}`;
    if (pending.current.has(guard)) return; // rapid double-tap → ignore the second
    pending.current.add(guard);
    try {
      await start(activity); // sleep | tummy
    } finally {
      pending.current.delete(guard);
    }
  };

  /** Feeding sheet CTA. Pre-start mode: start the timer NOW with the chosen details.
   *  Refine mode (running timer): the details were already merged live — just close. */
  const confirmFeeding = async () => {
    buzz();
    if (sheet?.type !== "feeding") return;
    if (sheet.localId != null) {
      setSheet(null);
      return;
    }
    const guard = "start:feeding";
    if (pending.current.has(guard)) return; // rapid double-tap → one timer, not two
    pending.current.add(guard);
    try {
      await start("feeding", feedSel);
      setSheet(null);
    } finally {
      pending.current.delete(guard);
    }
  };

  const selectType = (type: FeedingType) => {
    buzz();
    const allowed = METHODS_FOR_TYPE[type];
    const method = feedSel.method && allowed.includes(feedSel.method) ? feedSel.method : allowed.length === 1 ? allowed[0] : null;
    const next = { type, method, amount: feedSel.amount ?? null };
    setFeedSel(next);
    if (sheet?.type === "feeding" && sheet.localId != null) void mergeTimerMapping(sheet.localId, { feeding: next }).then(refreshRunning);
    if (childId != null) setLastFeed((p) => ({ ...p, [childId]: next }));
  };

  const selectMethod = (method: FeedingMethod | null) => {
    buzz();
    const next = { type: feedSel.type, method, amount: feedSel.amount ?? null };
    setFeedSel(next);
    if (sheet?.type === "feeding" && sheet.localId != null) void mergeTimerMapping(sheet.localId, { feeding: next }).then(refreshRunning);
    if (childId != null) setLastFeed((p) => ({ ...p, [childId]: next }));
  };

  const selectAmount = (amount: number | null) => {
    const next = { type: feedSel.type, method: feedSel.method, amount };
    setFeedSel(next);
    if (sheet?.type === "feeding" && sheet.localId != null) void mergeTimerMapping(sheet.localId, { feeding: next }).then(refreshRunning);
    if (childId != null) setLastFeed((p) => ({ ...p, [childId]: next }));
  };

  const logDiaper = (preset: { wet: boolean; solid: boolean; label: string }) => {
    if (childId == null) return;
    buzz();
    setSheet(null);
    // Stamp the time at the tap — without it the server stamps the FLUSH time, which is
    // wrong whenever the outbox drains late (offline / flaky wifi).
    submit(logDiaperMutation(childId, { wet: preset.wet, solid: preset.solid, time: nowIso() }));
    show(t("toast.diaperLogged", { detail: diaperMeta(preset.wet, preset.solid) }), accentOf("diaper"));
  };

  // ── timeline edit / add ──
  const openEdit = (e: TimelineEntry) => {
    buzz();
    setEditing({ isNew: false, activity: e.activity, serverId: e.id, path: e.path });
    setDraft({
      type: e.activity === "feeding" ? e.type : null,
      method: e.activity === "feeding" ? e.method : null,
      amount: e.activity === "feeding" ? e.amount : null,
      wet: e.activity === "diaper" ? e.wet : false,
      solid: e.activity === "diaper" ? e.solid : false,
      medName: e.activity === "medication" ? e.name : "",
      dosage: e.activity === "medication" ? e.dosage : null,
      dosageUnit: e.activity === "medication" ? e.dosageUnit : null,
      nextDoseMs: e.activity === "medication" ? parseDurationMs(e.nextDoseInterval) : null,
      startMs: e.startMs,
      endMs: e.endMs,
      // Tummy-time has no `notes` column — its free text lives in `milestone`.
      notes: (e.activity === "tummy" ? e.milestone : e.notes) ?? "",
    });
  };

  const openAdd = () => {
    buzz();
    setEditing({ isNew: true, activity: null });
    setDraft({ type: null, method: null, amount: null, wet: false, solid: false, medName: "", dosage: null, dosageUnit: null, nextDoseMs: null, startMs: nowMs(), endMs: null, notes: "" });
  };

  /** Back from a picked kind to the activity picker (adding only — an existing entry's kind
   *  is fixed). Keeps the draft; pickKind re-derives the time span on the next pick. */
  const backToKindPicker = () => {
    buzz();
    setEditing((t) => (t && t.isNew ? { ...t, activity: null } : t));
  };

  const pickKind = (key: ActivityKey) => {
    buzz();
    setEditing((t) => (t ? { ...t, activity: key } : t));
    setDraft((d) => {
      if (!d) return d;
      // Instant activities (diaper, medication) log a single moment — no span.
      if (!ACTIVITIES[key].timed) return { ...d, endMs: null };
      // Default to a 15-min span ENDING now — Baby Buddy rejects future times.
      const end = nowMs();
      return { ...d, startMs: end - 15 * 60_000, endMs: end };
    });
  };

  const buildPatch = (target: EditTarget, d: EditDraft): EntryPatch | null => {
    const startIso = iso(d.startMs);
    const endIso = iso(d.endMs ?? d.startMs);
    const notes = d.notes.trim() === "" ? null : d.notes; // empty clears the note server-side
    switch (target.path) {
      case "/api/feedings/": {
        // Preserve the existing method verbatim (the server accepts all 6 for any type);
        // only derive a default when none is set, so an unrelated time edit can't silently
        // rewrite a cross-client method (e.g. "self fed").
        const type = d.type ?? "breast milk";
        const method = d.method ?? METHODS_FOR_TYPE[type][0];
        return { path: "/api/feedings/", body: { type, method, start: startIso, end: endIso, notes, amount: method === "bottle" ? d.amount : null } };
      }
      case "/api/sleep/":
        return { path: "/api/sleep/", body: { start: startIso, end: endIso, notes } };
      case "/api/tummy-times/":
        // Tummy-time's free text is `milestone` (it has no `notes` column).
        return { path: "/api/tummy-times/", body: { start: startIso, end: endIso, milestone: d.notes } };
      case "/api/changes/":
        return childId == null ? null : { path: "/api/changes/", body: { child: childId, wet: d.wet, solid: d.solid, time: startIso, notes } };
      case "/api/medication/":
        return childId == null ? null : { path: "/api/medication/", body: { child: childId, name: d.medName.trim(), dosage: d.dosage, dosage_unit: d.dosageUnit ?? undefined, next_dose_interval: d.nextDoseMs != null ? toDurationField(d.nextDoseMs) : null, time: startIso, notes } };
      default:
        return null;
    }
  };

  const saveEdit = () => {
    if (!editing || !draft || !editing.activity || childId == null) return;
    if (Number.isNaN(draft.startMs) || (draft.endMs != null && Number.isNaN(draft.endMs))) {
      show(t("toast.enterValidTime"), palette.danger); // a cleared datetime field → NaN
      return;
    }
    if (draft.endMs != null && draft.endMs < draft.startMs) {
      show(t("toast.endBeforeStart"), palette.danger);
      return;
    }
    const future = nowMs() + 60_000; // 1-min grace for clock skew
    if (draft.startMs > future || (draft.endMs != null && draft.endMs > future)) {
      show(t("toast.timeFuture"), palette.danger); // the server rejects it
      return;
    }
    if (editing.activity === "diaper" && !draft.wet && !draft.solid) {
      show(t("toast.pickDiaper"), palette.danger);
      return;
    }
    if (editing.activity === "medication" && !draft.medName.trim()) {
      show(t("toast.medNameRequired"), palette.danger);
      return;
    }
    buzz();
    const { activity } = editing;
    if (editing.isNew) {
      const startIso = iso(draft.startMs);
      const endIso = iso(draft.endMs ?? draft.startMs);
      const notes = draft.notes.trim() === "" ? null : draft.notes;
      if (activity === "diaper") submit(logDiaperMutation(childId, { wet: draft.wet, solid: draft.solid, time: startIso, notes }));
      else if (activity === "medication") submit(logMedicationMutation(childId, { name: draft.medName.trim(), dosage: draft.dosage, dosage_unit: draft.dosageUnit ?? undefined, next_dose_interval: draft.nextDoseMs != null ? toDurationField(draft.nextDoseMs) : null, time: startIso, notes }));
      else if (activity === "feeding") submit(createFeedingMutation(childId, startIso, endIso, { ...feedingFieldsFor({ type: draft.type, method: draft.method, amount: draft.amount }), notes }));
      else if (activity === "sleep") submit(createSleepMutation(childId, startIso, endIso, { notes }));
      else submit(createTummyMutation(childId, startIso, endIso, draft.notes.trim() ? { milestone: draft.notes } : {}));
    } else if (editing.serverId != null) {
      const patch = buildPatch(editing, draft);
      if (patch) submit(updateEntryMutation(editing.serverId, patch));
    }
    setEditing(null);
    setDraft(null);
  };

  const removeEntry = (e: TimelineEntry) => {
    buzz();
    submit(deleteEntryMutation(e.id, e.path));
    removeLocal(e.path, e.id);
    setEditing(null);
    setDraft(null);
    show(t("toast.entryDeleted"), palette.danger);
  };

  const deleteEditing = () => {
    if (!editing || editing.serverId == null || !editing.path) return;
    removeEntry({ id: editing.serverId, path: editing.path } as TimelineEntry);
  };

  const sheetOpen = sheet !== null || editing !== null;
  const runningFeeding = running.find((r) => r.activity === "feeding");
  const feedingElapsed = sheet?.type === "feeding" && runningFeeding ? now - runningFeeding.startedMs : null;

  const themeLabel = t(pref === "system" ? "nav.themeSystem" : pref === "dark" ? "nav.themeDark" : "nav.themeLight");

  // Dismiss overlays with Escape (the scrim tap is the pointer-first path).
  useEffect(() => {
    if (!menu && !sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(false);
      setSheet(null);
      setEditing(null);
      setDraft(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, sheetOpen]);

  const overlayOpen = menu || sheetOpen || undefined;
  const drawerRef = useFocusTrap<HTMLElement>(menu);

  // Shared page header (home greeting + the journal). Same structure everywhere — only the
  // big title changes — with the child subtitle/age and the multi-child switcher.
  const renderHeader = (title: string) => (
    <header style={s.header}>
      <div style={s.greetRow}>
        <button onClick={() => { buzz(); setMenu(true); }} style={s.iconBtn} aria-label={t("home.menu")}>
          <MenuIcon size={22} />
        </button>
        <div style={s.greetWrap}>
          <div style={s.greet}>{title}</div>
          <div style={s.greetSub}>
            {child ? t("home.tracking", { name: childName(child) }) : t("common.loading")}
            {ageLabel && <span style={s.greetAge}> · {ageLabel}</span>}
          </div>
        </div>
      </div>
      {children && children.length > 1 && (
        <div style={s.children}>
          {children.map((c) => {
            const sel = c.id === childId;
            const initials = (c.first_name?.[0] ?? "·").toUpperCase();
            return (
              <button
                key={c.id}
                onClick={() => { buzz(); if (c.id != null) selectChild(c.id); }}
                style={{ ...s.childChip, ...(sel ? s.childChipOn : {}) }}
                aria-pressed={sel}
                aria-label={childName(c)}
              >
                <span style={{ ...s.avatar, ...(sel ? s.avatarOn : {}) }}>{initials}</span>
                {sel && <span style={s.childName}>{c.first_name}</span>}
              </button>
            );
          })}
        </div>
      )}
    </header>
  );

  return (
    <div style={s.root}>
      <div style={s.ambient} />

      {/* Main content — made inert while an overlay is open so focus can't reach behind it
          (inert also hides it from assistive tech; display:contents keeps the bottom-anchored
          grid layout intact). */}
      <div style={{ display: "contents" }} inert={overlayOpen}>

      <Routes>
        <Route
          path="/"
          element={
            <>
          {renderHeader(greeting())}

          {/* Running timers, then the discreet "up next" estimates. The estimates stay visible
              while a timer runs (the running activity is filtered out of `upNext`); the idle
              line shows only when nothing's running and there's nothing to estimate. */}
          <section style={s.runningWrap}>
            {running.map((rt) => {
              const v = palette.accents[rt.activity];
              const Icon = ACTIVITY_ICON[rt.activity];
              const elapsed = now - rt.startedMs;
              let meta = rt.activity === "feeding" ? feedingMeta(rt.feeding?.type, rt.feeding?.method, rt.feeding?.amount) : "";
              // The question a parent has the moment baby goes down: how long do I have?
              if (rt.activity === "sleep" && rt === runningSleep && runningSleepEnd && runningSleepEnd.confidence >= 0.3 && runningSleepEnd.endMs > now) {
                meta = t("home.wakeAround", { time: clockTime(runningSleepEnd.endMs) });
              }
              const stale = rt.activity === "sleep" && elapsed > STALE_SLEEP_MS;
              return (
                <div key={rt.key} className="run-in" style={{ ...s.runCard, ...runCardAccent(v), ...(stale ? s.runCardStale : {}) }}>
                  <button onClick={() => void stop(rt)} style={s.runBody} aria-label={`${activityLabel(rt.activity)} — ${t("home.tapToStop")}`}>
                    <span style={{ ...s.runIcon, color: v.accent }}>
                      <Icon size={22} />
                      <span className="breathe" style={{ ...s.liveDot, background: v.accent }} />
                    </span>
                    <span style={s.runMeta}>
                      <span style={s.runLabel}>
                        {activityLabel(rt.activity)}
                        {meta ? ` · ${meta}` : ""}
                        {stale && <span style={{ color: palette.danger, fontWeight: 800 }}> · {t("home.stillGoing")}</span>}
                      </span>
                      <span className="tick" style={{ ...s.runTime, color: v.accent }}>
                        {fmt(elapsed)}
                      </span>
                    </span>
                    <span style={{ ...s.runEdit, color: v.accent, borderColor: `${v.accent}55` }} aria-hidden>
                      <StopIcon size={18} />
                    </span>
                  </button>
                  {rt.activity === "feeding" && (
                    <button
                      onClick={() => void openFeedingRefine(rt)}
                      style={{ ...s.runEdit, color: v.accent, borderColor: `${v.accent}55` }}
                      aria-label={t("home.editFeeding")}
                    >
                      <EditIcon size={16} />
                    </button>
                  )}
                  {/* discard: end a mistaken timer WITHOUT logging it (more prominent when stale) */}
                  <button
                    onClick={() => void discard(rt)}
                    style={{ ...s.runEdit, color: stale ? palette.danger : v.accent, borderColor: stale ? `${palette.danger}66` : `${v.accent}55` }}
                    aria-label={t("home.discardTimer")}
                  >
                    <TrashIcon size={16} />
                  </button>
                </div>
              );
            })}

            {upNext.length > 0 || showTummy || night || mlToday > 0 || medGuard || lastFeeding ? (
              <div style={s.estimates}>
                {medGuard && (() => {
                  const locked = medGuard.dueMs > now;
                  return (
                    <div style={s.estimateRow}>
                      <span style={{ ...s.estimateIcon, background: `${palette.accents.medication.accent}14`, color: palette.accents.medication.accent }}>
                        <ACTIVITY_ICON.medication size={16} />
                      </span>
                      <span style={s.estimateLabel}>{medGuard.name}</span>
                      <span style={{ ...s.estimateTime, ...(locked ? { color: palette.danger } : {}) }}>
                        {locked ? t("home.doseOkFrom", { time: clockTime(medGuard.dueMs) }) : t("home.doseLastAgo", { ago: hm(now - medGuard.lastMs) })}
                      </span>
                    </div>
                  );
                })()}
                {night && (
                  <div style={s.estimateRow}>
                    <span style={{ ...s.estimateIcon, background: `${palette.accents.sleep.accent}14`, color: palette.accents.sleep.accent }}>
                      <ACTIVITY_ICON.sleep size={16} />
                    </span>
                    <span style={s.estimateLabel}>{t("home.night")}</span>
                    <span style={s.estimateTime}>
                      {clockTime(night.startMs)} – {clockTime(night.endMs)} · {night.wakings === 0 ? t("home.noWakings") : t("home.wakings", { count: night.wakings })}
                    </span>
                  </div>
                )}
                {/* Last feeding at a glance: when (clock + how long ago) and how (type · side · ml). */}
                {lastFeeding && (
                  <div style={s.estimateRow}>
                    <span style={{ ...s.estimateIcon, background: `${palette.accents.feeding.accent}14`, color: palette.accents.feeding.accent }}>
                      <ACTIVITY_ICON.feeding size={16} />
                    </span>
                    <span style={s.estimateLabel}>{t("home.lastFeeding")}</span>
                    <span style={s.estimateTime}>
                      {clockTime(lastFeeding.startMs)} · {feedingMeta(lastFeeding.type, lastFeeding.method, lastFeeding.amount)}
                    </span>
                  </div>
                )}
                <div style={s.estimatesHead}>{t("home.upNext")}</div>
                {upNext.map((p) => {
                  const v = palette.accents[p.activity];
                  const Icon = ACTIVITY_ICON[p.activity];
                  // The next sleep also says how long it should last ("~15:19 · ~45m").
                  const durHint =
                    p.activity === "sleep" && nextSleepEnd && nextSleepEnd.confidence >= 0.3
                      ? ` · ~${hm(nextSleepEnd.endMs - p.etaMs)}`
                      : "";
                  return (
                    <div key={p.activity} style={s.estimateRow}>
                      <span style={{ ...s.estimateIcon, background: `${v.accent}14`, color: v.accent }}>
                        <Icon size={16} />
                      </span>
                      <span style={s.estimateLabel}>{activityLabel(p.activity)}</span>
                      <span style={s.estimateTime}>
                        {p.etaMs <= now + 60_000 ? t("home.dueNow") : `~${clockTime(p.etaMs)}`}
                        {durHint}
                      </span>
                    </div>
                  );
                })}
                {showTummy && tummy && (
                  <div style={s.estimateRow}>
                    <span style={{ ...s.estimateIcon, background: `${palette.accents.tummy.accent}14`, color: palette.accents.tummy.accent }}>
                      <ACTIVITY_ICON.tummy size={16} />
                    </span>
                    <span style={s.estimateLabel}>{activityLabel("tummy")}</span>
                    <span style={{ ...s.estimateTime, ...(tummy.metGoal ? { color: palette.accents.tummy.accent } : {}) }}>
                      {t("home.tummyToday", { done: Math.round(tummy.todayMs / 60_000), goal: tummy.goalMin })}
                    </span>
                  </div>
                )}
                {mlToday > 0 && (
                  <div style={s.estimateRow}>
                    <span style={{ ...s.estimateIcon, background: `${palette.accents.feeding.accent}14`, color: palette.accents.feeding.accent }}>
                      <ACTIVITY_ICON.feeding size={16} />
                    </span>
                    <span style={s.estimateLabel}>{t("home.bottles")}</span>
                    <span style={s.estimateTime}>{t("home.mlToday", { ml: mlToday })}</span>
                  </div>
                )}
              </div>
            ) : running.length === 0 ? (
              <div style={s.idle}>
                <div style={s.idleDot} />
                <div style={s.idleText}>
                  <span style={s.idleTitle}>{child ? t("home.nothingRunning", { name: child.first_name }) : t("home.nothingRunningGeneric")}</span>
                  <span style={s.idleHint}>{t("home.learnHint")}</span>
                </div>
              </div>
            ) : null}
          </section>

          {/* Activity grid */}
          <section style={s.grid}>
            {TILE_ORDER.map((key, i) => {
              const v = palette.accents[key];
              const Icon = ACTIVITY_ICON[key];
              const on = running.some((r) => r.activity === key);
              return (
                <button
                  key={key}
                  className="tile-in"
                  onClick={() => void onActivity(key)}
                  style={{ ...s.tile, animationDelay: `${0.05 + i * 0.06}s`, ...(on ? activeTile(v) : {}) }}
                >
                  <span style={{ ...s.tileIcon, color: v.accent, ...(on ? { background: `${v.accent}1f` } : {}) }}>
                    <Icon size={32} />
                  </span>
                  <span style={s.tileLabel}>{activityLabel(key)}</span>
                  <span style={{ ...s.tileHint, color: on ? v.accent : palette.textFaint }}>
                    {on
                      ? t("home.tapToStop")
                      : key === "diaper"
                        ? t("home.tapToLog")
                        : key === "feeding"
                          ? t("home.pickAndStart")
                          : t("home.tapToStart")}
                  </span>
                </button>
              );
            })}
          </section>
            </>
          }
        />
        <Route
          path="/timeline"
          element={
            <>
              {renderHeader(t("nav.timeline"))}
              <Calendar
                client={client}
                childId={childId}
                birthDate={child?.birth_date ?? null}
                listEntries={entries}
                listUpdatedAt={timelineUpdatedAt}
                onAdd={openAdd}
                onEdit={openEdit}
                onDelete={removeEntry}
              />
            </>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </div>

      {/* Drawer */}
      {menu && <button tabIndex={-1} style={{ ...s.scrim, cursor: "default" }} onClick={() => setMenu(false)} aria-label={t("home.closeMenu")} />}
      <nav
        ref={drawerRef}
        role="dialog"
        aria-modal={menu}
        aria-label={t("home.menu")}
        tabIndex={-1}
        inert={!menu || undefined}
        style={{ ...s.drawer, ...(menu ? s.drawerOn : {}) }}
      >
        <div style={s.drawerBrand}>
          <span style={s.drawerLogo}>·</span> Baby Log
        </div>
        {([
          { to: "/", key: "nav.home", Icon: HomeIcon },
          { to: "/timeline", key: "nav.timeline", Icon: TimelineIcon },
        ] as const).map((item) => (
          <button key={item.to} onClick={() => { buzz(); navigate(item.to); setMenu(false); }} style={{ ...s.navItem, ...(pathname === item.to ? s.navItemOn : {}) }}>
            <item.Icon size={20} />
            {t(item.key)}
          </button>
        ))}
        <button onClick={() => { buzz(); cyclePref(); }} style={s.navItem}>
          <ThemeIcon size={20} />
          {t("nav.theme", { mode: themeLabel })}
        </button>
        <button
          onClick={() => { buzz(); cycleLanguage(); }}
          style={s.navItem}
          aria-label={t("nav.language", { lang: LANGUAGE_NAMES[currentLanguage()] })}
        >
          <span style={{ fontSize: 19, lineHeight: 1, width: 20, textAlign: "center" }} aria-hidden>
            {LANGUAGE_FLAGS[currentLanguage()]}
          </span>
          {LANGUAGE_NAMES[currentLanguage()]}
        </button>
        {notificationsSupported() && (
          <button onClick={() => void toggleNotify()} style={s.navItem}>
            <BellIcon size={20} />
            {notify ? t("nav.alertsOn") : t("nav.alertsOff")}
          </button>
        )}
        {notificationsSupported() && (
          <button onClick={() => void toggleNapAlert()} style={s.navItem}>
            <ACTIVITY_ICON.sleep size={20} />
            {napAlert ? t("nav.napOn") : t("nav.napOff")}
          </button>
        )}
        {canInstall && (
          <button onClick={() => { buzz(); setMenu(false); void promptInstall(); }} style={s.navItem}>
            <InstallIcon size={20} />
            {t("nav.install")}
          </button>
        )}
        <div style={s.navDivider} />
        <button onClick={() => { buzz(); setMenu(false); void clearTimerNotifications(); onDisconnect(); }} style={{ ...s.navItem, color: palette.danger }}>
          <DisconnectIcon size={20} />
          {t("nav.disconnect")}
        </button>
        <div style={s.navFoot}>
          <div style={{ wordBreak: "break-all" }}>{instanceHost}</div>
          <div style={{ marginTop: 3, color: palette.textFainter, fontWeight: 500 }}>{t("home.version", { version: __APP_VERSION__ })}</div>
        </div>
      </nav>

      {/* Sheets */}
      {sheetOpen && <button tabIndex={-1} style={{ ...s.scrim, cursor: "default" }} onClick={() => { setSheet(null); setEditing(null); setDraft(null); }} aria-label={t("home.close")} />}
      <FeedingSheet
        open={sheet?.type === "feeding"}
        started={sheet?.type === "feeding" && sheet.localId != null}
        elapsedMs={feedingElapsed}
        lastMethod={sheet?.type === "feeding" ? (sheet.lastMethod ?? null) : null}
        type={feedSel.type}
        method={feedSel.method}
        amount={feedSel.amount ?? null}
        onType={selectType}
        onMethod={selectMethod}
        onAmount={selectAmount}
        onDone={() => void confirmFeeding()}
      />
      <DiaperSheet open={sheet?.type === "diaper"} onLog={logDiaper} />
      <EntrySheet target={editing} draft={draft} setDraft={(u) => setDraft((d) => (d ? u(d) : d))} recentMeds={recentMeds} onPickKind={pickKind} onBack={backToKindPicker} onSave={saveEdit} onDelete={deleteEditing} />

      {/* Toast — the only action feedback (no confirm dialogs), so announce it. */}
      <div role="status" aria-live="polite" style={{ ...s.toast, ...(toast ? s.toastOn : {}), ...(toast ? toastTone(toast.accent) : {}) }}>
        {toast?.msg}
      </div>
    </div>
  );
}
