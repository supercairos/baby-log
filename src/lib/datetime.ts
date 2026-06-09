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

/**
 * Precise, locale-aware child age from a `YYYY-MM-DD` birth date: the two most significant
 * non-zero units (years+months ≥2y, months+weeks ≥1mo, else weeks+days). Uses `Intl` unit
 * formatting so plurals/labels are correct per language without any translation strings.
 */
export function formatAge(birthDate: string, now: Date = new Date()): string {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  if (!by || !bm || !bd) return "";
  const loc = currentLocale();
  const unit = (value: number, u: "year" | "month" | "week" | "day") =>
    new Intl.NumberFormat(loc, { style: "unit", unit: u, unitDisplay: "long" }).format(value);
  const join = (parts: string[]) =>
    new Intl.ListFormat(loc, { style: "long", type: "unit" }).format(parts.filter(Boolean));

  let years = now.getFullYear() - by;
  let months = now.getMonth() + 1 - bm;
  let days = now.getDate() - bd;
  if (days < 0) {
    months -= 1;
    days += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); // days in the previous month
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  const totalMonths = years * 12 + months;

  if (totalMonths >= 24) return join([unit(years, "year"), months ? unit(months, "month") : ""]);
  if (totalMonths >= 1) return join([unit(totalMonths, "month"), days >= 7 ? unit(Math.floor(days / 7), "week") : ""]);

  const totalDays = Math.max(0, Math.floor((now.getTime() - new Date(by, bm - 1, bd).getTime()) / 86_400_000));
  if (totalDays >= 7) return join([unit(Math.floor(totalDays / 7), "week"), totalDays % 7 ? unit(totalDays % 7, "day") : ""]);
  return unit(totalDays, "day");
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
