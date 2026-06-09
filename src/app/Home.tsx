/**
 * Home shell — the thumb-first logging screen + timeline page, wired to the typed hooks and
 * the offline outbox. Reads are optimistic: a started timer shows instantly (from the local
 * outbox mapping) and reconciles with the server poll. All writes go through `submit()`,
 * which enqueues a Mutation, repaints, then flushes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
  METHODS_FOR_TYPE,
  childName,
  consumeTimerMutation,
  createFeedingMutation,
  createSleepMutation,
  createTummyMutation,
  deleteEntryMutation,
  enqueueMutation,
  flushOutbox,
  getLastFeedingChoice,
  logDiaperMutation,
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
  ThemeIcon,
  TimelineIcon,
} from "../ui/icons";
import { SUPPORTED_LANGUAGES, LANGUAGE_NAMES, LANGUAGE_FLAGS, currentLanguage } from "../i18n";
import {
  clearTimerNotifications,
  notificationsSupported,
  requestNotificationPermission,
  syncTimerNotifications,
} from "./notifications";
import { fmt, iso, nowIso, nowMs } from "../lib/format";
import { clockTime, greeting } from "../lib/datetime";
import { predictNext, type ActivityPrediction } from "../lib/predict";
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
import { Timeline } from "./Timeline";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useFocusTrap } from "./useFocusTrap";
import type { EditDraft, EditTarget } from "./types";
import type { ActivityKey } from "../api";

const TILE_ORDER: ActivityKey[] = ["feeding", "sleep", "diaper", "tummy"];
const STALE_SLEEP_MS = 14 * 3600_000;

type Sheet = { type: "feeding"; localId: string } | { type: "diaper" } | null;
type FeedSel = { type: FeedingType | null; method: FeedingMethod | null };

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
  const now = useNow();

  const { children, childId, selectChild } = useChildren(client);
  const { running, refresh: refreshRunning } = useRunningTimers(client, childId);
  const { entries, refresh: refreshTimeline, removeLocal } = useTimeline(client, childId);
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
  // Confident-enough estimates, soonest first. An activity with a running timer is omitted
  // (it's already in progress); the rest stay visible alongside the running card(s).
  const upNext = useMemo(() => {
    const busy = new Set<string>(running.map((r) => r.activity));
    return (Object.values(predictions) as ActivityPrediction[])
      .filter((p) => p.confidence >= 0.1 && !busy.has(p.activity))
      .sort((a, b) => a.etaMs - b.etaMs);
  }, [predictions, running]);

  // Background outbox flushing (online/focus/interval) — covers retries beyond submit().
  useEffect(() => startOutboxAutoFlush(client), [client]);

  // Surface permanently-failed writes (rejected field, bad token, …) as a toast — they don't
  // retry, so the user would otherwise see a logged action silently vanish.
  useEffect(
    () =>
      onOutboxError((f) => {
        const known = new Set(["start-timer", "log-diaper", "update-entry", "delete-entry"]);
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
      })
      .catch(() => {});
  };

  const feedingFieldsFor = (
    sel: { type?: FeedingType | null; method?: FeedingMethod | null } | undefined,
  ): { type: FeedingType; method: FeedingMethod } => {
    const type = sel?.type ?? "breast milk";
    const allowed = METHODS_FOR_TYPE[type];
    const method = sel?.method && allowed.includes(sel.method) ? sel.method : allowed[0];
    return { type, method };
  };

  const start = async (activity: TimerActivityKey): Promise<string | null> => {
    if (childId == null) return null;
    const startedAt = nowIso();
    const { mutation, localId } = startTimerMutation(activity, childId, startedAt);
    const feeding = activity === "feeding" ? lastFeed[childId] : undefined;
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
        const next = { type: fields.type, method: fields.method };
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

  /** Open the feeding refine sheet, minting a mapping first for a server-only timer. */
  const openFeedingRefine = async (rt: RunningTimer) => {
    if (childId == null) return;
    buzz();
    const sel: FeedSel = { type: rt.feeding?.type ?? null, method: rt.feeding?.method ?? null };
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
    const guard = `start:${activity}`;
    if (pending.current.has(guard)) return; // rapid double-tap → ignore the second
    pending.current.add(guard);
    try {
      if (activity === "feeding") {
        setFeedSel(childId != null ? (lastFeed[childId] ?? { type: null, method: null }) : { type: null, method: null });
        const localId = await start("feeding");
        if (localId) setSheet({ type: "feeding", localId });
      } else {
        await start(activity); // sleep | tummy
      }
    } finally {
      pending.current.delete(guard);
    }
  };

  const selectType = (type: FeedingType) => {
    buzz();
    const allowed = METHODS_FOR_TYPE[type];
    const method = feedSel.method && allowed.includes(feedSel.method) ? feedSel.method : allowed.length === 1 ? allowed[0] : null;
    const next = { type, method };
    setFeedSel(next);
    if (sheet?.type === "feeding") void mergeTimerMapping(sheet.localId, { feeding: next }).then(refreshRunning);
    if (childId != null) setLastFeed((p) => ({ ...p, [childId]: next }));
  };

  const selectMethod = (method: FeedingMethod) => {
    buzz();
    const next = { type: feedSel.type, method };
    setFeedSel(next);
    if (sheet?.type === "feeding") void mergeTimerMapping(sheet.localId, { feeding: next }).then(refreshRunning);
    if (childId != null) setLastFeed((p) => ({ ...p, [childId]: next }));
  };

  const logDiaper = (preset: { wet: boolean; solid: boolean; label: string }) => {
    if (childId == null) return;
    buzz();
    setSheet(null);
    submit(logDiaperMutation(childId, { wet: preset.wet, solid: preset.solid }));
    show(t("toast.diaperLogged", { detail: diaperMeta(preset.wet, preset.solid) }), accentOf("diaper"));
  };

  // ── timeline edit / add ──
  const openEdit = (e: TimelineEntry) => {
    buzz();
    setEditing({ isNew: false, activity: e.activity, serverId: e.id, path: e.path });
    setDraft({
      type: e.activity === "feeding" ? e.type : null,
      method: e.activity === "feeding" ? e.method : null,
      wet: e.activity === "diaper" ? e.wet : false,
      solid: e.activity === "diaper" ? e.solid : false,
      startMs: e.startMs,
      endMs: e.endMs,
    });
  };

  const openAdd = () => {
    buzz();
    setEditing({ isNew: true, activity: null });
    setDraft({ type: null, method: null, wet: false, solid: false, startMs: nowMs(), endMs: null });
  };

  const pickKind = (key: ActivityKey) => {
    buzz();
    setEditing((t) => (t ? { ...t, activity: key } : t));
    setDraft((d) => {
      if (!d) return d;
      if (key === "diaper") return { ...d, endMs: null };
      // Default to a 15-min span ENDING now — Baby Buddy rejects future times.
      const end = nowMs();
      return { ...d, startMs: end - 15 * 60_000, endMs: end };
    });
  };

  const buildPatch = (target: EditTarget, d: EditDraft): EntryPatch | null => {
    const startIso = iso(d.startMs);
    const endIso = iso(d.endMs ?? d.startMs);
    switch (target.path) {
      case "/api/feedings/": {
        // Preserve the existing method verbatim (the server accepts all 6 for any type);
        // only derive a default when none is set, so an unrelated time edit can't silently
        // rewrite a cross-client method (e.g. "self fed").
        const type = d.type ?? "breast milk";
        const method = d.method ?? METHODS_FOR_TYPE[type][0];
        return { path: "/api/feedings/", body: { type, method, start: startIso, end: endIso } };
      }
      case "/api/sleep/":
        return { path: "/api/sleep/", body: { start: startIso, end: endIso } };
      case "/api/tummy-times/":
        return { path: "/api/tummy-times/", body: { start: startIso, end: endIso } };
      case "/api/changes/":
        return childId == null ? null : { path: "/api/changes/", body: { child: childId, wet: d.wet, solid: d.solid, time: startIso } };
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
    buzz();
    const { activity } = editing;
    if (editing.isNew) {
      const startIso = iso(draft.startMs);
      const endIso = iso(draft.endMs ?? draft.startMs);
      if (activity === "diaper") submit(logDiaperMutation(childId, { wet: draft.wet, solid: draft.solid, time: startIso }));
      else if (activity === "feeding") submit(createFeedingMutation(childId, startIso, endIso, feedingFieldsFor({ type: draft.type, method: draft.method })));
      else if (activity === "sleep") submit(createSleepMutation(childId, startIso, endIso));
      else submit(createTummyMutation(childId, startIso, endIso));
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
          <header style={s.header}>
            <div style={s.greetRow}>
              <button onClick={() => { buzz(); setMenu(true); }} style={s.iconBtn} aria-label={t("home.menu")}>
                <MenuIcon size={22} />
              </button>
              <div style={s.greetWrap}>
                <div style={s.greet}>{greeting()}</div>
                <div style={s.greetSub}>{child ? t("home.tracking", { name: childName(child) }) : t("common.loading")}</div>
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

          {/* Running timers, then the discreet "up next" estimates. The estimates stay visible
              while a timer runs (the running activity is filtered out of `upNext`); the idle
              line shows only when nothing's running and there's nothing to estimate. */}
          <section style={s.runningWrap}>
            {running.map((rt) => {
              const v = palette.accents[rt.activity];
              const Icon = ACTIVITY_ICON[rt.activity];
              const elapsed = now - rt.startedMs;
              const meta = rt.activity === "feeding" ? feedingMeta(rt.feeding?.type, rt.feeding?.method) : "";
              const stale = rt.activity === "sleep" && elapsed > STALE_SLEEP_MS;
              return (
                <div key={rt.key} className="run-in" style={{ ...s.runCard, ...runCardAccent(v) }}>
                  <button onClick={() => void stop(rt)} style={s.runBody} aria-label={`${activityLabel(rt.activity)} — ${t("home.tapToStop")}`}>
                    <span style={{ ...s.runIcon, color: v.accent }}>
                      <Icon size={22} />
                      <span className="breathe" style={{ ...s.liveDot, background: v.accent }} />
                    </span>
                    <span style={s.runMeta}>
                      <span style={s.runLabel}>
                        {activityLabel(rt.activity)}
                        {meta ? ` · ${meta}` : ""}
                        {stale ? ` · ${t("home.stillGoing")}` : ""}
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
                </div>
              );
            })}

            {upNext.length > 0 ? (
              <div style={s.estimates}>
                <div style={s.estimatesHead}>{t("home.upNext")}</div>
                {upNext.map((p) => {
                  const v = palette.accents[p.activity];
                  const Icon = ACTIVITY_ICON[p.activity];
                  return (
                    <div key={p.activity} style={s.estimateRow}>
                      <span style={{ ...s.estimateIcon, background: `${v.accent}14`, color: v.accent }}>
                        <Icon size={16} />
                      </span>
                      <span style={s.estimateLabel}>{activityLabel(p.activity)}</span>
                      <span style={s.estimateTime}>
                        {p.etaMs <= now + 60_000 ? t("home.dueNow") : `~${clockTime(p.etaMs)}`}
                      </span>
                    </div>
                  );
                })}
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
              <div style={s.topbar}>
                <button onClick={() => { buzz(); setMenu(true); }} style={s.iconBtn} aria-label={t("home.menu")}>
                  <MenuIcon size={22} />
                </button>
                <span style={s.topbarTitle}>{t("nav.timeline")}</span>
                <span style={{ width: 42 }} />
              </div>
              <Timeline entries={entries} onAdd={openAdd} onEdit={openEdit} onDelete={removeEntry} />
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
        elapsedMs={feedingElapsed}
        type={feedSel.type}
        method={feedSel.method}
        onType={selectType}
        onMethod={selectMethod}
        onDone={() => { buzz(); setSheet(null); }}
      />
      <DiaperSheet open={sheet?.type === "diaper"} onLog={logDiaper} />
      <EntrySheet target={editing} draft={draft} setDraft={(u) => setDraft((d) => (d ? u(d) : d))} onPickKind={pickKind} onSave={saveEdit} onDelete={deleteEditing} />

      {/* Toast — the only action feedback (no confirm dialogs), so announce it. */}
      <div role="status" aria-live="polite" style={{ ...s.toast, ...(toast ? s.toastOn : {}), ...(toast ? toastTone(toast.accent) : {}) }}>
        {toast?.msg}
      </div>
    </div>
  );
}
