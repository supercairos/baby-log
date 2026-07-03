/**
 * Display labels + chooser option lists, derived from the typed feeding enums so they can't
 * drift from the schema. Labels are resolved through i18next (see `src/i18n`) so they follow
 * the active language; components re-render on a language change via `useTranslation`, and
 * these helpers (and the meta builders) read the current translation each call.
 */
import type { FeedingType, FeedingMethod, MedicationUnit, ActivityKey } from "../api";
import i18n from "../i18n";

/**
 * Chooser chips deliberately FOLD "fortified breast milk" into the formula chip — to a
 * parent both are "prepared milk in a bottle", and two near-identical chips slow the pick.
 * Legacy fortified entries (other clients, old logs) keep their type and display label;
 * the formula chip lights up for them (see `feedTypeChipMatches`) and only an explicit
 * tap rewrites the type to formula.
 */
const FEED_TYPE_CHOICES: FeedingType[] = ["breast milk", "formula", "solid food"];
const FEED_METHODS: FeedingMethod[] = ["left breast", "right breast", "both breasts", "bottle", "parent fed", "self fed"];

export const feedTypeLabel = (type: FeedingType): string => i18n.t(`feedType.${type}`);
export const feedMethodLabel = (method: FeedingMethod): string => i18n.t(`feedMethod.${method}`);
export const activityLabel = (activity: ActivityKey): string => i18n.t(`activity.${activity}`);

/** Ordered chooser options (chips) for feeding type. */
export const feedTypeOptions = (): { id: FeedingType; label: string }[] =>
  FEED_TYPE_CHOICES.map((id) => ({ id, label: feedTypeLabel(id) }));

/** Whether a chooser chip represents the given (possibly legacy) feeding type. */
export const feedTypeChipMatches = (chip: FeedingType, type: FeedingType | null | undefined): boolean =>
  type === chip || (chip === "formula" && type === "fortified breast milk");

/** Ordered chooser options for feeding method (full set; filter via METHODS_FOR_TYPE). */
export const feedMethodOptions = (): { id: FeedingMethod; label: string }[] =>
  FEED_METHODS.map((id) => ({ id, label: feedMethodLabel(id) }));

export function feedingMeta(type?: FeedingType | null, method?: FeedingMethod | null, amount?: number | null): string {
  return [type ? feedTypeLabel(type) : null, method ? feedMethodLabel(method) : null, amount != null ? `${amount} ml` : null]
    .filter(Boolean)
    .join(" · ");
}

export function diaperMeta(wet: boolean, solid: boolean): string {
  if (wet && solid) return i18n.t("diaper.both");
  if (solid) return i18n.t("diaper.solid");
  if (wet) return i18n.t("diaper.wet");
  return "";
}

export const medUnitLabel = (unit: MedicationUnit): string => i18n.t(`medUnit.${unit}`);

/** Meta line for a medication entry: "Paracetamol · 2.5 ml". */
export function medicationMeta(name: string, dosage?: number | null, unit?: MedicationUnit | null): string {
  const dose = dosage != null ? `${dosage}${unit ? ` ${medUnitLabel(unit)}` : ""}` : null;
  return [name.trim() || null, dose].filter(Boolean).join(" · ");
}
