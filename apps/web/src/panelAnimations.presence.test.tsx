// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PanelAnimationDurationProvider,
  usePanelAnimationSettings,
  usePanelPresence,
} from "./panelAnimations";

const preferences = vi.hoisted(() => ({ duration: 250, reducedMotion: false }));
vi.mock("./hooks/useMediaQuery", () => ({
  useMediaQuery: () => preferences.reducedMotion,
}));

let root: Root;
let container: HTMLDivElement;
let hidden: boolean;

function Panel({ open, scope = "first" }: { open: boolean; scope?: string }) {
  const { active, durationMs } = usePanelAnimationSettings();
  const presence = usePanelPresence(open, open ? scope : null, active, scope, durationMs);
  return presence.present ? (
    <input aria-label="Panel draft" defaultValue={presence.value ?? ""} />
  ) : null;
}

async function render(open: boolean, scope = "first") {
  await act(() =>
    root.render(
      <PanelAnimationDurationProvider value={preferences.duration}>
        <Panel open={open} scope={scope} />
      </PanelAnimationDurationProvider>,
    ),
  );
}

async function advance(milliseconds: number) {
  await act(() => vi.advanceTimersByTime(milliseconds));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hidden = false;
  preferences.duration = 250;
  preferences.reducedMotion = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("panel motion lifetime", () => {
  it("does no timed work while closed and releases retained content at the shorter exit", async () => {
    await render(false);
    expect(container.querySelector("input")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await render(true);
    await render(false);
    expect(container.querySelector("input")?.value).toBe("first");
    await advance(179);
    expect(container.querySelector("input")).not.toBeNull();
    await advance(1);
    expect(container.querySelector("input")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await advance(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an obsolete exit on reversal without losing the user's draft or focus", async () => {
    await render(true);
    const input = container.querySelector("input")!;
    input.value = "Unsaved text";
    input.focus();
    await render(false);
    await advance(90);
    await render(true);
    expect(vi.getTimerCount()).toBe(0);
    await advance(1_000);
    expect(container.querySelector("input")?.value).toBe("Unsaved text");
    expect(document.activeElement).toBe(input);
  });

  it("drops closing content immediately when its environment or thread scope changes", async () => {
    await render(true);
    await render(false);
    await render(false, "second");
    expect(container.querySelector("input")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await render(true, "second");
    await advance(1_000);
    expect(container.querySelector("input")?.value).toBe("second");
  });

  it("finishes a closing surface when hidden and does not replay it on return", async () => {
    await render(true);
    await render(false);
    await act(() => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.querySelector("input")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await act(() => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.querySelector("input")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["zero duration", "reduced motion"])(
    "honors %s without scheduling an exit",
    async (mode) => {
      if (mode === "zero duration") preferences.duration = 0;
      else preferences.reducedMotion = true;
      await render(true);
      await render(false);
      expect(container.querySelector("input")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels its pending exit when the owner unmounts", async () => {
    await render(true);
    await render(false);
    await act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
});
