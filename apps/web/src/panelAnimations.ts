import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DEFAULT_CLIENT_SETTINGS,
  type PanelAnimationDurationMs,
} from "@t3tools/contracts/settings";

import { useMediaQuery } from "./hooks/useMediaQuery";

export const PANEL_MOTION_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
export const WORKSPACE_MOTION_EASING = "cubic-bezier(0, 0, 0.58, 1)";

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || !document.hidden;
}

function subscribeToDocumentVisibility(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const PanelAnimationDurationContext = createContext(
  DEFAULT_CLIENT_SETTINGS.panelAnimationDurationMs,
);
export const PanelAnimationDurationProvider = PanelAnimationDurationContext.Provider;

const PanelAnimationSuppressionContext = createContext(false);

export const PanelAnimationSuppressionProvider = PanelAnimationSuppressionContext.Provider;

/**
 * Suppresses panel motion for the first painted frame of an initial route or navigation.
 * State restored by a route must be visible immediately; later user actions can animate.
 */
export function usePanelNavigationSuppression(navigationKey: string): boolean {
  const [paintedNavigationKey, setPaintedNavigationKey] = useState<string | null>(null);
  const suppressed = paintedNavigationKey !== navigationKey;

  useEffect(() => {
    if (!suppressed) return;
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() => setPaintedNavigationKey(navigationKey));
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [navigationKey, suppressed]);

  return suppressed;
}

export function observeResponsiveBreakpointFade(options: {
  target: HTMLElement;
  container: HTMLElement;
  active: boolean;
  durationMs: PanelAnimationDurationMs;
  breakpoint: { value: number; unit: "px" | "rem" };
}): () => void {
  const { target, container, active, durationMs, breakpoint } = options;
  if (!active || typeof ResizeObserver === "undefined" || typeof target.animate !== "function")
    return () => {};

  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const breakpointPx =
    breakpoint.unit === "px"
      ? breakpoint.value
      : breakpoint.value * (Number.isFinite(rootFontSize) ? rootFontSize : 16);
  let expanded = container.getBoundingClientRect().width >= breakpointPx;
  let animation: Animation | null = null;

  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const nextExpanded = entry.contentRect.width >= breakpointPx;
    if (nextExpanded === expanded) return;
    expanded = nextExpanded;
    animation?.cancel();
    if (target.ownerDocument.hidden) return;
    const nextAnimation = target.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: durationMs,
      easing: PANEL_MOTION_EASING,
    });
    animation = nextAnimation;
    const release = () => {
      if (animation === nextAnimation) animation = null;
      nextAnimation.removeEventListener("finish", release);
      nextAnimation.removeEventListener("cancel", release);
    };
    nextAnimation.addEventListener("finish", release, { once: true });
    nextAnimation.addEventListener("cancel", release, { once: true });
  });

  observer.observe(container);
  return () => {
    observer.disconnect();
    animation?.cancel();
  };
}

export function usePanelAnimationSettings(): {
  active: boolean;
  durationMs: PanelAnimationDurationMs;
  navigationSuppressed: boolean;
} {
  const durationMs = useContext(PanelAnimationDurationContext);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const visible = useSyncExternalStore(
    subscribeToDocumentVisibility,
    isDocumentVisible,
    () => true,
  );
  const suppressed = useContext(PanelAnimationSuppressionContext);
  return {
    active: durationMs > 0 && !prefersReducedMotion && !suppressed && visible,
    durationMs,
    navigationSuppressed: suppressed,
  };
}

/** Keeps closing panel content mounted only for its exit transition. */
export function usePanelPresence<T>(
  open: boolean,
  value: T | null,
  animated: boolean,
  scopeKey: string | null,
  durationMs: PanelAnimationDurationMs,
): { present: boolean; value: T | null } {
  const [present, setPresent] = useState(open);
  const retainedRef = useRef<{ scopeKey: string | null; value: T | null } | null>(
    open ? { scopeKey, value } : null,
  );

  useEffect(() => {
    if (open) retainedRef.current = { scopeKey, value };
  }, [open, scopeKey, value]);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (
      !animated ||
      durationMs === 0 ||
      !present ||
      retainedRef.current?.scopeKey !== scopeKey ||
      !isDocumentVisible()
    ) {
      setPresent(false);
      return;
    }

    const unsubscribe = subscribeToDocumentVisibility(() => {
      if (!isDocumentVisible()) setPresent(false);
    });
    const timeout = window.setTimeout(() => setPresent(false), durationMs);
    return () => {
      window.clearTimeout(timeout);
      unsubscribe();
    };
  }, [animated, durationMs, open, present, scopeKey]);

  const retainedValue =
    retainedRef.current?.scopeKey === scopeKey ? retainedRef.current.value : null;
  const visible =
    open || (animated && durationMs > 0 && present && retainedRef.current?.scopeKey === scopeKey);
  return { present: visible, value: open ? value : visible ? retainedValue : null };
}
