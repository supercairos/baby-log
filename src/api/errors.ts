/**
 * Error types for the API layer.
 *
 * `openapi-fetch` never throws — it returns `{ data, error, response }`. We funnel
 * failures through `unwrap()` into a single `BabyBuddyApiError` so callers get one
 * `try/catch` shape, plus a typed subclass for the one race we expect to handle
 * gracefully (consuming a timer another caregiver already stopped).
 */

/** A non-2xx response from Baby Buddy, carrying the parsed DRF error body. */
export class BabyBuddyApiError extends Error {
  readonly status: number;
  /** Parsed JSON error body (DRF field-errors object, a detail string, or null). */
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Baby Buddy API error (HTTP ${status})`);
    this.name = "BabyBuddyApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Thrown when consuming a timer that no longer exists — i.e. another device already
 * stopped (and thus deleted) it. Verified shape on v2.9.2:
 *   400 { "timer": ["Invalid pk \"11\" - object does not exist."] }
 * The signal is the `timer` field key, NOT any particular message string.
 *
 * Callers should treat this as "the activity was already logged" and re-fetch rather
 * than surface a failure.
 */
export class TimerAlreadyConsumedError extends BabyBuddyApiError {
  constructor(body: unknown) {
    super(400, body, "Timer no longer exists — it was already stopped on another device.");
    this.name = "TimerAlreadyConsumedError";
  }
}

/** Result shape returned by every `openapi-fetch` call. */
export interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Return `data` on success, otherwise throw a `BabyBuddyApiError`. */
export function unwrap<T>(res: FetchResult<T>): T {
  if (!res.response.ok || res.error !== undefined) {
    throw new BabyBuddyApiError(res.response.status, res.error ?? res.data ?? null);
  }
  return res.data as T;
}

/**
 * A short, human-readable reason for a failed API call — for surfacing in a toast. Pulls the
 * DRF message out of the error body (a `detail` string, or the first field-error like
 * `{ start: ["…can't be in the future"] }`), else falls back to the status.
 */
export function describeApiError(err: unknown): string {
  if (err instanceof BabyBuddyApiError) {
    const body = err.body;
    if (typeof body === "string" && body.trim()) return body;
    if (body && typeof body === "object") {
      const rec = body as Record<string, unknown>;
      if (typeof rec.detail === "string") return rec.detail;
      for (const v of Object.values(rec)) {
        if (Array.isArray(v) && typeof v[0] === "string") return v[0];
        if (typeof v === "string" && v) return v;
      }
    }
    if (err.status === 401 || err.status === 403) return "Not authorized — check your token.";
    return `Server rejected the request (HTTP ${err.status}).`;
  }
  return "Network error — you appear to be offline or the server is unreachable.";
}

/**
 * True when a 400 body is the "timer no longer exists" validation error
 * (a `timer` field error array). Used to detect the multi-caregiver stop race.
 */
export function isTimerGoneError(err: unknown): boolean {
  if (!(err instanceof BabyBuddyApiError) || err.status !== 400) return false;
  const body = err.body;
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as Record<string, unknown>).timer)
  );
}
