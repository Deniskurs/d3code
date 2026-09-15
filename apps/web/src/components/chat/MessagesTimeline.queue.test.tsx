// @vitest-environment happy-dom

import { EnvironmentId } from "@t3tools/contracts";
import { act, createRef, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QueuedComposerMessage } from "../../queuedMessageStore";
import { MessagesTimeline } from "./MessagesTimeline";

// Render the virtualized items without depending on browser viewport measurements.
// All queue rows, controls and tooltip behavior below are the real components.
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
  }) => (
    <div>
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
    </div>
  ),
}));

let container: HTMLDivElement;
let root: Root;
const send = vi.fn();
const remove = vi.fn();
const pause = vi.fn();
const baseProps: ComponentProps<typeof MessagesTimeline> = {
  isWorking: false,
  activeTurnStartedAt: null,
  listRef: createRef<LegendListRef | null>(),
  latestTurn: null,
  runningTurnId: null,
  turnDiffSummaries: [],
  routeThreadKey: "environment-local:thread-1",
  onOpenTurnDiff: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
  markdownCwd: undefined,
  resolvedTheme: "light",
  timestampFormat: "locale",
  workspaceRoot: undefined,
  anchorMessageId: null,
  onAnchorReady: () => {},
  contentInsetEndAdjustment: 0,
  liveFollowEnabled: true,
  onIsAtEndChange: () => {},
  onManualNavigation: () => {},
  timelineEntries: [],
  onSteerQueuedMessage: send,
  onRemoveQueuedMessage: remove,
  onPauseQueuedMessage: pause,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  send.mockClear();
  remove.mockClear();
  pause.mockClear();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderMessage(message: QueuedComposerMessage) {
  await act(() => root.render(<MessagesTimeline {...baseProps} queuedMessages={[message]} />));
}

function button(label: string): HTMLButtonElement {
  const element = [...container.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Expected the ${label} button`);
  return element;
}

describe("queued timeline actions", () => {
  it("allows explicit pause/resume/retry but never restores an attempted request as a new draft", async () => {
    let message: QueuedComposerMessage = {
      id: "queued-action",
      prompt: "Keep my saved request",
      images: [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      submissionIntent: "foreground",
      queuedAfterToolActivityId: null,
      createdAt: "2026-09-15T00:00:00.000Z",
    };
    await renderMessage(message);
    await act(() => button("Pause queued message").click());
    expect(pause).toHaveBeenLastCalledWith(message.id, true);

    message = { ...message, holdUntilUserAction: true };
    await renderMessage(message);
    await act(() => button("Resume queued message").click());
    expect(pause).toHaveBeenLastCalledWith(message.id, false);
    await act(() => button("Cancel and return to the composer").click());
    expect(remove).toHaveBeenCalledWith(message.id);

    message = {
      ...message,
      status: "failed",
      dispatchAttempted: true,
      error: "Connection lost after dispatch",
    };
    await renderMessage(message);
    expect(button("Cancel and return to the composer").disabled).toBe(true);
    expect(button("Resume queued message").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message.error);
    await act(() => button("Cancel and return to the composer").click());
    await act(() => button("Resume queued message").click());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(2);
    await act(() => button("Retry").click());
    expect(send).toHaveBeenCalledWith(message.id);

    message = { ...message, status: "submitted" };
    delete message.error;
    await renderMessage(message);
    expect(button("Retry").disabled).toBe(true);
    expect(button("Cancel and return to the composer").disabled).toBe(true);
    await act(() => button("Retry").click());
    expect(send).toHaveBeenCalledTimes(1);
  });
});
