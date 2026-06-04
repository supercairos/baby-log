import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// App version baked in at build time (release-please bumps this on every release), surfaced
// in the drawer so it's clear which build is actually deployed.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
  version: string;
};

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.BABYBUDDY_BASE_URL || "https://babybuddy.la-ruche.info";
  // Deploy under a subpath (e.g. "/quick-ui/") by building with BASE_PATH set. Must have a
  // leading + trailing slash. Prefixes all assets, the manifest, and the SW scope. The API
  // stays root-relative (/api/) — Baby Buddy owns the domain root.
  const base = process.env.BASE_PATH || "/";

  return {
    base,
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [
      react(),
      VitePWA({
        // Build our own worker (outbox flush + Background Sync + offline shell), not a
        // generic Workbox one. `injectionPoint: undefined` disables Workbox precache
        // injection — the worker does its own caching (see service-worker.ts).
        strategies: "injectManifest",
        srcDir: "src/api",
        filename: "service-worker.ts",
        injectManifest: { injectionPoint: undefined },
        // Prompt (not autoUpdate): a new version waits and the app shows a "tap to refresh"
        // toast, so we never reload out from under a half-filled sheet. The page detects the
        // waiting worker via `useRegisterSW`; tapping posts SKIP_WAITING (handled in the SW).
        registerType: "prompt",
        injectRegister: "auto",
        manifest: {
          name: "Baby Log",
          short_name: "Baby Log",
          description: "A calmer way to track feeds, sleep, and changes — connected to your Baby Buddy.",
          theme_color: "#15121c",
          background_color: "#15121c",
          display: "standalone",
          orientation: "portrait",
          start_url: base,
          scope: base,
          // Relative srcs so vite-plugin-pwa prefixes them with `base`.
          icons: [
            { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
            { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
            { src: "pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
            { src: "pwa.svg", sizes: "any", type: "image/svg+xml" },
          ],
        },
        // The SW (precache/offline) is verified via `vite preview`; dev uses page autoflush.
        devOptions: { enabled: false },
      }),
    ],
    // The instance only sends CORS headers for allow-listed origins, so a browser at
    // localhost can't call it directly. In dev/preview we proxy /api same-origin and Vite
    // forwards it server-side (no CORS). In prod the app is served same-origin.
    server: { proxy: { "/api": { target, changeOrigin: true, secure: true } } },
    preview: { proxy: { "/api": { target, changeOrigin: true, secure: true } } },
  };
});
