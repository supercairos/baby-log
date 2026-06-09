/**
 * App data hooks — connection bootstrap, children, the optimistic running-timers view,
 * the merged timeline, plus small UI helpers (ticking clock, toast). Reads come from the
 * server (polled on focus/interval); writes go through the outbox (see `actions.ts`), and
 * the running-timers view merges the local outbox state so a just-started timer shows
 * instantly — online or offline.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type BabyBuddyClient,
  type Child,
  type Connection,
  type EntryPath,
  type FeedingMethod,
  type FeedingType,
  type LocalId,
  type TimelineEntry,
  type TimerActivityKey,
  allRecords,
  allTimerMappings,
  clearConnection,
  deleteTimerMapping,
  createBabyBuddyClient,
  listActiveTimers,
  listChildren,
  listEntriesInRange,
  listRecentEntries,
  loadConnection,
  saveConnection,
} from "../api";

// ── ticking clock ─────────────────────────────────────────────────────────────
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ── toast ───────────────────────────────────────────────────────────────────
export interface Toast {
  msg: string;
  accent?: string;
}
export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((msg: string, accent?: string, ms = 2000) => {
    setToast({ msg, accent });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), ms);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { toast, show };
}

// ── connection ────────────────────────────────────────────────────────────────
export type ConnectionState =
  | { status: "loading" }
  | { status: "out" }
  | { status: "in"; connection: Connection; client: BabyBuddyClient };

export function useConnection() {
  const [state, setState] = useState<ConnectionState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    (async () => {
      const conn = await loadConnection().catch(() => undefined);
      if (!alive) return;
      setState(conn ? { status: "in", connection: conn, client: createBabyBuddyClient(conn) } : { status: "out" });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const connect = useCallback(async (conn: Connection) => {
    await saveConnection(conn);
    setState({ status: "in", connection: conn, client: createBabyBuddyClient(conn) });
  }, []);

  const disconnect = useCallback(async () => {
    await clearConnection();
    setState({ status: "out" });
  }, []);

  return { state, connect, disconnect };
}

// ── children ──────────────────────────────────────────────────────────────────
const CHILD_KEY = "baby-log:child";

export function useChildren(client: BabyBuddyClient) {
  const [children, setChildren] = useState<Child[] | null>(null);
  const [error, setError] = useState(false);
  const [childId, setChildId] = useState<number | null>(() => {
    const v = localStorage.getItem(CHILD_KEY);
    return v ? Number(v) : null;
  });

  const refresh = useCallback(async () => {
    try {
      const list = await listChildren(client);
      setChildren(list);
      setError(false);
      setChildId((cur) => (cur && list.some((c) => c.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch {
      setError(true);
    }
  }, [client]);

  useEffect(() => {
    // Fetch-on-mount: synchronizing with the server is a valid effect use here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  const selectChild = useCallback((id: number) => {
    setChildId(id);
    localStorage.setItem(CHILD_KEY, String(id));
  }, []);

  return { children, childId, selectChild, error, refresh };
}

// ── running timers (server + optimistic local) ─────────────────────────────────
export interface RunningTimer {
  /** Stable React key. */
  key: string;
  localId?: LocalId;
  serverId?: number;
  activity: TimerActivityKey;
  startedMs: number;
  feeding?: { type?: FeedingType | null; method?: FeedingMethod | null };
}

