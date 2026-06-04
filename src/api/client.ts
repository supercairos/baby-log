/**
 * Typed HTTP client over the generated Baby Buddy OpenAPI types.
 *
 * `openapi-fetch` consumes the generated `paths` and gives us fully-typed
 * path/params/body/response with ~no hand-written glue — the "small typed layer on top
 * of the generated types" the project calls for.
 */
import createClient from "openapi-fetch";
import type { paths } from "./generated/schema";
import type { Connection } from "./connection";
import { listChildren, type Child } from "./children";
import { BabyBuddyApiError } from "./errors";

/** Fully-typed Baby Buddy client (derived from the factory to stay version-proof). */
export type BabyBuddyClient = ReturnType<typeof createBabyBuddyClient>;

/**
 * Create a typed client bound to one connection.
 *
 * `baseUrl` is the origin with the trailing slash stripped so the generated absolute
 * paths (`/api/timers/`, …) concatenate cleanly — and sub-path installs
 * (`https://host/babybuddy/`) still resolve to `https://host/babybuddy/api/...`.
 */
export function createBabyBuddyClient(conn: Connection) {
  const hasIngressCookies = Object.keys(conn.sessionCookies).length > 0;

  // The app is served SAME-ORIGIN with the instance (in prod it's deployed on the same
  // host; in dev the Vite proxy forwards /api there), so API calls are relative — no CORS,
  // and it works identically in the page and the service worker. The connection's `url` is
  // kept for identity/QR, not for routing.
  const client = createClient<paths>({
    baseUrl: "",
    // Auth is the Token header alone, so DON'T send cookies. This matters because the app is
    // served SAME-ORIGIN with Baby Buddy: if the user is also signed into the Baby Buddy web
    // UI, the browser holds a `sessionid` cookie for this origin and would attach it to every
    // /api call. Django REST Framework then activates SessionAuthentication, which ENFORCES
    // CSRF on unsafe methods — and we send no CSRF token, so every POST/PATCH/DELETE 403s
    // ("CSRF Failed") while GETs (CSRF-exempt) still work. `omit` keeps it pure Token auth.
    // The exception is Home Assistant ingress, where the `ingress_session` cookie must ride
    // along for the proxy to route at all.
    credentials: hasIngressCookies ? "include" : "omit",
  });

  client.use({
    onRequest({ request }) {
      request.headers.set("Authorization", `Token ${conn.apiKey}`);
      // Browsers forbid setting the `Cookie` header, so this only takes effect in
      // non-browser contexts (service worker / Node). For in-browser ingress, the
      // browser's own cookie jar + `credentials: "include"` carries the session.
      if (hasIngressCookies) {
        const cookie = Object.entries(conn.sessionCookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
        try {
          request.headers.set("Cookie", cookie);
        } catch {
          /* forbidden header in browsers — ignored */
        }
      }
      return request;
    },
  });

  return client;
}

/** Outcome of a connection check. */
export type ConnectionCheck =
  | { ok: true; children: Child[] }
  | { ok: false; status: number; reason: "unauthorized" | "unreachable" | "error" };

/**
 * Validate a connection by listing children (`GET /api/children/`), the canonical
 * cheap authenticated call. Distinguishes bad-token (401/403) from network failure so
 * the login screen can show the right message.
 */
export async function validateConnection(conn: Connection): Promise<ConnectionCheck> {
  try {
    const children = await listChildren(createBabyBuddyClient(conn));
    return { ok: true, children };
  } catch (err) {
    if (err instanceof BabyBuddyApiError) {
      return {
        ok: false,
        status: err.status,
        reason: err.status === 401 || err.status === 403 ? "unauthorized" : "error",
      };
    }
    return { ok: false, status: 0, reason: "unreachable" }; // network/CORS/DNS
  }
}
