/**
 * App data hooks — connection bootstrap, children, the optimistic running-timers view,
 * the merged timeline, plus small UI helpers (ticking clock, toast). Reads come from the
 * server (polled on focus/interval); writes go through the outbox (see `actions.ts`), and
 * the running-timers view merges the local outbox state so a just-started timer shows
 * instantly — online or offline.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  createBabyBuddyClient,
  listActiveTimers,
  listChildren,
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
  const show = useCallback((msg: string, accent?: string) => {
    setToast({ msg, accent });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2000);
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
  const [records, maps, server] = await Promise.all([
    allRecords(),
    allTimerMappings(),
    listActiveTimers(client, childId).catch(() => []),
  ]);

  const pendingStops = new Set<LocalId>();
  for (const r of records) {
    const m = r.mutation;
    if (m.kind === "consume-feeding" || m.kind === "consume-sleep" || m.kind === "consume-tummy" || m.kind === "discard-timer") {
      pendingStops.add(m.localId);
    }
  }

  const out: RunningTimer[] = [];
  const mappedServerIds = new Set<number>();
  // Optimistic local timers not yet assigned a serverId — used to suppress the duplicate
  // server card during the brief window between the timer POST and the serverId write.
  const unmappedLocal: { activity: TimerActivityKey; startedMs: number }[] = [];
  for (const map of maps) {
    if (map.childId !== childId) continue;
    if (map.serverId != null) mappedServerIds.add(map.serverId);
    if (pendingStops.has(map.localId)) continue; // stopped optimistically
    const startedMs = Date.parse(map.startedAt);
    if (map.serverId == null) unmappedLocal.push({ activity: map.activity, startedMs });
    out.push({ key: map.localId, localId: map.localId, serverId: map.serverId, activity: map.activity, startedMs, feeding: map.feeding });
  }
  for (const ct of server) {
    if (ct.timer.id == null || mappedServerIds.has(ct.timer.id)) continue;
    const startedMs = ct.timer.start ? Date.parse(ct.timer.start) : Date.now();
    // Skip if this is our own just-started timer whose serverId hasn't been recorded yet.
    if (unmappedLocal.some((u) => u.activity === ct.activity && Math.abs(u.startedMs - startedMs) < 10_000)) continue;
    out.push({ key: `s${ct.timer.id}`, serverId: ct.timer.id, activity: ct.activity, startedMs });
  }
  return out.sort((a, b) => a.startedMs - b.startedMs);
}

/** Poll + optimistic running timers for a child. Refresh on focus, online, interval. */
export function useRunningTimers(client: BabyBuddyClient, childId: number | null) {
  const [running, setRunning] = useState<RunningTimer[]>([]);

  const refresh = useCallback(async () => {
    if (childId == null) {
      setRunning([]);
      return;
    }
    try {
      setRunning(await computeRunning(client, childId));
    } catch {
      /* keep last view */
    }
  }, [client, childId]);

  useEffect(() => {
    // Fetch-on-mount: synchronizing with the server is a valid effect use here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(refresh, 30_000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { running, refresh };
}

// ── timeline ──────────────────────────────────────────────────────────────────
export function useTimeline(client: BabyBuddyClient, childId: number | null) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  // Optimistically-deleted rows, suppressed from every refetch until the server confirms
  // they're gone — otherwise a poll landing before the DELETE propagates resurrects them.
  const tombstones = useRef<Set<string>>(new Set());
  const tkey = (path: EntryPath, id: number) => `${path}#${id}`;

  const refresh = useCallback(
    async (reset = false) => {
      if (childId == null) {
        setEntries([]);
        return;
      }
      if (reset) setEntries(null); // show the loader when switching child
      try {
        const fresh = await listRecentEntries(client, childId);
        // Drop tombstones the server now agrees are gone; keep suppressing the rest.
        for (const t of [...tombstones.current]) {
          if (!fresh.some((e) => tkey(e.path, e.id) === t)) tombstones.current.delete(t);
        }
        setEntries(fresh.filter((e) => !tombstones.current.has(tkey(e.path, e.id))));
      } catch {
        /* keep stale entries on transient failure */
      }
    },
    [client, childId],
  );

  const reload = useCallback(() => void refresh(), [refresh]);

  useEffect(() => {
    // Fetch-on-mount + reset when child changes: synchronizing with the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(reload, 60_000);
    const onVisible = () => document.visibilityState === "visible" && reload();
    window.addEventListener("online", reload);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", reload);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  /** Optimistically drop a row (e.g. just deleted) and tombstone it so refetches keep it
   *  hidden until the server confirms the deletion. */
  const removeLocal = useCallback((path: EntryPath, id: number) => {
    tombstones.current.add(tkey(path, id));
    setEntries((prev) => (prev ? prev.filter((e) => !(e.path === path && e.id === id)) : prev));
  }, []);

  return { entries, refresh, removeLocal };
}

export function buzz(ms = 15): void {
  navigator?.vibrate?.(ms);
}
