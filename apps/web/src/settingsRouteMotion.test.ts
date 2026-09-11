import type { AnyRouter } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

import { createSettingsRouteMotion } from "./settingsRouteMotion";

const settings = vi.hoisted(() => ({ panelAnimationDurationMs: 250 }));
vi.mock("./hooks/useSettings", () => ({ getClientSettings: () => settings }));

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createRuntime({ typesSupported = true, nativeSupported = true } = {}) {
  const documentEvents = new EventTarget();
  const windowEvents = new EventTarget();
  const mediaEvents = new EventTarget();
  const media = Object.assign(mediaEvents, { matches: false });
  const properties = new Map<string, string>();
  const transitions: Array<{
    ready: Deferred;
    finished: Deferred;
    skipTransition: Mock<() => void>;
  }> = [];
  const startViewTransition = vi.fn(({ update }: { update: () => Promise<void> }) => {
    const ready = deferred();
    const finished = deferred();
    const skipTransition = vi.fn(() => {
      ready.reject(new Error("Transition skipped"));
      finished.resolve();
    });
    transitions.push({ ready, finished, skipTransition });
    void update();
    return { ready: ready.promise, finished: finished.promise, skipTransition };
  });
  const document = Object.assign(documentEvents, {
    visibilityState: "visible",
    startViewTransition: nativeSupported ? startViewTransition : undefined,
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    },
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal(
    "window",
    Object.assign(windowEvents, {
      CSS: { supports: () => typesSupported },
      matchMedia: () => media,
    }),
  );
  return { document, media, properties, transitions, startViewTransition };
}

function attachMotion() {
  const motion = createSettingsRouteMotion();
  let onBeforeLoad: (() => void) | undefined;
  const unsubscribe = vi.fn(() => {
    onBeforeLoad = undefined;
  });
  const originalStart = vi.fn((update: () => Promise<void>) => void update());
  const router = {
    options: { defaultViewTransition: motion.defaultViewTransition },
    state: { resolvedLocation: { pathname: "/chat" } },
    latestLocation: { pathname: "/settings/general" },
    shouldViewTransition: undefined as unknown,
    startViewTransition: originalStart as (update: () => Promise<void>) => void,
    subscribe: (_event: string, listener: () => void) => {
      onBeforeLoad = listener;
      return unsubscribe;
    },
  };
  const dispose = motion.attach(router as unknown as AnyRouter);
  return { router, dispose, originalStart, beforeLoad: () => onBeforeLoad?.(), unsubscribe };
}

beforeEach(() => {
  settings.panelAnimationDurationMs = 250;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings route motion eligibility", () => {
  it("distinguishes opening, leaving, and changing sections", () => {
    createRuntime();
    const option = createSettingsRouteMotion().defaultViewTransition;
    if (!option) throw new Error("Expected typed view transition support");
    expect(
      option.types({
        fromLocation: { pathname: "/chat" },
        toLocation: { pathname: "/settings/general" },
      }),
    ).toEqual(["settings-enter"]);
    expect(
      option.types({
        fromLocation: { pathname: "/settings/general" },
        toLocation: { pathname: "/chat" },
      }),
    ).toEqual(["settings-exit"]);
    expect(
      option.types({
        fromLocation: { pathname: "/settings/general" },
        toLocation: { pathname: "/settings/providers" },
      }),
    ).toEqual(["settings-section"]);
  });

  it("excludes initial navigation, hash/search changes, and ordinary chat routes", () => {
    createRuntime();
    const option = createSettingsRouteMotion().defaultViewTransition;
    if (!option) throw new Error("Expected typed view transition support");
    for (const change of [
      { toLocation: { pathname: "/settings/general" } },
      {
        fromLocation: { pathname: "/settings/general" },
        toLocation: { pathname: "/settings/general" },
      },
      { fromLocation: { pathname: "/chat/one" }, toLocation: { pathname: "/chat/two" } },
      { fromLocation: { pathname: "/chat" }, toLocation: { pathname: "/settings-other" } },
    ]) {
      expect(option.types(change)).toBe(false);
    }
  });

  it.each([{ typesSupported: false }, { nativeSupported: false }])(
    "disables the entire router option on unsupported runtimes: %j",
    (support) => {
      const runtime = createRuntime(support);
      const { router, dispose } = attachMotion();
      const update = vi.fn(async () => undefined);
      expect(router.options.defaultViewTransition).toBe(false);
      router.startViewTransition(update);
      expect(update).toHaveBeenCalledOnce();
      expect(runtime.startViewTransition).not.toHaveBeenCalled();
      dispose();
    },
  );

  it.each(["zero", "reduced", "hidden"])("commits immediately for %s motion", (reason) => {
    const runtime = createRuntime();
    const { router, dispose } = attachMotion();
    if (reason === "zero") settings.panelAnimationDurationMs = 0;
    if (reason === "reduced") runtime.media.matches = true;
    if (reason === "hidden") runtime.document.visibilityState = "hidden";
    const update = vi.fn(async () => undefined);
    router.startViewTransition(update);
    expect(update).toHaveBeenCalledOnce();
    expect(runtime.startViewTransition).not.toHaveBeenCalled();
    dispose();
  });
});

describe("Settings route motion lifetime", () => {
  it("releases the old snapshot as soon as another navigation starts, even without new motion", async () => {
    const runtime = createRuntime();
    const { router, beforeLoad, dispose } = attachMotion();
    router.startViewTransition(async () => undefined);
    beforeLoad();
    router.state.resolvedLocation.pathname = "/chat/one";
    router.latestLocation.pathname = "/chat/two";
    const update = vi.fn(async () => undefined);
    router.startViewTransition(update);
    await Promise.resolve();
    expect(runtime.transitions[0]?.skipTransition).toHaveBeenCalledOnce();
    expect(runtime.startViewTransition).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(runtime.properties.size).toBe(0);
    dispose();
  });

  it("does not let an old completion clean up a superseding transition", async () => {
    const runtime = createRuntime();
    const { router, dispose } = attachMotion();
    router.startViewTransition(async () => undefined);
    router.state.resolvedLocation.pathname = "/settings/general";
    router.latestLocation.pathname = "/chat";
    router.startViewTransition(async () => undefined);
    await Promise.resolve();
    expect(runtime.properties.get("--settings-route-motion-duration")).toBe("250ms");
    runtime.transitions[1]?.ready.resolve();
    runtime.transitions[1]?.finished.resolve();
    await Promise.resolve();
    expect(runtime.properties.size).toBe(0);
    dispose();
  });

  it.each(["hidden", "reduced", "dispose"])(
    "cancels and releases listeners on %s",
    async (reason) => {
      const runtime = createRuntime();
      const { router, dispose, unsubscribe } = attachMotion();
      router.startViewTransition(async () => undefined);
      if (reason === "hidden") {
        runtime.document.visibilityState = "hidden";
        runtime.document.dispatchEvent(new Event("visibilitychange"));
      } else if (reason === "reduced") {
        runtime.media.matches = true;
        runtime.media.dispatchEvent(new Event("change"));
      } else {
        dispose();
        expect(unsubscribe).toHaveBeenCalledOnce();
      }
      await Promise.resolve();
      runtime.document.dispatchEvent(new Event("visibilitychange"));
      runtime.media.dispatchEvent(new Event("change"));
      expect(runtime.transitions[0]?.skipTransition).toHaveBeenCalledOnce();
      expect(runtime.properties.size).toBe(0);
      if (reason !== "dispose") dispose();
    },
  );

  it("commits navigation immediately if native presentation cannot start", () => {
    const runtime = createRuntime();
    const { router, dispose } = attachMotion();
    runtime.startViewTransition.mockImplementationOnce(() => {
      throw new DOMException("Document is no longer active", "InvalidStateError");
    });
    let visibleRoute = "/chat";
    router.startViewTransition(async () => {
      visibleRoute = router.latestLocation.pathname;
    });
    expect(visibleRoute).toBe("/settings/general");
    expect(runtime.properties.size).toBe(0);
    dispose();
  });

  it("preserves explicit per-navigation overrides through the router's original seam", () => {
    const runtime = createRuntime();
    const { router, originalStart, dispose } = attachMotion();
    const update = vi.fn(async () => undefined);
    router.shouldViewTransition = false;
    router.startViewTransition(update);
    expect(originalStart).toHaveBeenCalledWith(update);
    expect(update).toHaveBeenCalledOnce();
    expect(runtime.startViewTransition).not.toHaveBeenCalled();
    dispose();
  });
});
