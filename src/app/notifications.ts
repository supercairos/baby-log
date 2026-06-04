/**
 * Running-timer notifications. The page shows one persistent service-worker notification per
 * running timer, each with a "Stop" action button. `requireInteraction` keeps it in the OS
 * notification center even after the app is closed; the service worker handles the Stop tap
 * (enqueue consume + flush) — see service-worker.ts.
 *
 * No push server needed: notifications are shown while the app runs and persist afterwards.
 * They don't live-tick (a PWA limitation) — the body shows the start time. On iOS the action
 * button may not render (tapping opens the app instead); Android/desktop Chrome show "Stop".
 */
import type { RunningTimer } from "./hooks";
import { ACTIVITY_LABEL, feedingMeta } from "../lib/labels";
import { clockTime } from "../lib/format";

const TAG_PREFIX = "timer:";
const ICON = `${import.meta.env.BASE_URL}pwa-192.png`;

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
}

export function notificationsGranted(): boolean {
  return notificationsSupported() && Notification.permission === "granted";
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  return (await Notification.requestPermission()) === "granted";
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  // Only once a SW controls the page (prod/preview); avoids hanging on `.ready` in dev.
  if (!notificationsSupported() || !navigator.serviceWorker.controller) return null;
  return navigator.serviceWorker.ready.catch(() => null);
}

/** Reconcile notifications with the current running timers: show/refresh each, close removed. */
export async function syncTimerNotifications(running: RunningTimer[], childId: number | null): Promise<void> {
  if (!notificationsGranted()) return;
  const reg = await readyRegistration();
  if (!reg) return;

  const wanted = new Set(running.map((rt) => TAG_PREFIX + rt.key));
  for (const n of await reg.getNotifications()) {
    if (n.tag.startsWith(TAG_PREFIX) && !wanted.has(n.tag)) n.close();
  }

  for (const rt of running) {
    const meta = rt.activity === "feeding" ? feedingMeta(rt.feeding?.type, rt.feeding?.method) : "";
    const options = {
      tag: TAG_PREFIX + rt.key,
      body: `Started ${clockTime(rt.startedMs)}${meta ? ` · ${meta}` : ""} — tap Stop to log.`,
      icon: ICON,
      badge: ICON,
      silent: true, // ambient reminder; don't buzz on every poll refresh
      renotify: false,
      requireInteraction: true, // stays in the tray after the app closes
      actions: [{ action: "stop", title: "Stop" }],
      data: {
        kind: "timer" as const,
        activity: rt.activity,
        childId,
        localId: rt.localId,
        serverId: rt.serverId,
        startedAt: new Date(rt.startedMs).toISOString(),
        feeding: rt.feeding,
      },
    };
    await reg.showNotification(`${ACTIVITY_LABEL[rt.activity]} running`, options);
  }
}

export async function clearTimerNotifications(): Promise<void> {
  const reg = await readyRegistration();
  if (!reg) return;
  for (const n of await reg.getNotifications()) if (n.tag.startsWith(TAG_PREFIX)) n.close();
}
