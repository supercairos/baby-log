/**
 * Theme tokens for the two palettes from the mockups (baby-log.html / baby-log-light.html).
 * Same structure, different values — components read tokens, never hard-coded colors.
 *
 * Dark  = warm aubergine/charcoal, soft glows, grain overlay, no hard shadows.
 * Light = cream paper, ink text, saturated earthy accents, hard offset shadows (press-to-sink).
 */
import type { ActivityKey } from "../api";

export type ThemeName = "dark" | "light";
export type ThemePref = ThemeName | "system";

export interface ActivityVisual {
  accent: string;
  glow: string;
}

export interface Palette {
  name: ThemeName;
  /** Root background (layered radial + linear gradients). */
  bg: string;
  grain: { backgroundImage: string; opacity: number; mixBlendMode: "overlay" | "multiply" };

  serif: string;
  body: string;

  text: string;
  textMuted: string;
  textFaint: string;
  textFainter: string;
  groupText: string;

  surface: string;
  surfaceBorder: string;
  surfaceStrongBorder: string;
  inner: string;

  chipBg: string;
  chipBorder: string;
  chipText: string;

  avatarBg: string;
  avatarBorder: string;
  avatarText: string;

  iconBtnBg: string;
  iconBtnBorder: string;
  /** Hard offset shadow for the icon button (light only). */
  iconBtnShadow: string;

  /** Solid base color used inside the active tile/card gradients. */
  tileBase: string;
  /** Hard offset shadow for resting cards/tiles (light) or "none" (dark). */
  cardShadow: string;
  cardShadowColor: string;

  sheetBg: string;
  sheetBorder: string;
  sheetShadow: string;
  sheetHandle: string;

  toastBg: string;
  toastText: string;
  toastBorder: string;
  toastShadow: string;
  toastBlur: string;

  scrim: string;
  scrimBlur: string;

  danger: string;
  /** Positive/fresh status (freshness dot) — a calm green, quieter than the activity accents. */
  ok: string;
  /** Stale/degraded status (stale freshness, offline pill) — amber; `danger` would read as an error. */
  warn: string;
  /** Diaper wet/solid state colors — preset dots + wet/solid chips (chip text must hold ≥3:1 on the chipOn tint). */
  diaperWet: string;
  diaperSolid: string;
  /** Text color placed on top of an accent-filled button. */
  onAccent: string;
  /** Hard offset shadow under the primary CTA (light only). */
  ctaShadow: string;
  ctaOffBg: string;
  ctaOffText: string;

  drawerBg: string;
  drawerBorder: string;
  drawerShadow: string;

  accents: Record<ActivityKey, ActivityVisual>;
}

const FONT_SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
const FONT_BODY = "'Nunito', ui-rounded, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

const grainImg = (freq: number, octaves: number, size: number, opacity: number) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='${octaves}'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='${opacity}'/%3E%3C/svg%3E")`;

export const darkPalette: Palette = {
  name: "dark",
  bg: `radial-gradient(120% 80% at 50% -10%, #2a2230 0%, transparent 55%), radial-gradient(90% 60% at 100% 100%, #241e2a 0%, transparent 60%), linear-gradient(180deg, #1a1722 0%, #15121c 100%)`,
  grain: { backgroundImage: grainImg(0.85, 3, 140, 0.5), opacity: 0.5, mixBlendMode: "overlay" },
  serif: FONT_SERIF,
  body: FONT_BODY,
  text: "#f0ebe4",
  textMuted: "#9a8fa6",
  textFaint: "#75707e",
  textFainter: "#756c80", // ≥3:1 on every dark surface incl. sheet/drawer tops (#6b6276 dipped to 2.65)
  groupText: "#857a91",
  surface: "rgba(255,255,255,.04)",
  surfaceBorder: "rgba(255,255,255,.06)",
  surfaceStrongBorder: "rgba(255,255,255,.08)",
  inner: "rgba(0,0,0,.22)",
  chipBg: "rgba(255,255,255,.05)",
  chipBorder: "rgba(255,255,255,.08)",
  chipText: "#d4cdda",
  avatarBg: "rgba(255,255,255,.05)",
  avatarBorder: "rgba(255,255,255,.08)",
  avatarText: "#8a8094",
  iconBtnBg: "rgba(255,255,255,.05)",
  iconBtnBorder: "rgba(255,255,255,.08)",
  iconBtnShadow: "none",
  tileBase: "#1a1722",
  cardShadow: "none",
  cardShadowColor: "transparent",
  sheetBg: "linear-gradient(180deg, #261f2e, #1f1926)",
  sheetBorder: "rgba(255,255,255,.08)",
  sheetShadow: "0 -16px 50px rgba(0,0,0,.55)",
  sheetHandle: "rgba(255,255,255,.18)",
  toastBg: "rgba(36,30,42,.92)",
  toastText: "#f0ebe4",
  toastBorder: "rgba(255,255,255,.1)",
  toastShadow: "0 8px 30px rgba(0,0,0,.4)",
  toastBlur: "blur(12px)",
  scrim: "rgba(12,9,16,.6)",
  scrimBlur: "blur(3px)",
  danger: "#d98282",
  ok: "#a4c8a0", // shares the diaperWet green on purpose — one calm green in the system
  warn: "#d9b36b",
  diaperWet: "#a4c8a0",
  diaperSolid: "#c9a86a",
  onAccent: "#1a1722",
  ctaShadow: "none",
  ctaOffBg: "rgba(255,255,255,.05)",
  ctaOffText: "#6b6276",
  drawerBg: "linear-gradient(180deg, #261f2e, #1c1726)",
  drawerBorder: "rgba(255,255,255,.08)",
  drawerShadow: "16px 0 50px rgba(0,0,0,.5)",
  accents: {
    feeding: { accent: "#e8a86b", glow: "rgba(232,168,107,.30)" },
    sleep: { accent: "#9db4d4", glow: "rgba(157,180,212,.30)" },
    diaper: { accent: "#a4c8a0", glow: "rgba(164,200,160,.30)" },
    tummy: { accent: "#d9a0b4", glow: "rgba(217,160,180,.30)" },
    medication: { accent: "#b3a4e0", glow: "rgba(179,164,224,.30)" },
  },
};

