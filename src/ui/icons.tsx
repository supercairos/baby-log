/**
 * Inline SVG glyphs — ported verbatim from the mockups (no icon dependency). Activity
 * glyphs are hand-drawn because Lucide/Phosphor lack good "diaper"/"tummy time" icons.
 */
import type { SVGProps } from "react";
import type { ActivityKey } from "../api";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...p }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      {children}
    </svg>
  );
}

export const BottleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4h6l-1 2.5a2 2 0 0 0 .6 1.4l.4.4a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V9.7a2 2 0 0 1 .6-1.4l.4-.4A2 2 0 0 0 10 6.5L9 4Z" />
    <path d="M9.5 11h5M9.5 14h5" />
  </Svg>
);

/**
 * Baby Log brand mark — the filled bottle from the PWA icon (cream body, honey ticks).
 * Render on the warm gradient tile (e.g. the login hero) so it matches the app/home-screen
 * icon. Fixed colors (not currentColor) so it looks identical in both themes.
 */
export const BabyLogMark = ({ size = 64, ...p }: IconProps) => (
  <svg viewBox="0 0 512 512" width={size} height={size} fill="none" {...p}>
    <rect x="240" y="110" width="32" height="40" rx="16" fill="#fff5e9" />
    <rect x="221" y="146" width="70" height="28" rx="11" fill="#fff5e9" />
    <rect x="221" y="166" width="70" height="16" fill="#fff5e9" />
    <rect x="194" y="176" width="124" height="244" rx="48" fill="#fff5e9" />
    <rect x="250" y="288" width="54" height="11" rx="5.5" fill="#e6986b" />
    <rect x="250" y="320" width="40" height="11" rx="5.5" fill="#e6986b" />
  </svg>
);
export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 13.5A8 8 0 1 1 10.5 4a6.2 6.2 0 0 0 9.5 9.5Z" />
  </Svg>
);
export const DropIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5s6 6.4 6 10.2A6 6 0 0 1 6 13.7C6 9.9 12 3.5 12 3.5Z" />
  </Svg>
);
export const TummyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="2.4" />
    <path d="M5 19c0-3.2 2-5.4 4.6-5.4 1.4 0 2.3.6 3.4 1.6 1.3 1.2 2.6 1.7 4.4 1.7" />
  </Svg>
);

/** Medication — a two-tone capsule laid on the bottom-left→top-right diagonal, split across
 *  the middle. Hand-drawn (Lucide/Phosphor "pill" reads poorly at small sizes here). */
export const PillIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="8" width="18" height="8" rx="4" transform="rotate(-45 12 12)" />
    <path d="M9 9l6 6" />
  </Svg>
);

export const SunriseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2v6M4.93 12.93l1.41 1.41M2 18h2M20 18h2M19.07 12.93l-1.41 1.41M22 22H2M8 6l4-4 4 4" />
    <path d="M16 18a4 4 0 0 0-8 0" />
  </Svg>
);

export const SunsetIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 8V2M4.93 12.93l1.41 1.41M2 18h2M20 18h2M19.07 12.93l-1.41 1.41M22 22H2M16 6l-4 4-4-4" />
    <path d="M16 18a4 4 0 0 0-8 0" />
  </Svg>
);

export const MenuIcon = (p: IconProps) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);
export const EditIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);
export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
  </Svg>
);
export const PlusIcon = (p: IconProps) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
/** Stop glyph — a filled rounded square inside a ring (the running-timer "tap to stop"). */
export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <rect x="8.5" y="8.5" width="7" height="7" rx="1.6" fill="currentColor" />
  </Svg>
);
export const ClockIcon = (p: IconProps) => (
  <Svg strokeWidth={1.6} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 11l9-8 9 8M5 10v10h14V10" />
  </Svg>
);
export const TimelineIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </Svg>
);
export const DisconnectIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </Svg>
);
export const ScanIcon = (p: IconProps) => (
  <Svg strokeWidth={1.9} {...p}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
  </Svg>
);
export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </Svg>
);
export const InstallIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
  </Svg>
);
export const ThemeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </Svg>
);
export const GlobeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18" />
  </Svg>
);

// eslint-disable-next-line react-refresh/only-export-components -- icon map co-located with its glyphs
export const ACTIVITY_ICON: Record<ActivityKey, (p: IconProps) => React.ReactElement> = {
  feeding: BottleIcon,
  sleep: MoonIcon,
  diaper: DropIcon,
  tummy: TummyIcon,
  medication: PillIcon,
};