async function computeRunning(client: BabyBuddyClient, childId: number): Promise<RunningTimer[]> {
  let serverOk = true;
  const [records, maps, server] = await Promise.all([
    allRecords(),
    allTimerMappings(),
    listActiveTimers(client, childId).catch(() => {
      serverOk = false; // offline / fetch failed → trust local state, don't reconcile away
      return [];
    }),
  ]);

  const pendingStops = new Set<LocalId>();
  for (const r of records) {
    if (r.dead) continue; // a dead (permanently-failed) stop never runs — it must not hide its timer
    const m = r.mutation;
    if (m.kind === "consume-feeding" || m.kind === "consume-sleep" || m.kind === "consume-tummy" || m.kind === "discard-timer") {
      pendingStops.add(m.localId);
    }
  }
  // Server timer ids the poll currently reports — the source of truth when it succeeded.
  const serverIds = new Set<number>();
  for (const ct of server) if (ct.timer.id != null) serverIds.add(ct.timer.id);

  const out: RunningTimer[] = [];
  const mappedServerIds = new Set<number>();
  // Optimistic local timers not yet assigned a serverId — used to suppress the duplicate
  // server card during the brief window between the timer POST and the serverId write.
  const unmappedLocal: { activity: TimerActivityKey; startedMs: number }[] = [];
  const stale: LocalId[] = []; // mappings the server dropped → prune after building the view
  for (const map of maps) {
    if (map.childId !== childId) continue;
    // Server wins: a mapping whose server timer the (successful) poll no longer lists was
    // stopped/deleted elsewhere — another caregiver, the Baby Buddy web UI, or another
    // device. Drop the phantom and forget the mapping instead of ticking forever. (A pending
    // local stop is handled just below; an un-flushed start — no serverId yet — is kept, so
    // an offline/in-flight start still shows.)
    if (map.serverId != null && serverOk && !serverIds.has(map.serverId) && !pendingStops.has(map.localId)) {
      stale.push(map.localId);
      continue;
    }
    if (map.serverId != null) mappedServerIds.add(map.serverId);
    if (pendingStops.has(map.localId)) continue; // stopped optimistically
    const startedMs = Date.parse(map.startedAt);
    if (map.serverId == null) unmappedLocal.push({ activity: map.activity, startedMs });
    out.push({ key: map.localId, localId: map.localId, serverId: map.serverId, activity: map.activity, startedMs, feeding: map.feeding });
  }
  // Best-effort prune so dropped mappings don't linger (notifications, the next poll).
  for (const localId of stale) void deleteTimerMapping(localId).catch(() => {});

  for (const ct of server) {
    if (ct.timer.id == null || mappedServerIds.has(ct.timer.id)) continue;
    const startedMs = ct.timer.start ? Date.parse(ct.timer.start) : Date.now();
    // Skip if this is our own just-started timer whose serverId hasn't been recorded yet.
    if (unmappedLocal.some((u) => u.activity === ct.activity && Math.abs(u.startedMs - startedMs) < 10_000)) continue;
    out.push({ key: `s${ct.timer.id}`, serverId: ct.timer.id, activity: ct.activity, startedMs });
  }
  return out.sort((a, b) => a.startedMs - b.startedMs);
}

/**
 * Running timers for a child — the optimistic local view merged with the server poll, kept
 * fresh by TanStack Query: it refetches every 15s (while visible), on window focus, and on
 * reconnect. So if another caregiver stops/deletes a timer, this phone drops it on the next
 * tick or the moment the app is refocused (the merge in `computeRunning` is what reconciles
 * it away — server wins). `refresh()` forces an immediate refetch after a local write.
 */
export function useRunningTimers(client: BabyBuddyClient, childId: number | null) {
  const qc = useQueryClient();
  const queryKey = ["running-timers", childId] as const;
  const { data } = useQuery({
    queryKey,
    enabled: childId != null,
    queryFn: () => computeRunning(client, childId as number),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    // computeRunning never throws (it falls back to the local view if the poll fails), so a
    // result is always a real merge — keep it as the displayed state.
    placeholderData: (prev) => prev,
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["running-timers", childId] });
  }, [qc, childId]);

  return { running: childId == null ? [] : (data ?? []), refresh };
}

// ── timeline ──────────────────────────────────────────────────────────────────
const tkey = (path: EntryPath, id: number) => `${path}#${id}`;

