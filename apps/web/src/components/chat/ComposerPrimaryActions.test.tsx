// @vitest-environment happy-dom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerActionMotion } from "./ComposerActionMotion";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

type ActionProps = ComponentProps<typeof ComposerPrimaryActions>;

let container: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn();
const onPreviousPendingQuestion = vi.fn();
const onInterrupt = vi.fn();
const onImplementPlanInNewThread = vi.fn();
const onDeliveryModeChange = vi.fn();

const baseProps: ActionProps = {
  compact: false,
  pendingAction: null,
  isRunning: false,
  showPlanFollowUpPrompt: false,
  promptHasText: false,
  isSendBusy: false,
  sendDisabledReason: null,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  showSendWhileRunning: true,
  deliveryMode: "steer",
  onDeliveryModeChange,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
};

async function renderActions(change: Partial<ActionProps> = {}) {
  await act(() => {
    root.render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <ComposerPrimaryActions {...baseProps} {...change} />
      </form>,
    );
  });
}

function buttonNamed(name: string) {
  return [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  );
}

function getButton(name: string) {
  const button = buttonNamed(name);
  if (!button) throw new Error(`Expected a ${name} button`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(() => button.click());
}

async function flushObservers() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onSubmit.mockClear();
  onPreviousPendingQuestion.mockClear();
  onInterrupt.mockClear();
  onImplementPlanInNewThread.mockClear();
  onDeliveryModeChange.mockClear();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ComposerPrimaryActions", () => {
  it("keeps pending actions ahead of plan and normal actions, then exposes each next state", async () => {
    await renderActions({
      isRunning: true,
      showPlanFollowUpPrompt: true,
      pendingAction: {
        questionIndex: 1,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
    });

    expect(getButton("Stop generation").disabled).toBe(false);
    expect(getButton("Previous").disabled).toBe(false);
    expect(getButton("Submit answers").disabled).toBe(false);
    expect(buttonNamed("Implement")).toBeUndefined();
    expect(buttonNamed("Send message")).toBeUndefined();
    await click(getButton("Previous"));
    await click(getButton("Stop generation"));
    await click(getButton("Submit answers"));
    expect(onPreviousPendingQuestion).toHaveBeenCalledOnce();
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();

    await renderActions({ showPlanFollowUpPrompt: true });
    expect(getButton("Implement").disabled).toBe(false);
    expect(getButton("Implementation actions").disabled).toBe(false);
    expect(buttonNamed("Stop generation")).toBeUndefined();
    expect(buttonNamed("Send message")).toBeUndefined();
    await click(getButton("Implement"));
    expect(onSubmit).toHaveBeenCalledTimes(2);

    await renderActions({ showPlanFollowUpPrompt: true, promptHasText: true });
    expect(getButton("Refine").disabled).toBe(false);
    expect(buttonNamed("Implementation actions")).toBeUndefined();

    await renderActions();
    expect(getButton("Send message").disabled).toBe(false);
    expect(getButton("Choose message delivery").disabled).toBe(false);
    expect(buttonNamed("Refine")).toBeUndefined();
  });

  it("suppresses empty running sends and keeps unavailable or busy actions inert", async () => {
    await renderActions({ isRunning: true, hasSendableContent: false });
    expect(getButton("Stop generation").disabled).toBe(false);
    expect(buttonNamed("Send message")).toBeUndefined();

    await renderActions({ isRunning: true, hasSendableContent: true });
    expect(getButton("Stop generation").disabled).toBe(false);
    await click(getButton("Send message"));
    expect(onSubmit).toHaveBeenCalledOnce();

    await renderActions({ isEnvironmentUnavailable: true });
    const disconnectedSend = getButton("Environment disconnected");
    const disconnectedMenu = getButton("Choose message delivery");
    expect(disconnectedSend.disabled).toBe(true);
    expect(disconnectedMenu.disabled).toBe(true);
    await click(disconnectedSend);
    await click(disconnectedMenu);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Queue after task");

    await renderActions({ isSendBusy: true });
    expect(getButton("Sending").disabled).toBe(true);
    expect(getButton("Choose message delivery").disabled).toBe(true);
  });

  it("updates motion only when the real action rail changes", async () => {
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      right: 32,
      top: 0,
      bottom: 32,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    const actionProps = { ...baseProps };
    const rail = (renderToken: number, props: ActionProps): ReactNode => {
      void renderToken;
      return (
        <ComposerActionMotion>
          <ComposerPrimaryActions {...props} />
        </ComposerActionMotion>
      );
    };

    await act(() => root.render(rail(0, actionProps)));
    await flushObservers();
    geometry.mockClear();

    await act(() => root.render(rail(1, actionProps)));
    await flushObservers();
    expect(geometry).not.toHaveBeenCalled();

    await act(() => root.render(rail(2, { ...actionProps, hasSendableContent: false })));
    await flushObservers();
    expect(geometry).toHaveBeenCalled();
  });
});
