/**
 * "Update available — tap to refresh" prompt. With vite-plugin-pwa in `prompt` mode, a newly
 * deployed service worker installs but waits; `useRegisterSW` flips `needRefresh` so we show a
 * tappable banner instead of silently reloading. Tapping calls `updateServiceWorker(true)`,
 * which tells the waiting worker to activate (SKIP_WAITING) and reloads onto the new version.
 *
 * We also poll for updates hourly and whenever the app regains focus, so a deploy is noticed
 * without a cold start (important for an installed PWA that stays open for days).
 */
import { useRegisterSW } from "virtual:pwa-register/react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme";

export function UpdatePrompt() {
  const { palette } = useTheme();
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      const check = () => void registration.update().catch(() => {});
      window.setInterval(check, 60 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
  });

  if (!needRefresh) return null;

  return (
    <button
      onClick={() => void updateServiceWorker(true)}
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
        zIndex: 1000,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        maxWidth: "calc(100% - 32px)",
        padding: "12px 20px",
        borderRadius: 999,
        border: "none",
        background: palette.accents.feeding.accent,
        color: palette.onAccent,
        font: "inherit",
        fontWeight: 700,
        fontSize: 15,
        lineHeight: 1.2,
        boxShadow: "0 10px 34px rgba(0,0,0,.28)",
        cursor: "pointer",
      }}
    >
      <span aria-hidden style={{ fontSize: 17 }}>↻</span>
      {t("update.available")}
    </button>
  );
}
