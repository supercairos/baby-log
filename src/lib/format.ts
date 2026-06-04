/**
 * Display + time helpers. We store UTC ISO strings (server) and render in local time.
 * UI math is done in epoch-ms; `iso()`/`ms()` bridge to the API's ISO strings.
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

export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Late night";
}

export function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function dayLabel(epochMs: number): string {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(epochMs).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
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

/** Current time helpers — kept here (a non-component module) so component call sites stay
 *  pure under react-hooks/purity; the impure read is isolated to these wrappers. */
export function nowMs(): number {
  return Date.now();
}
export function nowIso(): string {
  return new Date().toISOString();
}
