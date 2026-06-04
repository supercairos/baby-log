/**
 * Display labels + chooser option lists, derived from the typed feeding enums so they
 * can't drift from the schema. `metaFor*` produce the secondary line shown on cards/entries.
 */
import type { FeedingType, FeedingMethod, ActivityKey } from "../api";

export const FEED_TYPE_LABEL: Record<FeedingType, string> = {
  "breast milk": "Breast",
  formula: "Formula",
  "fortified breast milk": "Fortified",
  "solid food": "Solid",
};

export const FEED_METHOD_LABEL: Record<FeedingMethod, string> = {
  "left breast": "Left",
  "right breast": "Right",
  "both breasts": "Both",
  bottle: "Bottle",
  "parent fed": "Parent fed",
  "self fed": "Self fed",
};

export const ACTIVITY_LABEL: Record<ActivityKey, string> = {
  feeding: "Feeding",
  sleep: "Sleep",
  diaper: "Diaper",
  tummy: "Tummy time",
};

/** Ordered chooser options (chips) for feeding type. */
export const FEED_TYPE_OPTIONS = (Object.keys(FEED_TYPE_LABEL) as FeedingType[]).map((id) => ({
  id,
  label: FEED_TYPE_LABEL[id],
}));

/** Ordered chooser options for feeding method (full set; filter via METHODS_FOR_TYPE). */
export const FEED_METHOD_OPTIONS = (Object.keys(FEED_METHOD_LABEL) as FeedingMethod[]).map((id) => ({
  id,
  label: FEED_METHOD_LABEL[id],
}));

export function feedingMeta(type?: FeedingType | null, method?: FeedingMethod | null): string {
  return [type ? FEED_TYPE_LABEL[type] : null, method ? FEED_METHOD_LABEL[method] : null]
    .filter(Boolean)
    .join(" · ");
}

export function diaperMeta(wet: boolean, solid: boolean): string {
  if (wet && solid) return "Both";
  if (solid) return "Solid";
  if (wet) return "Wet";
  return "";
}
