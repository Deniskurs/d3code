// @vitest-environment happy-dom

import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { OutboxMessage } from "./model";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";

const boundary = vi.hoisted(() => ({
  messages: [] as OutboxMessage[],
  threads: [] as (OrchestrationThreadShell & { environmentId: EnvironmentId })[],
  listeners: new Set<() => void>(),
  start: vi.fn(),
  uploads: vi.fn(),
  uploadedAttachments: vi.fn(),
  rewindingThreadKeys: new Set<string>(),
  inlineMessageContext: true,
  locks: new Set<string>(),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: (...args: unknown[]) => boundary.uploads(...args),
  getUploadedAttachments: (...args: unknown[]) => boundary.uploadedAttachments(...args),
  releaseDraftAttachments: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ status: "live" }) }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: Object.assign(
    (selector: (state: typeof boundary) => unknown) => selector(boundary),
    { getState: () => boundary },
  ),
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: null }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map([
        [
          "environment",
          {
            environment: { capabilities: { inlineMessageContext: boundary.inlineMessageContext } },
          },
        ],
      ]),
  },
}));
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
  boundary.uploadedAttachments.mockReset().mockReturnValue([]);
  boundary.rewindingThreadKeys.clear();
  boundary.inlineMessageContext = true;
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

  it("binds queued chips to uploaded attachments without changing context identities on retry", async () => {
    const message = queued("context");
    const attachment = {
      type: "file" as const,
      id: "queued-file",
      name: "paste.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      file: new File(["hello"], "paste.txt", { type: "text/plain" }),
    };
    const record = {
      version: 1 as const,
      contextId: ComposerContextId.make("file_original-draft-id"),
      kind: "file" as const,
      label: attachment.name,
      attachmentId: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
    const text = `Review ${formatComposerContextReference(record)}`;
    boundary.messages = [
      {
        ...message,
        localAttachments: [attachment],
        input: {
          ...message.input,
          message: { ...message.input.message, text, context: { version: 1, records: [record] } },
        },
      },
    ];
    boundary.uploadedAttachments.mockReturnValue([
      {
        type: "file",
        id: "uploaded-file",
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      },
    ]);
    boundary.start.mockRejectedValueOnce(new Error("Lost acknowledgement"));
    await render();
    const dispatched = boundary.start.mock.calls[0]![0].input;
    expect(dispatched.message.text).toBe(text);
    expect(dispatched.message.context.records).toEqual([
      { ...record, attachmentId: "uploaded-file" },
    ]);
    expect(dispatched.message.attachments[0].id).toBe("uploaded-file");
    boundary.messages = [{ ...boundary.messages[0]!, status: "waiting" }];
    boundary.inlineMessageContext = false;
    await render();
    expect(boundary.start.mock.calls[1]![0].input).toEqual(dispatched);
  });

  it("serializes queued terminal context for servers without inline context support", async () => {
    const message = queued("legacy-context");
    const record = {
      version: 1 as const,
      contextId: ComposerContextId.make("terminal_selection"),
      kind: "terminal" as const,
      label: "Terminal 1 lines 3-4",
      terminalId: "terminal-1",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "compiler failed\nmissing module",
    };
    boundary.inlineMessageContext = false;
    boundary.messages = [
      {
        ...message,
        input: {
          ...message.input,
          message: {
            ...message.input.message,
            text: `Explain ${formatComposerContextReference(record)}`,
            context: { version: 1, records: [record] },
          },
        },
      },
    ];
    await render();
    const sent = boundary.start.mock.calls[0]![0].input.message;
    expect(upgradeLegacyContextMessage(sent.text).records[0]).toMatchObject({
      kind: "terminal",
      terminalLabel: record.terminalLabel,
      lineStart: record.lineStart,
      lineEnd: record.lineEnd,
      text: record.text,
    });
    expect(sent.text).not.toContain("t3-context://");
    expect(sent.context).toBeUndefined();
  });

  it("holds delivery when rewind begins during uploads and resumes after it settles", async () => {
    let finishUploads!: () => void;
    boundary.uploads.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUploads = resolve;
        }),
    );
    boundary.messages = [{ ...queued("rewind"), sendNow: true }];
    await render();
    const key = scopedThreadKey({ environmentId, threadId });
    boundary.rewindingThreadKeys.add(key);
    await act(async () => finishUploads());
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.messages[0]?.status).toBe("waiting");
    boundary.rewindingThreadKeys = new Set();
    await render();
    expect(boundary.start).toHaveBeenCalledTimes(1);
    expect(boundary.start.mock.calls[0]![0].input.deliveryMode).toBe("steer");
  });
});
