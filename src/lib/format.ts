/**
 * Time math + non-localized formatting. Intentionally i18n-free: this module is reachable
 * from the service-worker bundle (the outbox uses `nowIso`, the client uses
 * `setServerClockOffset`), so it must not import i18next. Locale-aware display lives in
 * `datetime.ts`.
 */

/** Elapsed/duration as `h:mm:ss` or `m:ss`. */
export function fmt(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Epoch ms → value for an `<input type="datetime-local">` (local wall-clock, no tz suffix). */
export function toLocalInput(epochMs: number): string {
  if (Number.isNaN(epochMs)) return ""; // a cleared field, don't render "NaN-NaN-…"
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): number {
  return new Date(value).getTime();
}

/** Epoch ms → UTC ISO string for the API. */
export function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** ISO string (or null) → epoch ms (or null). */
export function ms(isoString: string | null | undefined): number | null {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  return Number.isNaN(t) ? null : t;
}

/**
 * Server-clock correction. A device whose clock runs ahead of the Baby Buddy server makes it
 * reject "future" start/end times ("La date/heure ne peut pas être dans le futur"). We learn
 * the offset from API responses' `Date` header (set in client.ts) and bias every generated
 * timestamp onto the server's clock. That header is second-precision and arrives after network
 * latency, so the corrected time lands at or just behind the server's — never in its future.
 */
let clockOffsetMs = 0;
export function setServerClockOffset(offsetMs: number): void {
  clockOffsetMs = offsetMs;
}

/** Current time helpers — kept here (a non-component module) so component call sites stay
 *  pure under react-hooks/purity; the impure read is isolated to these wrappers. Both apply
 *  the server-clock offset, so writes never carry a device-skewed future timestamp. */
export function nowMs(): number {
  return Date.now() + clockOffsetMs;
}
export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}
