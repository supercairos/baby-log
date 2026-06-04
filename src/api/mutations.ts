/**
 * Mutations — every write to Baby Buddy, expressed as a serializable command.
 *
 * Why commands instead of inline `fetch`: nursery wifi is flaky, so writes can't block
 * on the network. The UI builds a `Mutation`, drops it in the IndexedDB outbox
 * (`outbox.ts`), and updates optimistically. A worker drains the outbox against the
 * server with retry (`sync.ts`), so a write survives reload / backgrounding / app-kill /
 * being offline. Because a command is plain JSON, it round-trips through IndexedDB intact.
 *
 * The timer lifecycle is modelled with a client-generated `localId` so a start and its
 * later stop can be correlated entirely offline, before any server id exists:
 *   start-timer(localId) … consume-*(localId)
 * The flusher resolves `localId` → server timer id, or — if both halves are still queued
 * (the activity began and ended while offline) — coalesces them into one direct entry
 * create with explicit start/end, skipping the timer round-trip entirely.
 */
import type { TimerActivityKey, EntryPath } from "./activities";
import type {
  IsoDateTime,
  FeedingFields,
  SleepFields,
  TummyFields,
  DiaperFields,
  EntryPatch,
} from "./entries";
import { enqueue } from "./outbox";
import { requestOutboxSync } from "./sync";

/** Correlates a start-timer with its eventual consume/discard, before a server id exists. */
export type LocalId = string;

interface MutationBase {
  /** Stable id for dedupe/debugging (distinct from the outbox sequence number). */
  mutationId: string;
  /** When the user performed the action (client clock, ISO/UTC). */
  at: IsoDateTime;
}

export type Mutation =
  | (MutationBase & {
      kind: "start-timer";
      localId: LocalId;
      activity: TimerActivityKey;
      childId: number;
      /** The real moment the timer started — sent on flush so offline starts keep it. */
      startedAt: IsoDateTime;
    })
  | (MutationBase & {
      kind: "consume-feeding";
      localId: LocalId;
      childId: number;
      endedAt: IsoDateTime;
      fields: FeedingFields;
    })
  | (MutationBase & {
      kind: "consume-sleep";
      localId: LocalId;
      childId: number;
      endedAt: IsoDateTime;
      fields: SleepFields;
    })
  | (MutationBase & {
      kind: "consume-tummy";
      localId: LocalId;
      childId: number;
      endedAt: IsoDateTime;
      fields: TummyFields;
    })
  | (MutationBase & { kind: "discard-timer"; localId: LocalId })
  | (MutationBase & { kind: "log-diaper"; childId: number; fields: DiaperFields })
  | (MutationBase & {
      kind: "create-feeding";
      childId: number;
      start: IsoDateTime;
      end: IsoDateTime;
      fields: FeedingFields;
    })
  | (MutationBase & {
      kind: "create-sleep";
      childId: number;
      start: IsoDateTime;
      end: IsoDateTime;
      fields: SleepFields;
    })
  | (MutationBase & {
      kind: "create-tummy";
      childId: number;
      start: IsoDateTime;
      end: IsoDateTime;
      fields: TummyFields;
    })
  | (MutationBase & { kind: "update-entry"; serverId: number; patch: EntryPatch })
  | (MutationBase & { kind: "delete-entry"; serverId: number; path: EntryPath });

export type MutationKind = Mutation["kind"];
/** Kinds that reference a timer by `localId` (drive the create→consume dependency). */
export type TimerMutation = Extract<Mutation, { localId: LocalId }>;

function newId(): string {
  return crypto.randomUUID();
}

function nowIso(): IsoDateTime {
  return new Date().toISOString();
}

// ── Factories: build commands from UI intents (timestamps default to now) ─────

/** Begin a timed activity. Returns the command plus the `localId` to correlate its stop. */
export function startTimerMutation(
  activity: TimerActivityKey,
  childId: number,
  startedAt: IsoDateTime = nowIso(),
): { mutation: Mutation; localId: LocalId } {
  const localId = newId();
  return {
    localId,
    mutation: { kind: "start-timer", mutationId: newId(), at: startedAt, localId, activity, childId, startedAt },
  };
}

