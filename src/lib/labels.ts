/**
 * Display labels + chooser option lists, derived from the typed feeding enums so they can't
 * drift from the schema. Labels are resolved through i18next (see `src/i18n`) so they follow
 * the active language; components re-render on a language change via `useTranslation`, and
 * these helpers (and the meta builders) read the current translation each call.
 */
import type { FeedingType, FeedingMethod, ActivityKey } from "../api";
import i18n from "../i18n";

const FEED_TYPES: FeedingType[] = ["breast milk", "formula", "fortified breast milk", "solid food"];
const FEED_METHODS: FeedingMethod[] = ["left breast", "right breast", "both breasts", "bottle", "parent fed", "self fed"];

export const feedTypeLabel = (type: FeedingType): string => i18n.t(`feedType.${type}`);
export const feedMethodLabel = (method: FeedingMethod): string => i18n.t(`feedMethod.${method}`);
export const activityLabel = (activity: ActivityKey): string => i18n.t(`activity.${activity}`);

/** Ordered chooser options (chips) for feeding type. */
export const feedTypeOptions = (): { id: FeedingType; label: string }[] =>
  FEED_TYPES.map((id) => ({ id, label: feedTypeLabel(id) }));

/** Ordered chooser options for feeding method (full set; filter via METHODS_FOR_TYPE). */
export const feedMethodOptions = (): { id: FeedingMethod; label: string }[] =>
  FEED_METHODS.map((id) => ({ id, label: feedMethodLabel(id) }));

export function feedingMeta(type?: FeedingType | null, method?: FeedingMethod | null): string {
  return [type ? feedTypeLabel(type) : null, method ? feedMethodLabel(method) : null]
    .filter(Boolean)
    .join(" · ");
}

export function diaperMeta(wet: boolean, solid: boolean): string {
  if (wet && solid) return i18n.t("diaper.both");
  if (solid) return i18n.t("diaper.solid");
  if (wet) return i18n.t("diaper.wet");
  return "";
}
