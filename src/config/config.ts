/**
 * Runtime app config, injected by react-env (`@beam-australia/react-env`).
 *
 * `react-env` writes `public/env/__ENV.js` (`window.__ENV`) from `REACT_APP_*` environment
 * variables — at build (`build`/`build-docker`) and in dev. `env("FOO")` reads
 * `REACT_APP_FOO`. This keeps config out of the bundle so values can be set per environment.
 *
 * Never put secrets here — `__ENV.js` is a public static file. The Baby Buddy API token is
 * always entered by the user at login (QR / manual), never shipped via env.
 */
import env from "@beam-australia/react-env";

export const config = {
  /** Optional default Baby Buddy instance URL — pre-fills the manual login field. */
  babyBuddyUrl: env("BABYBUDDY_URL") ?? "",
};
