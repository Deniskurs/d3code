// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PanelAnimationDurationProvider,
  PanelAnimationSuppressionProvider,
} from "../panelAnimations";
import {
  cancelWorkspaceLayoutMotion,
  useWorkspaceLayoutMotion,
  WORKSPACE_LAYOUT_CHANGE_EVENT,
} from "./workspaceLayoutMotion";
import { PanelAnimationsPreview } from "./settings/PanelAnimationsPreview";

const preferences = vi.hoisted(() => ({ reduced: false }));
vi.mock("../hooks/useMediaQuery", () => ({
  useMediaQuery: () => preferences.reduced,
}));

class TestAnimation extends EventTarget {
  cancel = vi.fn(() => this.dispatchEvent(new Event("cancel")));
  finish() {
    this.dispatchEvent(new Event("finish"));
  }
}

let root: Root;
let container: HTMLDivElement;
let hidden: boolean;
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
const animate = vi.fn(() => {
  const animation = new TestAnimation();
  animations.push(animation);
  return animation as unknown as Animation;
});
let animations: TestAnimation[];

function Workspace({
  layout,
  native = false,
  scope,
  surface = "right-panel",
}: {
  layout: string;
  native?: boolean;
  scope: string;
  surface?: "sidebar" | "right-panel";
}) {
  const open = layout !== "closed";
  const ref = useWorkspaceLayoutMotion({
    open,
    maximized: layout === "maximized",
    surface,
    scopeKey: scope,
  });
  return (
    <div data-slot="sidebar-wrapper">
      <aside data-slot="sidebar-container" hidden={!open}>
        Sidebar
      </aside>
      <main data-slot="sidebar-inset">
        <div ref={ref}>
          <input aria-label="Draft" defaultValue="Draft" />
          {open ? (
            <aside data-preview-panel-mode="inline">
              Panel content
              {native ? <div data-native-browser-content="true" /> : null}
            </aside>
          ) : null}
        </div>
      </main>
    </div>
  );
}

