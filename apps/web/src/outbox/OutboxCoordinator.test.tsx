// @vitest-environment happy-dom

import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { OutboxMessage } from "./model";

const boundary = vi.hoisted(() => ({
  messages: [] as OutboxMessage[],
  threads: [] as (OrchestrationThreadShell & { environmentId: EnvironmentId })[],
  listeners: new Set<() => void>(),
  start: vi.fn(),
  uploads: vi.fn(),
  locks: new Set<string>(),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: (...args: unknown[]) => boundary.uploads(...args),
  getUploadedAttachments: () => [],
  releaseDraftAttachments: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ status: "live" }) }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "environment" }] }),
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("../state/entities", () => ({
  useThreadShells: () => boundary.threads,
  readThreadShell: ({ environmentId, threadId }: { environmentId: string; threadId: string }) =>
    boundary.threads.find(
      (thread) => thread.environmentId === environmentId && thread.id === threadId,
    ),
}));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: () => null } }));
vi.mock("../state/threads", () => ({ threadEnvironment: { startTurn: null } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => boundary.start }));
vi.mock("./store", () => {
  return {
    useOutbox: () =>
      useSyncExternalStore(
        (listener) => {
          boundary.listeners.add(listener);
          return () => {
            boundary.listeners.delete(listener);
          };
        },
        () => boundary.messages,
      ),
    readMessages: async () => boundary.messages,
    refreshOutbox: async () => {
      boundary.messages = [...boundary.messages];
      boundary.listeners.forEach((listener) => listener());
    },
    mutateOutbox: async (
      id: string,
      update: (current: OutboxMessage | undefined) => OutboxMessage | undefined,
    ) => {
      const next = update(boundary.messages.find((message) => message.id === id));
      boundary.messages = boundary.messages.flatMap((message) =>
        message.id === id ? (next ? [next] : []) : [message],
      );
      boundary.listeners.forEach((listener) => listener());
      return next;
    },
  };
});

import { OutboxCoordinator } from "./OutboxCoordinator";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const oldTime = "2026-09-09T10:00:00.000Z";
let root: Root;

function queued(id: string): OutboxMessage {
  return {
    id,
    environmentId,
    queuedAt: oldTime,
    status: "waiting",
    input: {
      commandId: CommandId.make(`command-${id}`),
      threadId,
      message: { messageId: MessageId.make(id), role: "user", text: id, attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      deliveryMode: "queue",
    },
  };
}

async function render() {
  await act(async () => {
    root.render(<OutboxCoordinator />);
  });
}

beforeEach(() => {
  boundary.messages = [];
  boundary.listeners.clear();
  boundary.locks.clear();
  boundary.start.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  boundary.uploads.mockReset().mockResolvedValue(undefined);
  boundary.threads = [
    {
      id: threadId,
      environmentId,
      archivedAt: null,
      latestTurn: null,
      latestUserMessageAt: null,
      session: { status: "ready", updatedAt: oldTime },
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    } as OrchestrationThreadShell & { environmentId: EnvironmentId },
  ];
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => {
        if (boundary.locks.has(name)) return callback(null);
        boundary.locks.add(name);
        try {
          return await callback({});
        } finally {
          boundary.locks.delete(name);
        }
      },
    },
  });
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe("outbox coordinator", () => {
  it("holds FIFO across stale acknowledgement and drains checkpoint-free text completion", async () => {
    boundary.messages = [queued("first"), queued("second")];
    await render();
    expect(boundary.start).toHaveBeenCalledTimes(1);
    expect(boundary.messages[0]?.status).toBe("submitted");
    const createdAt = boundary.messages[0]!.input.createdAt!;
    boundary.threads = [{ ...boundary.threads[0]!, latestUserMessageAt: createdAt }];
    await render();
    expect(boundary.start).toHaveBeenCalledTimes(1);
    boundary.threads = [
      {
        ...boundary.threads[0]!,
        session: {
          ...boundary.threads[0]!.session!,
          updatedAt: new Date(Date.parse(createdAt) + 1000).toISOString(),
        },
      },
    ];
    await render();
    expect(boundary.start).toHaveBeenCalledTimes(2);
    expect(boundary.start.mock.calls.map(([command]) => command.input.message.text)).toEqual([
      "first",
      "second",
    ]);
    expect(boundary.start.mock.calls.map(([command]) => command.input.deliveryMode)).toEqual([
      "queue",
      "queue",
    ]);
    expect(boundary.messages.map((message) => message.id)).toEqual(["second"]);
  });

  it("rechecks after uploads and retries a failed dispatch with its exact immutable command", async () => {
    let finishUploads!: () => void;
    boundary.uploads.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUploads = resolve;
        }),
    );
    boundary.messages = [queued("first")];
    await render();
    boundary.threads = [
      { ...boundary.threads[0]!, session: { ...boundary.threads[0]!.session!, status: "running" } },
    ];
    await act(async () => finishUploads());
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.messages[0]?.status).toBe("waiting");
    boundary.start.mockRejectedValueOnce(new Error("Connection lost after dispatch"));
    boundary.threads = [
      { ...boundary.threads[0]!, session: { ...boundary.threads[0]!.session!, status: "ready" } },
    ];
    await render();
    expect(boundary.messages[0]?.status).toBe("failed");
    const dispatched = boundary.start.mock.calls[0]![0].input;
    boundary.messages = [{ ...boundary.messages[0]!, status: "waiting" }];
    await render();
    expect(boundary.start).toHaveBeenCalledTimes(2);
    expect(boundary.start.mock.calls[1]![0].input).toEqual(dispatched);
    expect(boundary.messages[0]?.status).toBe("submitted");
  });

  it("preserves pre-marker failed and sending commands through upgrade recovery", async () => {
    const legacy = {
      ...queued("legacy"),
      prepared: true,
      status: "failed" as const,
      input: { ...queued("legacy").input, createdAt: oldTime },
    };
    boundary.messages = [legacy];
    await render();
    expect(boundary.start).not.toHaveBeenCalled();
    // The existing Retry action changes only the status, so preserve its
    // already-dispatched input even without the newer dispatchAttempted marker.
    boundary.messages = [{ ...legacy, status: "waiting" }];
    await render();
    expect(boundary.start.mock.calls[0]![0].input).toEqual(legacy.input);
    expect(boundary.uploads).not.toHaveBeenCalled();
    boundary.messages = [{ ...legacy, status: "sending" }];
    await render();
    expect(boundary.start.mock.calls[1]![0].input).toEqual(legacy.input);
    expect(boundary.uploads).not.toHaveBeenCalled();
  });

  it("allows only explicit Send now priority and never bypasses pending answers", async () => {
    boundary.messages = [queued("first"), { ...queued("second"), sendNow: true }];
    boundary.threads = [
      {
        ...boundary.threads[0]!,
        hasPendingUserInput: true,
        session: { ...boundary.threads[0]!.session!, status: "running" },
      },
    ];
    await render();
    expect(boundary.start).not.toHaveBeenCalled();
    boundary.threads = [{ ...boundary.threads[0]!, hasPendingUserInput: false }];
    await render();
    expect(boundary.start).toHaveBeenCalledTimes(1);
    expect(boundary.start.mock.calls[0]![0].input.message.text).toBe("second");
    expect(boundary.start.mock.calls[0]![0].input.deliveryMode).toBe("steer");
    expect(boundary.messages.map((message) => message.id)).toEqual(["first"]);
  });
});
