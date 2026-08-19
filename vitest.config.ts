/**
 * Test config, deliberately separate from `vite.config.ts`: the suite covers the pure logic
 * layer, so it needs neither the React plugin nor the PWA/service-worker build.
 *
 * TZ and locale are PINNED. Half of what's under test is date arithmetic across local day
 * boundaries — "does this deadline fall today?", "does the year need showing?" — which would
 * otherwise pass or fail depending on the machine running it. Europe/Paris matches the
 * instance these were written against; `currentLocale` is stubbed per-file where it matters.
 */
process.env.TZ ??= "Europe/Paris";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The logic layer is i18n-free by design (see lib/format.ts's header); the few modules
    // that aren't stub `../i18n` themselves rather than dragging in a DOM.
    globals: false,
  },
});
