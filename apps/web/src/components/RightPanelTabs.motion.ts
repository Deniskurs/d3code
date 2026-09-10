import { getPanelMotionDuration, PANEL_MOTION_EASING } from "~/panelAnimations";

type TabGeometry = { x: number; y: number; width: number; height: number };

export interface RightPanelTabMotionController {
  measure: (move?: boolean) => void;
  update: (activeId: string | null, durationMs: number, nativeContent: boolean) => void;
  dispose: () => void;
}

/** Owns only the tab background and the existing DOM content's brief fade. */
export function createRightPanelTabMotion(
  row: HTMLElement,
  indicator: HTMLElement,
  content: HTMLElement,
): RightPanelTabMotionController {
  const document = row.ownerDocument;
  const view = document.defaultView;
  const reducedMotion = view?.matchMedia?.("(prefers-reduced-motion: reduce)");
  const animations = new Map<HTMLElement, () => void>();
  let geometry: TabGeometry | null = null;
  let activeId: string | null | undefined;
  let durationMs = 0;
  let disposed = false;

  const cancel = (node: HTMLElement) => animations.get(node)?.();
  const settle = () => {
    for (const node of animations.keys()) cancel(node);
  };
  const enabled = () => durationMs > 0 && !document.hidden && !reducedMotion?.matches;
  const animate = (node: HTMLElement, frames: Keyframe[], duration: number) => {
    if (!node.animate) return;
    const animation = node.animate(frames, { duration, easing: PANEL_MOTION_EASING });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (animations.get(node) === release) animations.delete(node);
      animation.removeEventListener("finish", release);
      animation.removeEventListener("cancel", release);
      // Release the effect as well as the handle; the underlying styles are final.
      animation.cancel();
    };
    animations.set(node, release);
    animation.addEventListener("finish", release, { once: true });
    animation.addEventListener("cancel", release, { once: true });
  };

  function measure(move = false) {
    if (disposed || document.hidden) return;
    const tab = row.querySelector<HTMLElement>("[data-active-tab='true']");
    if (!tab || tab.offsetWidth === 0) {
      cancel(indicator);
      geometry = null;
      indicator.style.visibility = "hidden";
      return;
    }
    const next = {
      x: tab.offsetLeft,
      y: tab.offsetTop,
      width: tab.offsetWidth,
      height: tab.offsetHeight,
    };
    if (
      geometry?.x === next.x &&
      geometry.y === next.y &&
      geometry.width === next.width &&
      geometry.height === next.height
    )
      return;

    let previous = geometry;
    if (move && enabled() && animations.has(indicator)) {
      const current = indicator.getBoundingClientRect();
      const origin = row.getBoundingClientRect();
      previous = {
        x: current.left - origin.left,
        y: current.top - origin.top,
        width: current.width,
        height: current.height,
      };
    }
    cancel(indicator);
    geometry = next;
    const transform = `translate(${next.x}px, ${next.y}px)`;
    Object.assign(indicator.style, {
      visibility: "visible",
      width: `${next.width}px`,
      height: `${next.height}px`,
      transform,
    });
    if (previous && move && enabled()) {
      animate(
        indicator,
        [
          {
            transform: `translate(${previous.x}px, ${previous.y}px) scale(${previous.width / next.width}, ${previous.height / next.height})`,
          },
          { transform },
        ],
        getPanelMotionDuration(durationMs, "enter"),
      );
    }
  }

  const reset = () => {
    settle();
    measure();
  };
  document.addEventListener("visibilitychange", reset);
  reducedMotion?.addEventListener("change", reset);

  return {
    measure,
    update(nextId: string | null, nextDurationMs: number, nativeContent: boolean) {
      if (disposed) return;
      const changed = activeId !== undefined && activeId !== nextId;
      activeId = nextId;
      durationMs = nextDurationMs;
      if (!enabled()) settle();
      measure(changed);
      if (!changed) return;
      const opacity = animations.has(content) ? view?.getComputedStyle(content).opacity : "0.86";
      cancel(content);
      // Electron webContents live outside this DOM: animate their tab chrome only.
      if (nativeContent || !enabled()) return;
      animate(
        content,
        [{ opacity: opacity ?? "0.86" }, { opacity: 1 }],
        getPanelMotionDuration(durationMs, "content"),
      );
    },
    dispose() {
      disposed = true;
      settle();
      document.removeEventListener("visibilitychange", reset);
      reducedMotion?.removeEventListener("change", reset);
    },
  };
}
