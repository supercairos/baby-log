/**
 * Theme context: follows the system color scheme by default, with a manual override
 * persisted in localStorage. The resolved palette + memoized styles are provided via
 * context; `useTheme` lives in ./context so this file only exports the component.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PALETTES, type ThemeName, type ThemePref } from "./palette";
import { makeStyles } from "./styles";
import { ThemeContext, type ThemeContextValue } from "./context";

const STORAGE_KEY = "baby-log:theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function loadPref(): ThemePref {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  return v === "dark" || v === "light" || v === "system" ? v : "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(loadPref);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const name: ThemeName = pref === "system" ? (systemDark ? "dark" : "light") : pref;
  const palette = PALETTES[name];

  // Keep the document background in sync (overscroll, address bar, safe-area gutters).
  useEffect(() => {
    document.documentElement.style.colorScheme = name;
    document.body.style.background = palette.bg.split(",").slice(-1)[0].trim();
    document.body.style.color = palette.text;
  }, [name, palette]);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);
  const cyclePref = useCallback(() => {
    setPref(pref === "dark" ? "light" : pref === "light" ? "system" : "dark");
  }, [pref, setPref]);

  const styles = useMemo(() => makeStyles(palette), [palette]);

  const value = useMemo<ThemeContextValue>(
    () => ({ palette, name, pref, setPref, cyclePref, styles }),
    [palette, name, pref, setPref, cyclePref, styles],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
