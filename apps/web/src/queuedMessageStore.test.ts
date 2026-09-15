import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { describe, expect, it } from "vite-plus/test";

import {
  importLegacyQueue,
  type QueuedMessagePersistence,
  type QueueSnapshot,
} from "./queuedMessagePersistence";
import {
  createQueuedMessageStore,
  isQueuedMessageDue,
  latestCompletedToolActivityId,
  type QueuedComposerMessage,
} from "./queuedMessageStore";

function makeInput(text = "message"): StartThreadTurnInput {
  return {
    commandId: CommandId.make("command-1"),
    threadId: ThreadId.make("thread-a"),
    message: { messageId: MessageId.make("message-1"), role: "user", text, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

function makeMessage(prompt: string): Omit<QueuedComposerMessage, "id"> {
  return {
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

/** Transactional storage seam; no browser globals or second delivery implementation. */
function memoryPersistence() {
  let saved: QueueSnapshot = {
    queuesByThreadKey: {},
    drainGeneration: 0,
    revision: 0,
    legacyMigrationComplete: true,
  };
  let pending: Promise<unknown> = Promise.resolve();
  let failNext = false;
  const listeners = new Set<() => void>();
  const activeSendLocks = new Set<string>();
  const persistence: QueuedMessagePersistence = {
    transact<T>(update: (snapshot: QueueSnapshot) => T) {
      const operation = pending.then(() => {
        const before = structuredClone(saved);
        const snapshot = { ...before, queuesByThreadKey: { ...before.queuesByThreadKey } };
        const result = update(snapshot);
        const changed =
          snapshot.drainGeneration !== before.drainGeneration ||
          snapshot.legacyMigrationComplete !== before.legacyMigrationComplete ||
          Object.keys({ ...before.queuesByThreadKey, ...snapshot.queuesByThreadKey }).some(
            (key) => before.queuesByThreadKey[key] !== snapshot.queuesByThreadKey[key],
          );
        if (failNext) {
          failNext = false;
          throw new Error("Quota exceeded");
        }
        if (changed) snapshot.revision += 1;
        saved = structuredClone(snapshot);
        return { snapshot, result };
      });
      pending = operation.catch(() => undefined);
      return operation;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async recover(key, run) {
      if (!activeSendLocks.has(key)) await run();
    },
  };
  return {
    persistence,
    activeSendLocks,
    failWrite() {
      failNext = true;
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
}

function fixture() {
  const storage = memoryPersistence();
  const store = createQueuedMessageStore(storage.persistence);
  return { storage, store, actions: store.getState() };
}

describe("durable queued messages", () => {
  it("captures the full submission before asynchronous hydration can yield to composer edits", async () => {
    const { actions } = fixture();
    const input = { ...makeInput(), message: { ...makeInput().message } };
    const draft = { ...makeMessage("submitted"), input };
    const enqueued = actions.enqueue("thread-a", draft);
    draft.prompt = "new composer text";
    input.message.text = "new provider text";
    const entry = await enqueued;
    expect(entry.prompt).toBe("submitted");
    expect(entry.input?.message.text).toBe("message");
  });

  it("restores submission order and attachment bytes after a new store hydrates", async () => {
    const { storage, actions } = fixture();
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "proof.png",
      mimeType: "image/png",
      sizeBytes: 5,
      previewUrl: "blob:old-page",
      file: new File(["bytes"], "proof.png", { type: "image/png" }),
    };
    const first = await actions.enqueue("thread-a", { ...makeMessage("first"), images: [image] });
    await actions.enqueue("thread-a", makeMessage("second"));
    await actions.enqueue("thread-b", makeMessage("other"));
    const restored = createQueuedMessageStore(storage.persistence);
    await restored.getState().hydrate();
    const queue = restored.getState().queuesByThreadKey["thread-a"]!;
    expect(queue.map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queue[0]?.id).toBe(first.id);
    expect(await queue[0]?.images[0]?.file.text()).toBe("bytes");
    expect(queue[0]?.images[0]?.previewUrl).not.toBe("blob:old-page");
    expect(restored.getState().queuesByThreadKey["thread-b"]?.[0]?.prompt).toBe("other");
  });

  it("atomically gives a claim to only one tab and holds the row until acknowledgement", async () => {
    const { storage, store, actions } = fixture();
    const first = await actions.enqueue("thread-a", {
      ...makeMessage("first"),
      input: makeInput(),
    });
    const second = await actions.enqueue("thread-a", makeMessage("second"));
    const other = createQueuedMessageStore(storage.persistence);
    await other.getState().hydrate();
    const claims = await Promise.all([
      actions.take("thread-a", first.id, "tool-2"),
      other.getState().take("thread-a", first.id, "tool-2"),
    ]);
    expect(claims.filter(Boolean).map((message) => message?.id)).toEqual([first.id]);
    expect(store.getState().queuesByThreadKey["thread-a"]?.[1]?.queuedAfterToolActivityId).toBe(
      "tool-2",
    );
    await actions.markDispatching("thread-a", first.id, makeInput(), "session-before");
    await actions.markSubmitted("thread-a", first.id);
    await actions.requestSendNow("thread-a", second.id);
    expect(await other.getState().take("thread-a", second.id, "tool-3")).toBeNull();
    await actions.complete("thread-a", first.id);
    expect((await actions.take("thread-a", second.id, "tool-3"))?.id).toBe(second.id);
  });

  it("drain cancels upload claims, retains overflow atomically, and cannot revive a drained dispatch", async () => {
    const { store, actions } = fixture();
    const first = await actions.enqueue("thread-a", makeMessage("uploading"));
    const overflow = await actions.enqueue("thread-a", makeMessage("overflow"));
    await actions.take("thread-a", first.id, "tool-1");
    expect((await actions.drain("thread-a", [overflow.id])).map((message) => message.id)).toEqual([
      first.id,
    ]);
    expect(await actions.markDispatching("thread-a", first.id, makeInput())).toBeNull();
    const retained = store.getState().queuesByThreadKey["thread-a"]?.[0];
    expect(retained?.id).toBe(overflow.id);
    expect(
      isQueuedMessageDue({ message: retained!, phase: "ready", latestToolActivityId: null }),
    ).toBe(false);
    expect(store.getState().drainGeneration).toBe(1);
  });

  it("never restores attempted or submitted messages as new drafts", async () => {
    const { store, actions } = fixture();
    const first = await actions.enqueue("thread-a", {
      ...makeMessage("ambiguous"),
      input: makeInput(),
    });
    await actions.take("thread-a", first.id, null);
    await actions.markDispatching("thread-a", first.id, makeInput());
    await actions.fail("thread-a", first.id, "Connection lost after dispatch");
    const second = await actions.enqueue("thread-a", makeMessage("unsent"));
    expect(await actions.remove("thread-a", first.id)).toBeNull();
    expect((await actions.drain("thread-a")).map((message) => message.id)).toEqual([second.id]);
    expect(store.getState().queuesByThreadKey["thread-a"]?.[0]?.id).toBe(first.id);
    await actions.markSubmitted("thread-a", first.id);
    expect(await actions.drain("thread-a")).toEqual([]);
  });

  it("retries the exact attempted payload and baseline after crash recovery", async () => {
    const { storage, actions } = fixture();
    const input = makeInput("final serialized context");
    const first = await actions.enqueue("thread-a", { ...makeMessage("original"), input });
    await actions.take("thread-a", first.id, null);
    await actions.markDispatching("thread-a", first.id, input, "old-session");
    const restored = createQueuedMessageStore(storage.persistence);
    await restored.getState().hydrate();
    const recovered = restored.getState().queuesByThreadKey["thread-a"]?.[0];
    expect(recovered?.holdUntilUserAction).toBe(true);
    expect(await restored.getState().take("thread-a", first.id, null)).toBeNull();
    await restored.getState().requestSendNow("thread-a", first.id);
    await restored.getState().take("thread-a", first.id, null);
    const retry = await restored
      .getState()
      .markDispatching("thread-a", first.id, makeInput("changed"), "new-session");
    expect(retry).toEqual(input);
    expect(
      restored.getState().queuesByThreadKey["thread-a"]?.[0]?.sessionUpdatedAtBeforeDispatch,
    ).toBe("old-session");
  });

  it("does not recover another tab's actively uploading claim", async () => {
    const { storage, actions } = fixture();
    const first = await actions.enqueue("thread-a", makeMessage("first"));
    await actions.take("thread-a", first.id, null);
    storage.activeSendLocks.add("thread-a");
    const other = createQueuedMessageStore(storage.persistence);
    await other.getState().hydrate();
    expect(other.getState().queuesByThreadKey["thread-a"]?.[0]?.status).toBe("sending");
    expect(await actions.markDispatching("thread-a", first.id, makeInput())).toEqual(makeInput());
    storage.activeSendLocks.delete("thread-a");
    await other.getState().refresh();
    expect(other.getState().queuesByThreadKey["thread-a"]?.[0]?.holdUntilUserAction).toBe(true);
    expect(await other.getState().take("thread-a", first.id, null)).toBeNull();
  });

  it("keeps drafts on write failure and prevents dispatch until storage recovers", async () => {
    const { storage, store, actions } = fixture();
    const first = await actions.enqueue("thread-a", makeMessage("saved"));
    storage.failWrite();
    await expect(actions.enqueue("thread-a", makeMessage("still in composer"))).rejects.toThrow(
      "Quota exceeded",
    );
    expect(
      store.getState().queuesByThreadKey["thread-a"]?.map((message) => message.prompt),
    ).toEqual(["saved"]);
    expect(await actions.take("thread-a", first.id, null)).toBeNull();
    await actions.refresh();
    await actions.take("thread-a", first.id, null);
    storage.failWrite();
    await expect(actions.markDispatching("thread-a", first.id, makeInput())).rejects.toThrow(
      "Quota exceeded",
    );
    expect(store.getState().queuesByThreadKey["thread-a"]?.[0]?.dispatchAttempted).toBe(false);
    expect(await actions.markDispatching("thread-a", first.id, makeInput())).toBeNull();
    await actions.refresh();
    storage.failWrite();
    await expect(actions.drain("thread-a")).rejects.toThrow("Quota exceeded");
    const recovered = createQueuedMessageStore(storage.persistence);
    await recovered.getState().hydrate();
    expect(recovered.getState().queuesByThreadKey["thread-a"]?.[0]?.prompt).toBe("saved");
  });

  it("pause blocks claim until explicit resume and remove preserves other tool anchors", async () => {
    const { store, actions } = fixture();
    const first = await actions.enqueue("thread-a", {
      ...makeMessage("first"),
      queuedAfterToolActivityId: "tool-1",
    });
    const second = await actions.enqueue("thread-a", makeMessage("second"));
    await actions.pause("thread-a", first.id, true);
    expect(await actions.take("thread-a", first.id, "tool-2")).toBeNull();
    await actions.remove("thread-a", second.id);
    expect(store.getState().queuesByThreadKey["thread-a"]?.[0]?.queuedAfterToolActivityId).toBe(
      "tool-1",
    );
    await actions.pause("thread-a", first.id, false);
    expect((await actions.take("thread-a", first.id, "tool-2"))?.id).toBe(first.id);
  });

  it("refreshes remote commits without publishing unchanged snapshots repeatedly", async () => {
    const { storage, store, actions } = fixture();
    await actions.hydrate();
    const unchanged = store.getState().queuesByThreadKey;
    await actions.refresh();
    expect(store.getState().queuesByThreadKey).toBe(unchanged);
    const other = createQueuedMessageStore(storage.persistence);
    await other.getState().enqueue("thread-a", makeMessage("remote"));
    storage.notify();
    await actions.refresh();
    expect(store.getState().queuesByThreadKey["thread-a"]?.[0]?.prompt).toBe("remote");
  });

  it("fails hydration closed instead of treating inaccessible storage as an empty queue", async () => {
    const { storage, store, actions } = fixture();
    storage.failWrite();
    await expect(actions.hydrate()).rejects.toThrow("Quota exceeded");
    expect(store.getState().hydrated).toBe(false);
    expect(store.getState().storageError).not.toBeNull();
    await actions.hydrate();
    expect(store.getState().hydrated).toBe(true);
  });
});

describe("legacy queue import", () => {
  it("preserves exact ambiguous identity, binary attachments and contexts without replay or resurrection", async () => {
    const original = makeInput("legacy payload");
    const input: StartThreadTurnInput = {
      ...original,
      message: {
        ...original.message,
        context: {
          version: 1,
          records: [
            {
              kind: "terminal",
              version: 1,
              contextId: ComposerContextId.make("terminal_legacy"),
              label: "Terminal",
              terminalId: "terminal-1",
              terminalLabel: "Build",
              lineStart: 1,
              lineEnd: 2,
              text: "original terminal output",
            },
          ],
        },
      },
    };
    const file = new File(["original bytes"], "notes.txt", { type: "text/plain" });
    const legacy = [
      {
        id: "legacy-id",
        environmentId: EnvironmentId.make("env"),
        input,
        queuedAt: input.createdAt!,
        status: "sending" as const,
        localAttachments: [
          {
            type: "file" as const,
            id: "file-1",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: file.size,
            file,
          },
        ],
      },
    ];
    const snapshot: QueueSnapshot = {
      queuesByThreadKey: {},
      drainGeneration: 0,
      revision: 0,
      legacyMigrationComplete: false,
    };
    importLegacyQueue(snapshot, legacy);
    const restored = snapshot.queuesByThreadKey["env:thread-a"]?.[0];
    expect(restored?.id).toBe("legacy-id");
    expect(restored?.input).toEqual(input);
    expect(restored?.dispatchAttempted).toBe(true);
    expect(restored?.holdUntilUserAction).toBe(true);
    expect(await restored?.files[0]?.file?.text()).toBe("original bytes");
    expect(restored?.terminalContexts[0]?.text).toBe("original terminal output");
    expect(
      isQueuedMessageDue({ message: restored!, phase: "ready", latestToolActivityId: null }),
    ).toBe(false);
    delete snapshot.queuesByThreadKey["env:thread-a"];
    importLegacyQueue(snapshot, legacy);
    expect(snapshot.queuesByThreadKey).toEqual({});
  });
});

describe("queued message dispatch timing", () => {
  it("finds the newest completed tool call by sequence, not position", () => {
    expect(
      latestCompletedToolActivityId([
        { id: "late", kind: "tool.completed", sequence: 9, createdAt: "2026-01-01T00:00:09Z" },
        { id: "ignored", kind: "tool.started", sequence: 10, createdAt: "2026-01-01T00:00:10Z" },
        { id: "early", kind: "tool.completed", sequence: 4, createdAt: "2026-01-01T00:00:04Z" },
      ]),
    ).toBe("late");
    expect(latestCompletedToolActivityId([])).toBeNull();
  });

  it("waits for the next completed tool boundary or a settled turn", () => {
    const message = { queuedAfterToolActivityId: "a2" };
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a2" })).toBe(
      false,
    );
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a4" })).toBe(
      true,
    );
    expect(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: "a2" })).toBe(true);
    expect(isQueuedMessageDue({ message, phase: "connecting", latestToolActivityId: "a4" })).toBe(
      false,
    );
    expect(isQueuedMessageDue({ message, phase: "disconnected", latestToolActivityId: "a4" })).toBe(
      false,
    );
    expect(
      isQueuedMessageDue({
        message: { ...message, holdUntilUserAction: true, sendNow: true },
        phase: "ready",
        latestToolActivityId: "a4",
      }),
    ).toBe(false);
  });
});
