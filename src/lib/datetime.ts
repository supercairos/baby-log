/**
 * Locale-aware date & time display helpers. Kept separate from `format.ts` — which is
 * i18n-free because it's reachable from the service-worker bundle (via the outbox/clock) —
 * so the service worker never pulls in i18next/React. Greeting and Today/Yesterday are
 * translated; clock + long dates render in the active locale. See `src/i18n`.
 */
import i18n, { currentLocale } from "../i18n";

export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 5) return i18n.t("greeting.lateNight");
  if (h < 12) return i18n.t("greeting.morning");
  if (h < 18) return i18n.t("greeting.afternoon");
  if (h < 22) return i18n.t("greeting.evening");
  return i18n.t("greeting.lateNight");
}

export function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(currentLocale(), { hour: "numeric", minute: "2-digit" });
}

export function dayLabel(epochMs: number): string {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return i18n.t("day.today");
  if (diff === 1) return i18n.t("day.yesterday");
  return new Date(epochMs).toLocaleDateString(currentLocale(), { weekday: "long", month: "short", day: "numeric" });
}
