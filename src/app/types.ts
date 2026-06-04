import type { ActivityKey, EntryPath, FeedingType, FeedingMethod } from "../api";

/** Working copy of an entry in the add/edit sheet (epoch-ms times). */
export interface EditDraft {
  type: FeedingType | null;
  method: FeedingMethod | null;
  wet: boolean;
  solid: boolean;
  startMs: number;
  endMs: number | null;
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
