import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import { createSettingsRouteMotion } from "./settingsRouteMotion";

export function getRouter(history: RouterHistory) {
  const settingsMotion = createSettingsRouteMotion();
  const router = createRouter({
    routeTree,
    history,
    context: {},
    defaultViewTransition: settingsMotion.defaultViewTransition,
    // Route components are split chunks (autoCodeSplitting in vite.config);
    // fetching them on hover/focus intent hides the load from the first
    // settings or pull-request navigation.
    defaultPreload: "intent",
  });
  const disposeSettingsMotion = settingsMotion.attach(router);
  import.meta.hot?.dispose(disposeSettingsMotion);
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
