/**
 * makeStyles(palette) → the inline-style maps from the mockups, rebuilt from theme tokens.
 * Keys mirror the mockup's `S`/`LS` objects so the port is mechanical. Dynamic, accent-keyed
 * styles (chips, active tiles, running cards, toast) are returned as helper functions.
 */
import type { CSSProperties } from "react";
import type { Palette, ActivityVisual } from "./palette";

export interface Styles {
  s: Record<string, CSSProperties>;
  chipOn: (c: string) => CSSProperties;
  activeTile: (v: ActivityVisual) => CSSProperties;
  runCardAccent: (v: ActivityVisual) => CSSProperties;
  toastTone: (accent?: string) => CSSProperties;
}

export function makeStyles(p: Palette): Styles {
  const dark = p.name === "dark";
  const brandGradient = dark
    ? "linear-gradient(150deg,#e8a86b,#d9846b)"
    : "linear-gradient(150deg,#c4622d,#a64f24)";
  const feed = p.accents.feeding.accent;

  const s: Record<string, CSSProperties> = {
    root: {
      minHeight: "100vh",
      color: p.text,
      background: p.bg,
      fontFamily: p.body,
      padding: "0 18px",
      paddingBottom: "calc(32px + env(safe-area-inset-bottom))",
      maxWidth: 440,
      margin: "0 auto",
      display: "flex",
      flexDirection: "column",
      position: "relative",
      overflow: "hidden",
    },
    ambient: {
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      opacity: p.grain.opacity,
      mixBlendMode: p.grain.mixBlendMode,
      backgroundImage: p.grain.backgroundImage,
    },

    header: {
      paddingTop: "calc(22px + env(safe-area-inset-top))",
      display: "flex",
      flexDirection: "column",
      gap: 22,
      zIndex: 1,
      animation: "fadeIn .6s ease",
    },
    greetRow: { display: "flex", alignItems: "center", gap: 14 },
    greetWrap: { display: "flex", flexDirection: "column", gap: 3 },
    greet: { color: p.text, fontFamily: p.serif, fontSize: 30, fontWeight: 600, letterSpacing: "-.5px", lineHeight: 1 },
    greetSub: { fontSize: 14.5, color: p.textMuted, fontWeight: 600 },
    greetAge: { color: p.textFaint, fontWeight: 600 },

    topbar: {
      paddingTop: "calc(18px + env(safe-area-inset-top))",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      zIndex: 2,
      position: "relative",
    },
    topbarTitle: { color: p.text, fontFamily: p.serif, fontSize: 18, fontWeight: 600 },
    iconBtn: {
      display: "grid",
      placeItems: "center",
      width: 44,
      height: 44,
      borderRadius: 14,
      background: p.iconBtnBg,
      border: `1px solid ${p.iconBtnBorder}`,
      color: p.text,
      boxShadow: p.iconBtnShadow,
      flexShrink: 0,
    },

    children: { display: "flex", gap: 10, flexWrap: "wrap" },
    childChip: { display: "flex", alignItems: "center", gap: 10, padding: 6, background: "transparent", border: "none", borderRadius: 999, transition: "background .2s ease" },
    childChipOn: dark
      ? { background: "rgba(255,255,255,.06)", padding: "6px 18px 6px 6px" }
      : { background: p.surface, padding: "6px 18px 6px 6px", boxShadow: "0 2px 0 #d8cbb2", border: `1px solid ${p.surfaceBorder}` },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: "50%",
      display: "grid",
      placeItems: "center",
      background: p.avatarBg,
      color: p.avatarText,
      fontWeight: 800,
      fontSize: 16,
      border: `1px solid ${p.avatarBorder}`,
      fontFamily: p.serif,
    },
    avatarOn: { background: brandGradient, color: p.onAccent, border: "none", boxShadow: dark ? "0 4px 16px rgba(232,168,107,.4)" : "0 3px 10px rgba(196,98,45,.35)" },
    childName: { fontSize: 16, fontWeight: 800, color: p.text },

    runningWrap: { marginTop: 26, display: "flex", flexDirection: "column", gap: 12, zIndex: 1 },
    idle: { display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 4px" },
    idleDot: { width: 7, height: 7, borderRadius: "50%", background: dark ? "#5a5266" : "#c7b79a", animation: "pulse 2.6s ease-in-out infinite", marginTop: 6, flexShrink: 0 },
    idleText: { display: "flex", flexDirection: "column", gap: 5 },
    idleTitle: { color: p.textMuted, fontSize: 14.5, fontWeight: 700 },
    idleHint: { color: p.textFaint, fontSize: 13, fontWeight: 500, lineHeight: 1.45, maxWidth: 300 },
    runCard: { display: "flex", alignItems: "center", gap: 14, padding: "15px 16px", border: dark ? "none" : `1px solid ${p.surfaceBorder}`, borderRadius: 22, textAlign: "left" },
    runBody: { display: "flex", alignItems: "center", gap: 14, flex: 1, minWidth: 0, background: "transparent", border: "none", padding: 0, color: "inherit", textAlign: "left" },
    runIcon: { position: "relative", display: "grid", placeItems: "center", width: 44, height: 44, borderRadius: 14, background: p.inner },
    liveDot: { position: "absolute", top: 7, right: 7, width: 6, height: 6, borderRadius: "50%" },
    runMeta: { display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 },
    runLabel: { fontSize: 13, color: p.textMuted, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    runTime: { color: p.text, fontSize: 30, fontWeight: 600, lineHeight: 1, fontFamily: p.serif },
    runStopHint: { fontSize: 11, color: p.textFaint, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, flexShrink: 0, alignSelf: "center" },
    runEdit: { display: "grid", placeItems: "center", width: 44, height: 44, borderRadius: 14, borderWidth: 1, borderStyle: "solid", background: p.inner, flexShrink: 0 },
    // A probably-forgotten timer (e.g. a 14h+ "sleep"): danger-tinted ring so the nudge is seen.
    runCardStale: { boxShadow: `inset 0 0 0 1.5px ${p.danger}99, 0 10px 36px ${p.danger}22` },

    // "Up next" estimates — deliberately discreet (no card chrome, muted text): purely
    // informational, and only ever an estimate.
    estimates: { display: "flex", flexDirection: "column", padding: "10px 6px 2px" },
    estimatesHead: { fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: p.textFaint, fontWeight: 800, padding: "0 8px 4px" },
    estimateRow: { display: "flex", alignItems: "center", gap: 11, padding: "7px 8px" },
    estimateIcon: { display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 9, flexShrink: 0, opacity: 0.9 },
    estimateLabel: { flex: 1, color: p.textMuted, fontSize: 14, fontWeight: 600 },
    estimateTime: { fontSize: 14, fontWeight: 700, color: p.textMuted, letterSpacing: "-.1px" },

    grid: { marginTop: "auto", paddingTop: 30, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, zIndex: 1 },
    tile: {
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: 11,
      padding: "22px 20px",
      minHeight: 138,
      borderRadius: dark ? 26 : 24,
      background: p.surface,
      border: `1px solid ${p.surfaceBorder}`,
      textAlign: "left",
      transition: "transform .14s ease, box-shadow .25s ease, background .25s ease",
      boxShadow: p.cardShadow,
      backdropFilter: dark ? "blur(6px)" : undefined,
      WebkitBackdropFilter: dark ? "blur(6px)" : undefined,
    },
    tileIcon: { display: "grid", placeItems: "center", width: 54, height: 54, borderRadius: 18, background: p.inner, transition: "background .25s ease" },
    tileLabel: { color: p.text, fontSize: dark ? 19 : 20, marginTop: 2, fontFamily: p.serif, fontWeight: 600 },
    tileHint: { fontSize: 12.5, fontWeight: 700, transition: "color .25s ease" },

    toast: {
      position: "fixed",
      left: "50%",
      top: "calc(18px + env(safe-area-inset-top))",
      transform: "translate(-50%, -24px)",
      zIndex: 50,
      background: p.toastBg,
      border: `1px solid ${p.toastBorder}`,
      color: p.toastText,
      padding: "13px 22px",
      borderRadius: 999,
      fontSize: 14.5,
      fontWeight: 700,
      opacity: 0,
      transition: "opacity .3s ease, transform .3s cubic-bezier(.22,1,.36,1)",
      pointerEvents: "none",
      maxWidth: 360,
      width: "max-content",
      boxShadow: p.toastShadow,
      backdropFilter: p.toastBlur === "none" ? undefined : p.toastBlur,
      WebkitBackdropFilter: p.toastBlur === "none" ? undefined : p.toastBlur,
    },
    toastOn: { opacity: 1, transform: "translate(-50%, 0)" },

    scrim: { position: "fixed", inset: 0, background: p.scrim, zIndex: 5, backdropFilter: p.scrimBlur, WebkitBackdropFilter: p.scrimBlur, animation: "fadeIn .25s ease", border: "none" },
    sheet: {
      position: "fixed",
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 6,
      maxWidth: 440,
      margin: "0 auto",
      background: p.sheetBg,
      borderTopLeftRadius: 30,
      borderTopRightRadius: 30,
      padding: "12px 22px 30px",
      paddingBottom: "calc(30px + env(safe-area-inset-bottom))",
      borderTop: `1px solid ${p.sheetBorder}`,
      transform: "translateY(110%)",
      transition: "transform .34s cubic-bezier(.32,.72,0,1)",
      boxShadow: p.sheetShadow,
    },
    sheetOn: { transform: "translateY(0)" },
    sheetHandle: { width: 42, height: 4, borderRadius: 2, background: p.sheetHandle, margin: "0 auto 18px" },
    sheetTitle: { color: p.text, fontSize: dark ? 23 : 24, fontWeight: 600, marginBottom: 16, fontFamily: p.serif },
    sheetRunning: {
      display: "flex",
      alignItems: "center",
      gap: 9,
      padding: "11px 14px",
      marginBottom: 6,
      borderRadius: 13,
      background: `${feed}1f`,
      border: `1px solid ${feed}47`,
      color: feed,
      fontSize: 13.5,
      fontWeight: 700,
    },
    sheetGroup: { fontSize: 11.5, letterSpacing: 1.7, textTransform: "uppercase", color: p.groupText, margin: "16px 0 11px", fontWeight: 800 },
    chips: { display: "flex", flexWrap: "wrap", gap: 9 },
    chip: { display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 44, padding: "11px 19px", borderRadius: 15, background: p.chipBg, border: `1px solid ${p.chipBorder}`, color: p.chipText, fontSize: 15, fontWeight: 700, transition: "all .18s ease" },
    cta: { width: "100%", marginTop: 26, padding: "17px", borderRadius: 18, border: "none", fontSize: 16, fontWeight: 800, transition: "all .2s ease", background: feed, color: p.onAccent, boxShadow: p.ctaShadow },
    ctaOff: { background: p.ctaOffBg, color: p.ctaOffText, boxShadow: "none" },
    diaperRow: { display: "flex", gap: 11, marginTop: 6 },
    diaperBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 13, padding: "26px 8px", borderRadius: 22, background: p.chipBg, border: `1px solid ${p.chipBorder}`, color: p.text, fontSize: 16, fontWeight: 800, transition: "all .18s ease" },
    diaperDot: { width: 36, height: 36, borderRadius: "50%", boxShadow: `inset 0 -3px 8px rgba(0,0,0,${dark ? ".2" : ".12"})` },

    editHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
    editDel: { display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 12, background: dark ? "rgba(217,130,130,.12)" : "rgba(176,58,58,.1)", border: `1px solid ${dark ? "rgba(217,130,130,.3)" : "rgba(176,58,58,.3)"}`, color: p.danger, fontSize: 13.5, fontWeight: 700 },
    timeInput: { width: "100%", padding: "13px 16px", borderRadius: 14, fontSize: 15.5, fontWeight: 700, background: p.chipBg, border: `1px solid ${p.surfaceStrongBorder}`, color: p.text, fontFamily: p.body, colorScheme: dark ? "dark" : "light" },
    timeRow: { display: "flex", gap: 10 },
    timeCol: { flex: 1, minWidth: 0 },
    // Two datetime-locals share one row — tighter metrics so both fit on a narrow phone.
    timeInputCompact: { padding: "12px 10px", fontSize: 13.5, boxSizing: "border-box" },
    notesInput: { width: "100%", padding: "12px 16px", borderRadius: 14, fontSize: 15, fontWeight: 600, background: p.chipBg, border: `1px solid ${p.surfaceStrongBorder}`, color: p.text, fontFamily: p.body, resize: "vertical", minHeight: 60, lineHeight: 1.4, boxSizing: "border-box" },
    // Bottle-amount slider (accentColor is set inline from the feeding accent).
    sliderRow: { display: "flex", alignItems: "center", gap: 14, padding: "4px 2px" },
    slider: { flex: 1, height: 28, margin: 0, cursor: "pointer" },
    sliderValue: { minWidth: 58, textAlign: "right", fontSize: 16, fontWeight: 700, color: p.text, fontFamily: p.serif, fontVariantNumeric: "tabular-nums" },
    durReadout: { marginTop: 10, fontSize: 13.5, fontWeight: 700, color: p.textMuted, display: "flex", alignItems: "center", gap: 6 },
    durBad: { color: p.danger },

    drawer: {
      position: "fixed",
      top: 0,
      left: 0,
      bottom: 0,
      width: 270,
      maxWidth: "78vw",
      zIndex: 7,
      background: p.drawerBg,
      borderRight: `1px solid ${p.drawerBorder}`,
      padding: "28px 16px",
      paddingTop: "calc(28px + env(safe-area-inset-top))",
      display: "flex",
      flexDirection: "column",
      gap: 6,
      transform: "translateX(-105%)",
      transition: "transform .32s cubic-bezier(.32,.72,0,1)",
      boxShadow: p.drawerShadow,
    },
    drawerOn: { transform: "translateX(0)" },
    drawerBrand: { color: p.text, fontFamily: p.serif, fontSize: dark ? 22 : 23, fontWeight: 600, padding: "4px 12px 20px", display: "flex", alignItems: "center", gap: 8 },
    drawerLogo: { color: feed, fontSize: 34, lineHeight: 0 },
    navItem: { display: "flex", alignItems: "center", gap: 13, padding: "13px 14px", borderRadius: 14, background: "transparent", border: "none", color: dark ? "#b3a9bd" : "#5c5345", fontSize: 15.5, fontWeight: 700, textAlign: "left", width: "100%", transition: "all .18s ease" },
    navItemOn: { background: `${feed}24`, color: feed },
    navDivider: { height: 1, background: p.drawerBorder, margin: "14px 12px" },
    navFoot: { fontSize: 12.5, color: p.textFaint, padding: "0 14px", marginTop: "auto", fontWeight: 600 },

    timeline: { marginTop: 18, zIndex: 1, paddingBottom: 20, animation: "fadeIn .4s ease" },
    addBtn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 9, width: "100%", padding: "15px", marginBottom: 22, borderRadius: 18, background: `${feed}1f`, border: `1px solid ${feed}59`, color: feed, fontSize: 15.5, fontWeight: 800 },
    addPlus: { display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: 9, background: `${feed}30`, color: feed },
    daygroup: { marginBottom: 22 },
    dayhead: { fontSize: 12, letterSpacing: 1.4, textTransform: "uppercase", color: p.textFaint, fontWeight: 800, margin: "0 0 12px 4px" },
    entry: { display: "flex", alignItems: "center", gap: 13, padding: "13px 14px", marginBottom: 8, borderRadius: 18, background: p.surface, border: `1px solid ${p.surfaceBorder}`, boxShadow: dark ? "none" : "0 2px 0 #e3d7c0" },
    entryIco: { display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 13, flexShrink: 0 },
    entryTap: { display: "flex", alignItems: "center", gap: 13, flex: 1, minWidth: 0, background: "transparent", border: "none", textAlign: "left", padding: 0, color: "inherit" },
    entryMid: { flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
    entryLabel: { color: p.text, fontSize: 15.5, fontFamily: p.serif, fontWeight: 600 },
    entryMeta: { color: p.textMuted, fontWeight: 500, fontFamily: p.body },
    entryTime: { fontSize: 13, color: p.textFaint, fontWeight: 600 },
    // Free-text note on its own line, single-line ellipsis to keep rows compact.
    entryNote: { fontSize: 13, color: p.textMuted, fontStyle: "italic", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    entryDel: { display: "grid", placeItems: "center", width: 44, height: 44, borderRadius: 11, background: "transparent", border: "none", color: p.textFainter, flexShrink: 0 },
    empty: { textAlign: "center", padding: "60px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 },
    emptyIco: { display: "grid", placeItems: "center", width: 60, height: 60, borderRadius: 20, background: p.chipBg, color: p.textFaint, marginBottom: 4 },
    emptyTitle: { color: p.text, fontFamily: p.serif, fontSize: 19, fontWeight: 600 },
    emptySub: { fontSize: 14, color: p.textMuted, fontWeight: 600, maxWidth: 240 },

    // ── Calendar (timeline page: Day / Week / List / Summary) ──
    cal: { marginTop: 14, zIndex: 1, paddingBottom: 20, animation: "fadeIn .4s ease" },
    segWrap: { display: "flex", gap: 4, padding: 4, background: p.chipBg, borderRadius: 14, border: `1px solid ${p.surfaceBorder}`, marginBottom: 16 },
    segBtn: { flex: 1, padding: "9px 6px", borderRadius: 10, background: "transparent", border: "none", color: p.textMuted, fontSize: 13.5, fontWeight: 700, transition: "all .18s ease" },
    segBtnOn: { background: p.surface, color: p.text, boxShadow: dark ? "0 1px 6px rgba(0,0,0,.3)" : "0 2px 0 #d8cbb2" },
    periodNav: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
    periodArrow: { display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 10, background: p.iconBtnBg, border: `1px solid ${p.iconBtnBorder}`, color: p.text, fontSize: 20, lineHeight: 0, fontFamily: p.serif },
    periodLabel: { flex: 1, textAlign: "center", color: p.text, fontFamily: p.serif, fontSize: 16, fontWeight: 600 },
    todayBtn: { padding: "7px 12px", borderRadius: 10, background: `${feed}1f`, border: `1px solid ${feed}59`, color: feed, fontSize: 12.5, fontWeight: 800 },

    gridScroll: { position: "relative" },
    gridViewport: { position: "relative", overflowY: "auto", overflowX: "hidden", maxHeight: "58vh", borderRadius: 14, WebkitOverflowScrolling: "touch" },
    gridHead: { display: "flex", position: "sticky", top: 0, zIndex: 6, background: p.bg, paddingTop: 4, paddingBottom: 6 },
    gridAxisHead: { width: 30, flexShrink: 0 },
    gridDayHead: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, padding: "3px 0", borderRadius: 8 },
    gridDayHeadOn: { background: `${feed}1f` },
    gridDow: { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", color: p.textFaint, letterSpacing: 0.3 },
    gridDayNum: { fontSize: 14, fontWeight: 700, color: p.text, fontFamily: p.serif },
    gridBody: { display: "flex", position: "relative" },
    gridAxis: { width: 30, flexShrink: 0, position: "relative" },
    gridHourLabel: { position: "absolute", right: 6, transform: "translateY(-50%)", fontSize: 10, fontWeight: 700, color: p.textFainter },
    gridCol: { flex: 1, position: "relative", borderLeft: `1px solid ${p.surfaceBorder}` },
    gridLine: { position: "absolute", left: 0, right: 0, height: 1, background: p.surfaceBorder, opacity: 0.5 },
    // Thin line with teardrop caps at both ends (tails point along the line). White on the dark
    // theme; ink on the light paper theme, where white would wash out. Caps rotate inline per side.
    nowLine: { position: "absolute", left: -1, right: -1, height: 2, borderRadius: 999, background: dark ? "#fff" : p.text, zIndex: 5 },
    nowCap: { position: "absolute", top: "50%", width: 9, height: 9, borderRadius: "50% 50% 50% 0", background: dark ? "#fff" : p.text },
    // left/width are set inline per block by the day column's lane layout (overlapping events
    // share the column side by side).
    blkSleep: { position: "absolute", borderRadius: 4, border: "none", padding: 0, zIndex: 1 },
    blkBar: { position: "absolute", borderRadius: 3, border: "none", padding: 0, zIndex: 2 },
    blkDiaper: { position: "absolute", height: 3, borderRadius: 2, border: "none", padding: 0, zIndex: 3 },
    gridAddBtn: { display: "flex", alignItems: "center", justifyContent: "center", width: "100%", marginTop: 18, padding: "13px", borderRadius: 16, background: `${feed}1f`, border: `1px solid ${feed}59`, color: feed, fontSize: 14.5, fontWeight: 800 },

    summaryGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
    statCard: { display: "flex", flexDirection: "column", gap: 4, padding: "16px 16px 18px", borderRadius: 20, background: p.surface, border: `1px solid ${p.surfaceBorder}`, boxShadow: p.cardShadow },
    statIcon: { display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 11, marginBottom: 4 },
    statTitle: { fontSize: 12.5, fontWeight: 700, color: p.textMuted },
    statBig: { fontSize: 22, fontWeight: 600, fontFamily: p.serif, color: p.text, lineHeight: 1.1 },
    statSub: { fontSize: 12.5, fontWeight: 600, color: p.textFaint },
    statDelta: { fontSize: 11.5, fontWeight: 700, color: p.textFainter, marginTop: 2 },
    addBar: { position: "sticky", bottom: 0, zIndex: 4, marginTop: 14, paddingTop: 12, paddingBottom: "calc(6px + env(safe-area-inset-bottom))", background: `linear-gradient(to top, ${p.bg} 72%, transparent)` },

    radialWrap: { position: "relative", display: "flex", justifyContent: "center", padding: "10px 0 6px" },
    radialSvg: { width: "100%", maxWidth: 340, height: "auto", display: "block", overflow: "visible" },
    radialCenter: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, pointerEvents: "none", textAlign: "center" },
    radialSmall: { fontSize: 13, fontWeight: 700, color: p.textMuted },
    radialBig: { fontSize: 34, fontWeight: 600, fontFamily: p.serif, color: p.text, lineHeight: 1.05 },
    radialActivity: { fontSize: 14, fontWeight: 800 },
    radialStats: { display: "flex", flexDirection: "column", gap: 7, alignItems: "flex-start" },
    radialStatRow: { display: "flex", alignItems: "center", gap: 9 },
    radialStatValue: { fontSize: 15.5, fontWeight: 700, color: p.text, fontFamily: p.serif, letterSpacing: ".2px" },

    syncPill: { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 700, color: p.textFaint },
    syncDot: { width: 7, height: 7, borderRadius: "50%", background: feed, animation: "pulse 1.4s ease-in-out infinite" },

    // ── Login screen ──
    loginRoot: {
      minHeight: "100vh",
      color: p.text,
      background: p.bg,
      fontFamily: p.body,
      padding: "0 22px",
      paddingBottom: "calc(28px + env(safe-area-inset-bottom))",
      maxWidth: 440,
      margin: "0 auto",
      display: "flex",
      flexDirection: "column",
      position: "relative",
      overflow: "hidden",
    },
    loginHero: { paddingTop: "calc(80px + env(safe-area-inset-top))", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, zIndex: 1, animation: "fadeIn .7s ease" },
    loginLogo: { width: 72, height: 72, borderRadius: 24, display: "grid", placeItems: "center", background: brandGradient, color: p.onAccent, fontSize: 52, lineHeight: 0, fontFamily: p.serif, boxShadow: "0 10px 30px rgba(196,98,45,.35)", marginBottom: 6 },
    loginAppName: { fontFamily: p.serif, fontSize: 34, fontWeight: 600, color: p.text, letterSpacing: "-.5px" },
    loginTagline: { fontSize: 15, color: p.textMuted, fontWeight: 500, maxWidth: 300, lineHeight: 1.5 },
    loginPanel: { marginTop: "auto", marginBottom: 22, background: p.surface, border: `1px solid ${p.surfaceStrongBorder}`, borderRadius: 26, padding: "22px 20px", backdropFilter: dark ? "blur(8px)" : undefined, WebkitBackdropFilter: dark ? "blur(8px)" : undefined, zIndex: 1, animation: "fadeIn .7s ease .1s both" },
    loginPanelTitle: { fontFamily: p.serif, fontSize: 20, fontWeight: 600, marginBottom: 6, color: p.text },
    loginScanBtn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 11, width: "100%", padding: "17px", borderRadius: 18, border: "none", fontSize: 16.5, fontWeight: 800, background: feed, color: p.onAccent, boxShadow: dark ? "0 6px 20px rgba(232,168,107,.3)" : p.ctaShadow },
    loginScanSub: { textAlign: "center", fontSize: 13, color: p.textMuted, fontWeight: 500, marginTop: 12 },
    loginDivider: { display: "flex", alignItems: "center", gap: 12, margin: "20px 0" },
    loginDividerLine: { flex: 1, height: 1, background: p.surfaceStrongBorder },
    loginDividerText: { fontSize: 12.5, color: p.textFaint, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 },
    loginManualBtn: { width: "100%", padding: "15px", borderRadius: 16, fontSize: 15, fontWeight: 800, background: p.chipBg, border: `1px solid ${p.surfaceStrongBorder}`, color: p.text },
    loginInput: { width: "100%", padding: "14px 16px", borderRadius: 14, fontSize: 15.5, fontWeight: 600, background: p.chipBg, border: `1px solid ${p.surfaceStrongBorder}`, color: p.text, fontFamily: p.body, marginBottom: 4 },
    loginErr: { color: p.danger, fontSize: 13.5, fontWeight: 700, marginTop: 12 },
    loginTextBtn: { width: "100%", minHeight: 44, marginTop: 12, padding: "10px", background: "transparent", border: "none", color: p.textMuted, fontSize: 14.5, fontWeight: 700 },
    loginBusy: { display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "20px 0" },
    loginSpinner: { width: 38, height: 38, borderRadius: "50%", border: `3px solid ${feed}40`, borderTopColor: feed },
    loginBusyText: { fontSize: 15.5, fontWeight: 800, color: p.text },
    loginScanHint: { fontSize: 12.5, color: p.textFaint, fontWeight: 500 },
    loginFoot: { textAlign: "center", fontSize: 12.5, color: p.textFainter, fontWeight: 600, zIndex: 1, paddingBottom: 6 },
    loginVideo: { width: "100%", borderRadius: 18, background: "#000", aspectRatio: "1 / 1", objectFit: "cover" },
  };

  return {
    s,
    chipOn: (c) =>
      dark
        ? { background: `${c}26`, border: `1px solid ${c}`, color: c, boxShadow: `0 4px 16px ${c}33` }
        : { background: `${c}1f`, border: `1.5px solid ${c}`, color: c, boxShadow: `0 2px 0 ${c}55` },
    activeTile: (v) => ({
      boxShadow: `inset 0 0 0 1.5px ${v.accent}, 0 12px 44px ${v.glow}`,
      background: dark
        ? `linear-gradient(158deg, ${v.accent}26, ${v.accent}08 55%, ${p.tileBase})`
        : `linear-gradient(158deg, ${v.accent}1f, ${v.accent}08 55%, ${p.tileBase})`,
    }),
    runCardAccent: (v) => ({
      boxShadow: `inset 0 0 0 1px ${v.accent}40, 0 10px 36px ${v.glow}`,
      background: dark
        ? `linear-gradient(120deg, ${v.accent}14, ${p.tileBase} 60%)`
        : `linear-gradient(120deg, ${v.accent}12, ${p.tileBase} 55%)`,
    }),
    toastTone: (accent) => (dark && accent ? { boxShadow: `0 8px 30px ${accent}44`, border: `1px solid ${accent}66` } : {}),
  };
}
