/**
 * Connection: the persisted identity of a Baby Buddy instance + credentials.
 *
 * Two shapes live here:
 *  - `LoginPayload` — the exact on-the-wire shape encoded in the "Add a device" QR
 *    (`BABYBUDDY-LOGIN:{...}`), snake_case, straight from Baby Buddy source.
 *  - `Connection` — the app-internal, camelCase shape we persist and pass around.
 *
 * Keeping them separate means the QR/manual parsing is a clean, lossless swap and the
 * rest of the app never deals with snake_case.
 */

/** On-the-wire payload encoded in the Baby Buddy login QR code. */
export interface LoginPayload {
  url: string;
  api_key: string;
  /** `{}` for normal deployments; an `ingress_session` cookie behind Home Assistant ingress. */
  session_cookies?: Record<string, string>;
}

/** App-internal connection state. `url` always ends in a single trailing slash. */
export interface Connection {
  /** Server base, trailing slash guaranteed, e.g. `https://babybuddy.example.com/`. */
  url: string;
  /** DRF token sent as `Authorization: Token <apiKey>`. */
  apiKey: string;
  /** Non-empty only behind Home Assistant ingress. */
  sessionCookies: Record<string, string>;
}

const LOGIN_PREFIX = "BABYBUDDY-LOGIN:";

/**
 * Normalize a user-typed server address into a base URL ending in exactly one `/`.
 * Adds `https://` when no scheme is present (mirrors the mockup's manual-entry rule).
 */
export function normalizeBaseUrl(input: string): string {
  let u = input.trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, "") + "/";
}

/**
 * Parse the decoded text of a Baby Buddy login QR code into a `Connection`.
 * Returns `null` for anything that isn't a well-formed `BABYBUDDY-LOGIN:` payload,
 * so callers can treat "not a login code" and "garbage" identically.
 */
export function parseLoginQr(text: string): Connection | null {
  if (!text || !text.startsWith(LOGIN_PREFIX)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(LOGIN_PREFIX.length));
  } catch {
    return null;
  }
  return connectionFromPayload(payload);
}

/** Build a `Connection` from a parsed login payload (validates required fields). */
export function connectionFromPayload(payload: unknown): Connection | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Partial<LoginPayload>;
  if (typeof p.url !== "string" || !p.url) return null;
  if (typeof p.api_key !== "string" || !p.api_key) return null;
  return {
    url: normalizeBaseUrl(p.url),
    apiKey: p.api_key,
    sessionCookies: isStringRecord(p.session_cookies) ? p.session_cookies : {},
  };
}

/** Build a `Connection` from manual server-URL + token entry. */
export function connectionFromManual(url: string, apiKey: string): Connection {
  return { url: normalizeBaseUrl(url), apiKey: apiKey.trim(), sessionCookies: {} };
}

/** REST API base for a connection, e.g. `https://host/api/`. */
export function apiBase(conn: Connection): string {
  return `${conn.url}api/`;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.values(v).every((x) => typeof x === "string")
  );
}
