import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.BABYBUDDY_BASE_URL || "https://babybuddy.la-ruche.info";

  return {
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
        registerType: "autoUpdate",
        injectRegister: "auto",
        manifest: {
          name: "Baby Log",
          short_name: "Baby Log",
          description: "A calmer way to track feeds, sleep, and changes — connected to your Baby Buddy.",
          theme_color: "#15121c",
          background_color: "#15121c",
          display: "standalone",
          orientation: "portrait",
          start_url: "/",
          scope: "/",
          icons: [
            { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
            { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
            { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
            { src: "/pwa.svg", sizes: "any", type: "image/svg+xml" },
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
