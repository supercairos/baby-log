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
import type { TimerActivityKey } from "../api";
import { activityLabel, feedingMeta } from "../lib/labels";
import { clockTime } from "../lib/datetime";
import i18n from "../i18n";

const TAG_PREFIX = "timer:";
// `badge` is the small monochrome status-bar glyph. `icon` is the large circle — Android always
// draws that circle (filling it with a generated initial if empty), so rather than leave it
// blank we give it a per-activity icon: it shows what's running (bottle / moon / figure) and is
// distinct from the small app icon for sleep & tummy.
const BADGE = `${import.meta.env.BASE_URL}badge-mono.png`;
const ICON: Record<TimerActivityKey, string> = {
  feeding: `${import.meta.env.BASE_URL}notif-feeding.png`,
  sleep: `${import.meta.env.BASE_URL}notif-sleep.png`,
  tummy: `${import.meta.env.BASE_URL}notif-tummy.png`,
};

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

/** Reconcile notifications with the current running timers: show/refresh each, close removed.
 *  `childName` (the selected child these timers belong to) is shown in the title. */
export async function syncTimerNotifications(
  running: RunningTimer[],
  childId: number | null,
  childName: string | null,
): Promise<void> {
  if (!notificationsGranted()) return;
  const reg = await readyRegistration();
  if (!reg) return;

  const wanted = new Set(running.map((rt) => TAG_PREFIX + rt.key));
  // Close notifications for timers that are no longer running, and remember which are already
  // on screen so we don't re-show (and thus re-alert) them on every ~15s poll — we only fire
  // a fresh notification the first time a timer appears (or after the user dismisses it).
  const onScreen = new Set<string>();
  for (const n of await reg.getNotifications()) {
    if (!n.tag.startsWith(TAG_PREFIX)) continue;
    if (wanted.has(n.tag)) onScreen.add(n.tag);
    else n.close();
  }

  for (const rt of running) {
    if (onScreen.has(TAG_PREFIX + rt.key)) continue;
    const meta = rt.activity === "feeding" ? feedingMeta(rt.feeding?.type, rt.feeding?.method) : "";
    const options = {
      tag: TAG_PREFIX + rt.key,
      body: meta
        ? i18n.t("notif.startedMeta", { time: clockTime(rt.startedMs), meta })
        : i18n.t("notif.started", { time: clockTime(rt.startedMs) }),
      icon: ICON[rt.activity],
      badge: BADGE,
      // NOT silent: on Android a silent notification skips the heads-up banner and sound and
      // lands quietly in the shade — easy to miss. No spam, because the loop above only reaches
      // here for timers not already on screen, so each running timer alerts exactly once.
      renotify: false,
      requireInteraction: true, // stays in the tray after the app closes
      actions: [{ action: "stop", title: i18n.t("notif.stop") }],
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
    const activity = activityLabel(rt.activity);
    const title = childName
      ? i18n.t("notif.runningFor", { name: childName, activity })
      : i18n.t("notif.running", { activity });
    await reg.showNotification(title, options);
  }
}

export async function clearTimerNotifications(): Promise<void> {
  const reg = await readyRegistration();
  if (!reg) return;
  for (const n of await reg.getNotifications()) if (n.tag.startsWith(TAG_PREFIX)) n.close();
}

// ── Nap-window alert ──────────────────────────────────────────────────────────
const NAP_TAG = "nap-window";

/**
 * One-shot "nap window approaching" notification (fired by the page ~10 min before the
 * predicted sleep onset). Tagged so repeats replace rather than stack; tapping it just opens
 * the app (the SW's default click path).
 */
export async function showNapNotification(etaMs: number, childName: string | null): Promise<void> {
  if (!notificationsGranted()) return;
  const reg = await readyRegistration();
  if (!reg) return;
  const title = childName ? i18n.t("notif.napTitleFor", { name: childName }) : i18n.t("notif.napTitle");
  await reg.showNotification(title, {
    tag: NAP_TAG, // same tag replaces a previous nap alert instead of stacking
    body: i18n.t("notif.napBody", { time: clockTime(etaMs) }),
    icon: ICON.sleep,
    badge: BADGE,
    data: { kind: "nap" as const },
  });
}
