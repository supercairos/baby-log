import { createContext, useContext } from "react";
import type { Palette, ThemeName, ThemePref } from "./palette";
import type { Styles } from "./styles";

export interface ThemeContextValue {
  palette: Palette;
  name: ThemeName;
  pref: ThemePref;
  setPref: (pref: ThemePref) => void;
  /** Cycle dark → light → system. */
  cyclePref: () => void;
  /** Memoized style maps for the current palette (computed once per theme). */
  styles: Styles;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