export const lightPalette: Palette = {
  name: "light",
  bg: `radial-gradient(130% 90% at 50% -20%, #f7f1e6 0%, transparent 55%), radial-gradient(100% 70% at 100% 105%, #ece2cf 0%, transparent 60%), linear-gradient(180deg, #f0e9dc 0%, #ebe2d2 100%)`,
  grain: { backgroundImage: grainImg(0.7, 4, 160, 0.35), opacity: 0.35, mixBlendMode: "multiply" },
  serif: FONT_SERIF,
  body: FONT_BODY,
  text: "#2b2620",
  textMuted: "#8a7d68",
  // Faint text still carries info (hints, timestamps, axes) — keep ≥4.5:1 / ≥3:1 on card AND page bg.
  textFaint: "#6f624d",
  textFainter: "#857661",
  groupText: "#a8997f",
  surface: "#fffaf0",
  surfaceBorder: "#e3d7c0",
  surfaceStrongBorder: "#d8cbb2",
  inner: "#f3ebdb",
  chipBg: "#f3ebdb",
  chipBorder: "#e3d7c0",
  chipText: "#5c5345",
  avatarBg: "#e3d7c0",
  avatarBorder: "#d8cbb2",
  avatarText: "#8a7d68",
  iconBtnBg: "#fffaf0",
  iconBtnBorder: "#d8cbb2",
  iconBtnShadow: "0 2px 0 #d8cbb2",
  tileBase: "#fffaf0",
  cardShadow: "0 4px 0 #e3d7c0",
  cardShadowColor: "#e3d7c0",
  sheetBg: "#fffaf0",
  sheetBorder: "#e3d7c0",
  sheetShadow: "0 -16px 50px rgba(43,38,32,.18)",
  sheetHandle: "#d8cbb2",
  toastBg: "#2b2620",
  toastText: "#f7f1e6",
  toastBorder: "#2b2620",
  toastShadow: "0 10px 30px rgba(43,38,32,.25)",
  toastBlur: "none",
  scrim: "rgba(43,38,32,.4)",
  scrimBlur: "blur(2px)",
  danger: "#b03a3a",
  ok: "#6f8c4f", // shares the diaperWet green on purpose — one calm green in the system
  warn: "#a8731e",
  diaperWet: "#6f8c4f",
  diaperSolid: "#b07d2e",
  onAccent: "#fffaf0",
  ctaShadow: "0 4px 0 rgba(166,79,36,.4)",
  ctaOffBg: "#e3d7c0",
  ctaOffText: "#a8997f",
  drawerBg: "linear-gradient(180deg, #fffaf0, #f3ebdb)",
  drawerBorder: "#d8cbb2",
  drawerShadow: "16px 0 50px rgba(43,38,32,.18)",
  accents: {
    feeding: { accent: "#c4622d", glow: "rgba(196,98,45,.20)" },
    sleep: { accent: "#2f6d7a", glow: "rgba(47,109,122,.20)" },
    diaper: { accent: "#5d7a3a", glow: "rgba(93,122,58,.20)" },
    tummy: { accent: "#9a4a6b", glow: "rgba(154,74,107,.20)" },
    medication: { accent: "#5b53a6", glow: "rgba(91,83,166,.20)" },
  },
};

export const PALETTES: Record<ThemeName, Palette> = { dark: darkPalette, light: lightPalette };
