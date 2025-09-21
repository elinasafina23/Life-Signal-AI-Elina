// src/hooks/use-mobile.ts
import { useEffect, useState } from "react";

const DEFAULT_MOBILE_BREAKPOINT = 768;

/**
 * Returns true when the viewport is narrower than `breakpoint` (default 768px).
 * - SSR-safe: returns false on the server, then updates on the client.
 * - Cross-browser: supports both modern `addEventListener('change')`
 *   and Safari’s older `addListener/removeListener`.
 * - Includes a window `resize` fallback.
 */
export function useIsMobile(breakpoint = DEFAULT_MOBILE_BREAKPOINT) {
  // On the server we can’t know the width → default to false.
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;

    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);

    // Read once and set immediately
    const handleChange = () => setIsMobile(mql.matches);
    handleChange();

    // Modern browsers
    if ("addEventListener" in mql) {
      mql.addEventListener("change", handleChange as EventListener);
    } else {
      // Safari fallback
      // @ts-ignore - older MediaQueryList types
      mql.addListener(handleChange);
    }

    // Extra safety: some mobile browsers don’t fire 'change'
    const onResize = () => setIsMobile(mql.matches);
    window.addEventListener("resize", onResize);

    return () => {
      if ("removeEventListener" in mql) {
        mql.removeEventListener("change", handleChange as EventListener);
      } else {
        // @ts-ignore - older MediaQueryList types
        mql.removeListener(handleChange);
      }
      window.removeEventListener("resize", onResize);
    };
  }, [breakpoint]);

  return isMobile;
}
