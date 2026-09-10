// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { TooltipProvider } from "../components/ui/tooltip";
import { outboxDeliveryState, type OutboxMessage } from "./model";
import { OutboxPanel } from "./OutboxPanel";

const state = vi.hoisted(() => ({
  messages: [] as OutboxMessage[],
  thread: undefined as OrchestrationThreadShell | undefined,
  connected: true,
  live: true,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ status: state.live ? "live" : "syncing" }),
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connected ? "connected" : "disconnected" } }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => state.thread,
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: () => null },
}));
vi.mock("./store", () => ({
  useOutbox: () => state.messages,
  mutateOutbox: async (
    id: string,
    update: (current: OutboxMessage | undefined) => OutboxMessage | undefined,
  ) => {
    const next = update(state.messages.find((message) => message.id === id));
    state.messages = state.messages.flatMap((message) =>
      message.id === id ? (next ? [next] : []) : [message],
    );
    return next;
  },
}));

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const queuedMessage: OutboxMessage = {
  id: "queued-message",
  environmentId,
  queuedAt: "2026-09-09T10:00:00.000Z",
  status: "waiting",
  input: {
    commandId: CommandId.make("queued-command"),
    threadId,
    message: {
      messageId: MessageId.make("queued-message"),
      role: "user",
      text: "Check the failing build first",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-09T10:01:00.000Z",
  },
};
const runningThread = {
  archivedAt: null,
  session: { status: "running" },
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
} as OrchestrationThreadShell;

let container: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn();

async function renderPanel() {
  await act(() => {
    root.render(
      <TooltipProvider>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <OutboxPanel environmentId={environmentId} threadId={threadId} />
        </form>
      </TooltipProvider>,
    );
  });
}

function getButton(name: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Expected a ${name} button`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
  await renderPanel();
}

function deliveryState() {
  const message = state.messages[0];
  if (!message) throw new Error("Expected a queued message");
  return outboxDeliveryState(message, state.thread, state.connected, state.live);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.messages = [queuedMessage];
  state.thread = runningThread;
  state.connected = true;
  state.live = true;
  onSubmit.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("OutboxPanel Send now", () => {
  it("makes a waiting message eligible during a task without submitting the composer", async () => {
    await renderPanel();
    expect(deliveryState()).toBe("waiting");
    const sendNow = getButton("Send queued message now");
    expect(sendNow.textContent?.trim()).toBe("Send now");
    await act(() => sendNow.focus());
    expect(document.activeElement).toBe(sendNow);
    await click(sendNow);

    expect(deliveryState()).toBe("send");
    expect(state.messages[0]?.input.commandId).toBe(queuedMessage.input.commandId);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("explicitly resumes a paused message after an error without changing its content", async () => {
    state.messages = [{ ...queuedMessage, status: "paused" }];
    state.thread = {
      ...runningThread,
      session: { ...runningThread.session!, status: "error" },
    };
    await renderPanel();
    expect(deliveryState()).toBe("paused");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Paused");
    await click(getButton("Send queued message now"));

    expect(deliveryState()).toBe("send");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(getButton(queuedMessage.input.message.text).disabled).toBe(false);
    expect(state.messages[0]?.input).toEqual(queuedMessage.input);
  });

  it.each(["approval", "question", "disconnected", "syncing", "archived", "missing"] as const)(
    "keeps Send now inert while %s blocks delivery",
    async (guard) => {
      state.messages = [{ ...queuedMessage, status: "paused" }];
      if (guard === "approval") state.thread = { ...runningThread, hasPendingApprovals: true };
      if (guard === "question") state.thread = { ...runningThread, hasPendingUserInput: true };
      if (guard === "disconnected") state.connected = false;
      if (guard === "syncing") state.live = false;
      if (guard === "archived")
        state.thread = { ...runningThread, archivedAt: "2026-09-09T11:00:00.000Z" };
      if (guard === "missing") state.thread = undefined;
      await renderPanel();

      const sendNow = getButton("Send queued message now");
      expect(sendNow.disabled).toBe(true);
      await click(sendNow);
      expect(state.messages[0]?.sendNow).toBeUndefined();
      expect(state.messages[0]?.status).toBe("paused");
      expect(deliveryState()).not.toBe("send");

      // Delivery guards must not lock the device-local editing controls.
      await click(getButton(queuedMessage.input.message.text));
      expect(container.querySelector('textarea[aria-label="Edit queued message"]')).not.toBeNull();
      await click(getButton("Cancel"));
      expect(state.messages[0]?.status).toBe("paused");
    },
  );
});