/**
 * Stop a timed activity (consume its timer into an entry). Overloaded per activity so the
 * compiler enforces the right fields — crucially, FEEDING requires `type`+`method` (the
 * server rejects a feeding without them, even when consuming a timer).
 */
export function consumeTimerMutation(activity: "feeding", localId: LocalId, childId: number, fields: FeedingFields, endedAt?: IsoDateTime): Mutation;
export function consumeTimerMutation(activity: "sleep", localId: LocalId, childId: number, fields?: SleepFields, endedAt?: IsoDateTime): Mutation;
export function consumeTimerMutation(activity: "tummy", localId: LocalId, childId: number, fields?: TummyFields, endedAt?: IsoDateTime): Mutation;
export function consumeTimerMutation(
  activity: TimerActivityKey,
  localId: LocalId,
  childId: number,
  fields: FeedingFields | SleepFields | TummyFields = {},
  endedAt: IsoDateTime = nowIso(),
): Mutation {
  const base = { mutationId: newId(), at: endedAt, localId, childId, endedAt };
  switch (activity) {
    // The overloads guarantee `fields` matches `activity`, so these casts are sound.
    case "feeding":
      return { ...base, kind: "consume-feeding", fields: fields as FeedingFields };
    case "sleep":
      return { ...base, kind: "consume-sleep", fields: fields as SleepFields };
    case "tummy":
      return { ...base, kind: "consume-tummy", fields: fields as TummyFields };
  }
}

export function discardTimerMutation(localId: LocalId): Mutation {
  return { kind: "discard-timer", mutationId: newId(), at: nowIso(), localId };
}

export function logDiaperMutation(childId: number, fields: DiaperFields): Mutation {
  return { kind: "log-diaper", mutationId: newId(), at: nowIso(), childId, fields };
}

// ── Backdated / manual timeline entries (no timer) ────────────────────────────

export function createFeedingMutation(childId: number, start: IsoDateTime, end: IsoDateTime, fields: FeedingFields): Mutation {
  return { kind: "create-feeding", mutationId: newId(), at: nowIso(), childId, start, end, fields };
}

export function createSleepMutation(childId: number, start: IsoDateTime, end: IsoDateTime, fields: SleepFields = {}): Mutation {
  return { kind: "create-sleep", mutationId: newId(), at: nowIso(), childId, start, end, fields };
}

export function createTummyMutation(childId: number, start: IsoDateTime, end: IsoDateTime, fields: TummyFields = {}): Mutation {
  return { kind: "create-tummy", mutationId: newId(), at: nowIso(), childId, start, end, fields };
}

export function updateEntryMutation(serverId: number, patch: EntryPatch): Mutation {
  return { kind: "update-entry", mutationId: newId(), at: nowIso(), serverId, patch };
}

export function deleteEntryMutation(serverId: number, path: EntryPath): Mutation {
  return { kind: "delete-entry", mutationId: newId(), at: nowIso(), serverId, path };
}

/**
 * Enqueue a mutation durably and nudge the background flush. This is the one write entry
 * point the UI should call; it returns once the command is persisted (optimistic UI can
 * paint immediately) — the worker handles getting it to the server.
 */
export async function enqueueMutation(mutation: Mutation): Promise<number> {
  const seq = await enqueue(mutation);
  void requestOutboxSync();
  return seq;
}

/** Short human label for toasts / outbox inspection. */
export function mutationLabel(m: Mutation): string {
  switch (m.kind) {
    case "start-timer":
      return `Start ${m.activity}`;
    case "consume-feeding":
      return "Log feeding";
    case "consume-sleep":
      return "Log sleep";
    case "consume-tummy":
      return "Log tummy time";
    case "discard-timer":
      return "Discard timer";
    case "log-diaper":
      return "Log diaper";
    case "create-feeding":
      return "Add feeding";
    case "create-sleep":
      return "Add sleep";
    case "create-tummy":
      return "Add tummy time";
    case "update-entry":
      return "Edit entry";
    case "delete-entry":
      return "Delete entry";
  }
}
