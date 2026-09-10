import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
/**
 * Upper bound as a fraction of the viewport; only binds on wide screens.
 * On narrow windows the container clamp below is what preserves the
 * sibling column's space.
 */
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;
/**
 * Width reserved for the sibling column (chat, pull-request list) sharing the
 * panel's flex row. The viewport fraction alone is not enough: the app
 * sidebar sits outside the row, so on narrow windows (any MacBook, even
 * fullscreen) the remaining 30% of the viewport minus the sidebar left the
 * sibling below its usable width and the composer overflowed.
 */
const SIBLING_COLUMN_MIN_WIDTH = 360;

export function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Never below the panel's own minimum: when the row cannot fit both
  // columns' minimums the sibling yields, and useResizableWidth's clamp
  // must not see max < min (it would resolve the inversion to min and,
  // via drag-end persistence, overwrite the user's stored width).
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}

/**
 * Shell for the preview panel. In inline mode the panel is user-resizable
 * via a drag handle on the left edge; width persists per browser. In
 * sheet/sidebar modes the parent owns the size.
 */
export function PreviewPanelShell(props: {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  /**
   * Overrides the localStorage key used to persist the panel width. Callers
   * embedding this shell for a different surface (e.g. the pull requests
   * page) should pass their own key so resizing one panel doesn't clobber
   * the other's remembered width.
   */
  widthStorageKey?: string;
  /** Overrides the initial width (px) before the user has resized the panel. */
  defaultWidth?: number;
  children: ReactNode;
}) {
  const useDragRegion = isElectron && props.mode !== "sheet" && props.mode !== "embedded";
  const isInline = props.mode === "inline";
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Only inline non-maximized mode applies `width`/`maxWidth`; skip the
  // container measurement (and its re-renders) everywhere else.
  const maxWidth = useClampedMaxWidth(hostRef, isInline && !maximized);
  const { width, handlers } = useResizableWidth({
    storageKey: props.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: props.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
  // The flex slot commits its final width once. Keep the closing shell at its
  // last painted width, outside layout, while presence finishes its fade.
  const [retainedWidth, setRetainedWidth] = useState(width);
  useLayoutEffect(() => {
    if (!open || !collapsible) return;
    const host = hostRef.current;
    if (host) setRetainedWidth(host.getBoundingClientRect().width);
  }, [collapsible, open, width, maxWidth, maximized]);
  return (
    <div
      ref={hostRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch",
        isInline ? (maximized && open ? "flex-1" : "shrink-0") : "w-full",
        collapsible && !open && "pointer-events-none",
      )}
      style={
        isInline
          ? {
              width: collapsible && !open ? "0px" : maximized ? "100%" : `${width}px`,
            }
          : undefined
      }
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={maximized ? "true" : "false"}
      inert={collapsible && !open}
    >
      {isInline && !maximized ? <RightPanelResizeHandle handlers={handlers} /> : null}
      <div
        className={cn(
          "relative flex h-full min-h-0 w-full flex-col bg-background",
          isInline && "border-l border-border",
          collapsible &&
            "overflow-clip motion-safe:transition-opacity motion-safe:[transition-timing-function:var(--panel-animation-easing,ease-out)]",
          collapsible &&
            open &&
            "opacity-100 motion-safe:[transition-duration:var(--panel-animation-duration,0ms)] [[data-panel-animations=true]_&]:motion-safe:starting:opacity-0",
          collapsible &&
            !open &&
            "absolute inset-y-0 right-0 z-10 opacity-0 motion-safe:[transition-duration:var(--panel-animation-exit-duration,0ms)]",
        )}
        style={collapsible && !open ? { width: `${retainedWidth}px` } : undefined}
      >
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {useDragRegion ? <div className="electron-drag-region h-0 w-full" aria-hidden /> : null}
          {props.children}
        </div>
      </div>
    </div>
  );
}

/**
 * Track viewport and flex-row widths to derive an upper bound for the panel.
 * Resize-aware so dragging the OS window narrower (or expanding the app
 * sidebar) re-clamps the stored width on the next render (the hook's clamp
 * picks this up automatically). The row is observed rather than the panel
 * itself because the panel competes with its sibling column for row space.
 * Row measurement only runs when `enabled`; modes without a resize handle
 * never apply the resulting width, so they skip the observer entirely.
 */
function useClampedMaxWidth(hostRef: RefObject<HTMLDivElement | null>, enabled: boolean): number {
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const onResize = () => {
      // Coalesce rapid resize events into one rAF tick.
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setVw(window.innerWidth);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);
  useLayoutEffect(() => {
    if (!enabled) return;
    const parent = hostRef.current?.parentElement;
    if (!parent) return;
    // Measure before first paint: the persisted width must be clamped
    // against the row on the initial render, not one observer tick later
    // (the panel would flash over-wide on every mount). clientWidth is
    // integral, so sub-pixel resize deltas bail out of re-rendering.
    const measure = () => {
      setContainerWidth(parent.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => {
      observer.disconnect();
    };
  }, [hostRef, enabled]);
  return getPreviewPanelMaxWidth(vw, containerWidth);
}
