import type { AnyRouter } from "@tanstack/react-router";

import { getClientSettings } from "./hooks/useSettings";
import { WORKSPACE_MOTION_EASING } from "./panelAnimations";
import {
  cancelWorkspaceLayoutMotion,
  WORKSPACE_LAYOUT_CHANGE_EVENT,
} from "./components/workspaceLayoutMotion";
import "./settingsRouteMotion.css";

type RouteChange = {
  fromLocation?: { pathname: string } | undefined;
  toLocation: { pathname: string };
};

type SettingsTransition = "settings-enter" | "settings-exit" | "settings-section";

function transitionType({ fromLocation, toLocation }: RouteChange): SettingsTransition | false {
  if (!fromLocation || fromLocation.pathname === toLocation.pathname) return false;
  const fromSettings =
    fromLocation.pathname === "/settings" || fromLocation.pathname.startsWith("/settings/");
  const toSettings =
    toLocation.pathname === "/settings" || toLocation.pathname.startsWith("/settings/");
  if (fromSettings && toSettings) return "settings-section";
  if (toSettings) return "settings-enter";
  return fromSettings ? "settings-exit" : false;
}

export function createSettingsRouteMotion() {
  // Router-core ignores the types callback in browsers without type support and
  // instead transitions every route. Gate the entire option, not just its callback.
  const supported =
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.CSS?.supports("selector(:active-view-transition-type(a))") === true;
  let cancelActive: (() => void) | undefined;
  const cancel = () => cancelActive?.();

  const defaultViewTransition = supported
    ? {
        types: (change: RouteChange): string[] | false => {
          const type = transitionType(change);
          if (
            !type ||
            document.visibilityState !== "visible" ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
            getClientSettings().panelAnimationDurationMs <= 0
          ) {
            return false;
          }
          return [type];
        },
      }
    : false;

  function attach(router: AnyRouter) {
    const originalStart = router.startViewTransition;
    // The router's stock seam discards the native handle. Own only this seam so
    // a later non-animated navigation can also release an in-flight snapshot.
    router.startViewTransition = (update) => {
      cancel();
      cancelWorkspaceLayoutMotion();
      if (router.shouldViewTransition !== undefined) {
        originalStart(update);
        return;
      }
      const types =
        defaultViewTransition &&
        defaultViewTransition.types({
          fromLocation: router.state.resolvedLocation,
          toLocation: router.latestLocation,
        });
      if (!types) {
        void update();
        return;
      }

      const root = document.documentElement;
      root.style.setProperty(
        "--settings-route-motion-duration",
        `${getClientSettings().panelAnimationDurationMs}ms`,
      );
      root.style.setProperty("--settings-route-motion-easing", WORKSPACE_MOTION_EASING);

      let updated = false;
      const updateOnce = () => {
        if (updated) return;
        updated = true;
        return update();
      };

      let transition: ViewTransition;
      try {
        transition = document.startViewTransition({ update: updateOnce, types });
      } catch {
        root.style.removeProperty("--settings-route-motion-duration");
        root.style.removeProperty("--settings-route-motion-easing");
        void updateOnce();
        return;
      }
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
      const cleanup = () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        document.removeEventListener(WORKSPACE_LAYOUT_CHANGE_EVENT, stop);
        window.removeEventListener("pagehide", stop);
        reducedMotion.removeEventListener("change", onReducedMotionChange);
        if (cancelActive === stop) {
          cancelActive = undefined;
          root.style.removeProperty("--settings-route-motion-duration");
          root.style.removeProperty("--settings-route-motion-easing");
        }
      };
      const stop = () => {
        transition.skipTransition();
        cleanup();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState !== "visible") stop();
      };
      const onReducedMotionChange = () => {
        if (reducedMotion.matches) stop();
      };
      cancelActive = stop;
      document.addEventListener("visibilitychange", onVisibilityChange);
      document.addEventListener(WORKSPACE_LAYOUT_CHANGE_EVENT, stop);
      window.addEventListener("pagehide", stop);
      reducedMotion.addEventListener("change", onReducedMotionChange);
      // Supersession and hidden documents reject ready; a failed route commit
      // may reject finished as well. Neither should become an unhandled rejection.
      void transition.ready.catch(() => undefined);
      void transition.finished.then(cleanup, cleanup);
    };
    const unsubscribe = router.subscribe("onBeforeLoad", cancel);
    return () => {
      cancel();
      unsubscribe();
      router.startViewTransition = originalStart;
    };
  }

  return { defaultViewTransition, attach } as const;
}
