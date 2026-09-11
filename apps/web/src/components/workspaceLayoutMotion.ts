import { useLayoutEffect, useRef } from "react";

import { WORKSPACE_MOTION_EASING, usePanelAnimationSettings } from "../panelAnimations";

export const WORKSPACE_LAYOUT_CHANGE_EVENT = "t3:workspace-layout-change";

const running = new Map<HTMLElement, () => void>();

/** Settings navigation can end this cosmetic settle before starting its own motion. */
export function cancelWorkspaceLayoutMotion(): void {
  for (const cancel of running.values()) cancel();
}

/** Soften only the changing surface; never dim its surrounding editor or conversation. */
export function settleWorkspaceLayout(target: HTMLElement, durationMs: number): () => void {
  running.get(target)?.();
  const ownerDocument = target.ownerDocument;
  if (
    durationMs <= 0 ||
    ownerDocument.hidden ||
    ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    target.querySelector("[data-browser-surface-slot], [data-native-browser-content='true']") ||
    typeof target.animate !== "function"
  ) {
    return () => {};
  }

  const animation = target.animate([{ opacity: 0.94 }, { opacity: 1 }], {
    duration: durationMs,
    easing: WORKSPACE_MOTION_EASING,
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (running.get(target) === cancel) running.delete(target);
    animation.removeEventListener("finish", release);
    animation.removeEventListener("cancel", release);
    ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
  };
  const cancel = () => {
    if (released) return;
    release();
    animation.cancel();
  };
  const onVisibilityChange = () => {
    if (ownerDocument.hidden) cancel();
  };
  running.set(target, cancel);
  animation.addEventListener("finish", release, { once: true });
  animation.addEventListener("cancel", release, { once: true });
  ownerDocument.addEventListener("visibilitychange", onVisibilityChange);
  return cancel;
}

/** Called by render owners, so keyboard, menu and store-driven changes share one path. */
export function useWorkspaceLayoutMotion({
  open,
  maximized = false,
  surface,
  enabled = true,
  scopeKey,
}: {
  open: boolean;
  maximized?: boolean;
  surface: "sidebar" | "right-panel";
  enabled?: boolean;
  scopeKey: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const previous = useRef({ open, maximized, scopeKey });
  const { active, durationMs, navigationSuppressed } = usePanelAnimationSettings();
  useLayoutEffect(() => {
    const sameScope = previous.current.scopeKey === scopeKey;
    const openChanged = sameScope && previous.current.open !== open;
    const changed = openChanged || (sameScope && previous.current.maximized !== maximized);
    previous.current = { open, maximized, scopeKey };
    const element = ref.current;
    if (changed && element && !navigationSuppressed) {
      element.ownerDocument.dispatchEvent(new Event(WORKSPACE_LAYOUT_CHANGE_EVENT));
    }
    const target =
      surface === "sidebar"
        ? element
            ?.closest("[data-slot='sidebar-wrapper']")
            ?.querySelector<HTMLElement>("[data-slot='sidebar-container']")
        : element?.querySelector<HTMLElement>("[data-preview-panel-mode='inline']");
    if (!target) return;
    if (!active || !enabled || !open) {
      running.get(target)?.();
      return;
    }
    if (!changed) return;
    return settleWorkspaceLayout(target, durationMs);
  }, [active, durationMs, enabled, maximized, navigationSuppressed, open, scopeKey, surface]);
  return ref;
}