async function render(
  layout: string,
  {
    suppressed = false,
    duration = 250,
    native = false,
    scope = "thread",
    surface = "right-panel" as "sidebar" | "right-panel",
  } = {},
) {
  await act(() =>
    root.render(
      <PanelAnimationDurationProvider value={duration}>
        <PanelAnimationSuppressionProvider value={suppressed}>
          <Workspace layout={layout} native={native} scope={scope} surface={surface} />
        </PanelAnimationSuppressionProvider>
      </PanelAnimationDurationProvider>,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preferences.reduced = false;
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  animations = [];
  animate.mockClear();
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  cancelWorkspaceLayoutMotion();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("workspace layout settle", () => {
  it("does not animate restored layout and preserves editing through a cosmetic settle", async () => {
    await render("closed");
    expect(animate).not.toHaveBeenCalled();
    const input = container.querySelector("input")!;
    input.value = "Unsaved draft";
    input.focus();
    await render("open", { duration: 400 });
    expect(animate).toHaveBeenCalledWith(
      [{ opacity: expect.any(Number) }, { opacity: 1 }],
      expect.objectContaining({ duration: 400 }),
    );
    expect(animate.mock.contexts[0]).toBe(
      container.querySelector("[data-preview-panel-mode='inline']"),
    );
    expect(animate.mock.contexts[0]).not.toBe(container.querySelector("main"));
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Unsaved draft");
    await render("closed");
    expect(animate).toHaveBeenCalledOnce();
  });

  it("replaces rapid changes and releases completed animations before navigation cancellation", async () => {
    await render("closed");
    await render("open");
    await render("maximized");
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(animations).toHaveLength(2);
    animations[1]!.finish();
    cancelWorkspaceLayoutMotion();
    expect(animations[1]!.cancel).not.toHaveBeenCalled();
    await render("closed");
    expect(animations).toHaveLength(2);
    await render("open");
    cancelWorkspaceLayoutMotion();
    expect(animations[2]!.cancel).toHaveBeenCalledOnce();
  });

  it("cancels when hidden or motion becomes reduced without replay on resume", async () => {
    await render("closed");
    await render("open");
    hidden = true;
    await act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    await render("closed");
    hidden = false;
    await act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(animations).toHaveLength(1);
    await render("open");
    preferences.reduced = true;
    await render("open");
    expect(animations[1]!.cancel).toHaveBeenCalledOnce();
    await render("closed");
    expect(animations).toHaveLength(2);
  });

  it("skips navigation restores, zero duration and native browser content", async () => {
    await render("closed");
    await render("open", { suppressed: true });
    await render("open");
    await render("closed", { duration: 0 });
    await render("open", { native: true });
    expect(animate).not.toHaveBeenCalled();
  });

  it("invalidates snapshots only on same-scope geometry changes, even when settling is disabled", async () => {
    const onLayoutChange = vi.fn();
    document.addEventListener(WORKSPACE_LAYOUT_CHANGE_EVENT, onLayoutChange);
    try {
      await render("closed");
      await render("open", { scope: "next-thread", duration: 0 });
      expect(onLayoutChange).not.toHaveBeenCalled();
      await render("maximized", { scope: "next-thread", duration: 0 });
      expect(onLayoutChange).toHaveBeenCalledOnce();
      await render("closed", { scope: "next-thread", duration: 0 });
      expect(onLayoutChange).toHaveBeenCalledTimes(2);
      await render("open", { scope: "next-thread", native: true });
      expect(onLayoutChange).toHaveBeenCalledTimes(3);
      await act(() => root.render(null));
      expect(onLayoutChange).toHaveBeenCalledTimes(3);
    } finally {
      document.removeEventListener(WORKSPACE_LAYOUT_CHANGE_EVENT, onLayoutChange);
    }
  });

  it("does not cancel a route snapshot while restored panel state catches up", async () => {
    const onLayoutChange = vi.fn();
    document.addEventListener(WORKSPACE_LAYOUT_CHANGE_EVENT, onLayoutChange);
    try {
      await render("closed", { suppressed: true });
      await render("open", { suppressed: true });
      await render("open");
      expect(onLayoutChange).not.toHaveBeenCalled();
      expect(animate).not.toHaveBeenCalled();
      await render("closed");
      expect(onLayoutChange).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener(WORKSPACE_LAYOUT_CHANGE_EVENT, onLayoutChange);
    }
  });

  it("settles the sidebar itself without dimming the conversation", async () => {
    await render("closed", { surface: "sidebar" });
    await render("open", { surface: "sidebar" });
    expect(animate.mock.contexts[0]).toBe(
      container.querySelector("[data-slot='sidebar-container']"),
    );
    expect(animate.mock.contexts[0]).not.toBe(container.querySelector("main"));
    await render("closed", { surface: "sidebar" });
    expect(animate).toHaveBeenCalledOnce();
  });

  it("previews the same bounded motion without fading the surrounding Settings page", async () => {
    await act(() =>
      root.render(
        <PanelAnimationDurationProvider value={400}>
          <main data-slot="sidebar-inset">
            <PanelAnimationsPreview durationMs={400} />
          </main>
        </PanelAnimationDurationProvider>,
      ),
    );
    const preview = container.querySelector("button")!;
    await act(() => preview.click());
    expect(animate.mock.contexts[0]).toBe(preview);
    expect(animate).toHaveBeenCalledWith(
      [{ opacity: expect.any(Number) }, { opacity: 1 }],
      expect.objectContaining({ duration: 400 }),
    );
    await act(() => root.render(null));
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  });

  it("disposes running motion when its render owner unmounts", async () => {
    await render("closed");
    await render("open");
    await act(() => root.render(null));
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    cancelWorkspaceLayoutMotion();
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  });
});