/**
 * The merged, newest-first timeline for a child, kept fresh by TanStack Query (refetch on a
 * 60s interval, on focus, and on reconnect) so another caregiver's edits show up here too.
 * Optimistically-deleted rows are tombstoned and filtered out of every refetch until the
 * server confirms they're gone — otherwise a poll landing before the DELETE propagates would
 * resurrect them.
 */
export function useTimeline(client: BabyBuddyClient, childId: number | null) {
  const qc = useQueryClient();
  const tombstones = useRef<Set<string>>(new Set());

  const { data } = useQuery({
    queryKey: ["timeline", childId],
    enabled: childId != null,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const fresh = await listRecentEntries(client, childId as number);
      // Drop tombstones the server now agrees are gone; keep suppressing the rest.
      for (const t of [...tombstones.current]) {
        if (!fresh.some((e) => tkey(e.path, e.id) === t)) tombstones.current.delete(t);
      }
      return fresh.filter((e) => !tombstones.current.has(tkey(e.path, e.id)));
    },
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["timeline", childId] });
  }, [qc, childId]);

  /** Optimistically drop a row (e.g. just deleted) and tombstone it so refetches keep it
   *  hidden until the server confirms the deletion. */
  const removeLocal = useCallback(
    (path: EntryPath, id: number) => {
      tombstones.current.add(tkey(path, id));
      qc.setQueryData<TimelineEntry[]>(["timeline", childId], (prev) =>
        prev ? prev.filter((e) => !(e.path === path && e.id === id)) : prev,
      );
    },
    [qc, childId],
  );

  return { entries: childId == null ? [] : (data ?? null), refresh, removeLocal };
}

/**
 * Entries overlapping a date window, for the calendar's day/week grids and summary. Keyed by the
 * range so navigating weeks fetches fresh data; shares the "calendar" prefix so a write can
 * invalidate every range at once. `enabled` lets the List mode skip the range fetch.
 */
export function useEntriesInRange(
  client: BabyBuddyClient,
  childId: number | null,
  fromMs: number,
  toMs: number,
  enabled = true,
) {
  const { data, isFetching } = useQuery({
    queryKey: ["calendar", childId, fromMs, toMs],
    enabled: childId != null && enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: () => listEntriesInRange(client, childId as number, fromMs, toMs),
    placeholderData: (prev) => prev,
  });
  return { entries: childId == null ? null : (data ?? null), loading: isFetching };
}

export function buzz(ms = 15): void {
  navigator?.vibrate?.(ms);
}

// ── PWA install ────────────────────────────────────────────────────────────────
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Captured at module load — `beforeinstallprompt` fires once, early (often before the drawer
// mounts), so we stash it here and let `usePwaInstall` subscribe whenever it renders.
let installPrompt: BeforeInstallPromptEvent | null = null;
const installSubs = new Set<() => void>();
const emitInstall = () => installSubs.forEach((fn) => fn());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // suppress Chrome's mini-infobar; we offer Install in the drawer
    installPrompt = e as BeforeInstallPromptEvent;
    emitInstall();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null; // installed → hide the action
    emitInstall();
  });
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * In-app "Install" affordance. `canInstall` is true only when the browser fired
 * `beforeinstallprompt` and the app isn't already installed — so the action stays hidden in
 * the installed PWA and on browsers that never fire it (notably iOS Safari, which installs
 * via the Share sheet instead). `promptInstall` shows the native chooser; the prompt is
 * single-use, so it's cleared afterward.
 */
export function usePwaInstall() {
  const [canInstall, setCanInstall] = useState(() => installPrompt !== null && !isStandalone());
  useEffect(() => {
    const update = () => setCanInstall(installPrompt !== null && !isStandalone());
    installSubs.add(update);
    update();
    return () => {
      installSubs.delete(update);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!installPrompt) return false;
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null; // a prompt can only be used once
    emitInstall();
    return outcome === "accepted";
  }, []);

  return { canInstall, promptInstall };
}
