/**
 * i18next setup. Strings live in `locales/<lang>.json`; English is the source + fallback.
 * The device language is auto-detected (and cached in localStorage so a manual choice sticks);
 * `nonExplicitSupportedLngs` maps e.g. "fr-FR" → "fr". Non-component modules (notifications,
 * formatting, the outbox) import this instance and call `i18n.t(...)` directly.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";
import de from "./locales/de.json";
import it from "./locales/it.json";

export const SUPPORTED_LANGUAGES = ["en", "fr", "es", "de", "it"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Native language names, for the in-app switcher. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  de: "Deutsch",
  it: "Italiano",
};

/** Emoji flags for the in-app switcher (regional-indicator pairs). */
export const LANGUAGE_FLAGS: Record<Language, string> = {
  en: "🇬🇧",
  fr: "🇫🇷",
  es: "🇪🇸",
  de: "🇩🇪",
  it: "🇮🇹",
};

const STORAGE_KEY = "baby-log:lang";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
      es: { translation: es },
      de: { translation: de },
      it: { translation: it },
    },
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES,
    nonExplicitSupportedLngs: true, // "fr-FR" → "fr"
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: STORAGE_KEY,
      caches: ["localStorage"],
    },
  });

/** Resolve the active base language (e.g. "fr-FR" → "fr"), for the switcher's current value. */
export function currentLanguage(): Language {
  const base = (i18n.resolvedLanguage ?? i18n.language ?? "en").split("-")[0] as Language;
  return SUPPORTED_LANGUAGES.includes(base) ? base : "en";
}

/** A BCP-47 locale tag for Intl/`toLocale*` date & time formatting. */
export function currentLocale(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? "en";
}

// Keep <html lang> in sync for accessibility.
if (typeof document !== "undefined") {
  const apply = (lng: string) => (document.documentElement.lang = lng.split("-")[0]);
  apply(currentLocale());
  i18n.on("languageChanged", apply);
}

export default i18n;
