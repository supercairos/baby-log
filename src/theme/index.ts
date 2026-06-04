import { useTheme } from "./context";
import type { Styles } from "./styles";

export { ThemeProvider } from "./ThemeProvider";
export { useTheme } from "./context";
export type { Palette, ThemeName, ThemePref, ActivityVisual } from "./palette";
export type { Styles } from "./styles";

/** Memoized, theme-driven style maps for the current palette (computed once in context). */
export function useStyles(): Styles {
  return useTheme().styles;
}
