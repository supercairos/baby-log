import type { ActivityKey, EntryPath, FeedingType, FeedingMethod, MedicationUnit } from "../api";

/** Working copy of an entry in the add/edit sheet (epoch-ms times). */
export interface EditDraft {
  type: FeedingType | null;
  method: FeedingMethod | null;
  /** Bottle amount in ml (feeding only; null = not recorded / cleared). */
  amount: number | null;
  wet: boolean;
  solid: boolean;
  /** Medication name (medication only). */
  medName: string;
  /** Medication dose (medication only; null = not recorded). */
  dosage: number | null;
  /** Medication dose unit (medication only; null = none chosen). */
  dosageUnit: MedicationUnit | null;
  /** Medication minimum gap before next dose, in ms (medication only; null = none set). */
  nextDoseMs: number | null;
  startMs: number;
  endMs: number | null;
  /** Free-text note. Maps to `notes` for feeding/sleep/diaper, and to `milestone` for tummy
   *  (the only free-text column tummy-time has server-side). */
  notes: string;
}

/** A recently-used medication, for one-tap "repeat last dose" chips (derived from the timeline). */
export interface RecentMed {
  name: string;
  dosage: number | null;
  dosageUnit: MedicationUnit | null;
  /** Remembered minimum gap before next dose, in ms (null = none recorded). */
  nextDoseMs: number | null;
}

/** What the add/edit sheet is operating on. */
export interface EditTarget {
  isNew: boolean;
  /** null while adding and the activity hasn't been picked yet. */
  activity: ActivityKey | null;
  /** Present when editing an existing server entry. */
  serverId?: number;
  path?: EntryPath;
}
