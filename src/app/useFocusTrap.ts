/**
 * Focus trap for modal overlays (drawer + bottom sheets). While `active`, focus moves into
 * the container, Tab/Shift+Tab cycle within it, and focus is restored to the previously
 * focused element on close. Pair with `inert` on the rest of the page + an Escape handler.
 */
import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);

    // Move focus inside (the container itself is tabindex=-1 as a fallback).
    (focusables()[0] ?? el).focus();

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    el.addEventListener("keydown", onKeydown);
    return () => {
      el.removeEventListener("keydown", onKeydown);
      previouslyFocused?.focus?.();
    };
  }, [active]);

  return ref;
}
