import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createQueuedMessagePersistence,
  type IndexedDbQueuedMessagePersistence,
} from "./queuedMessagePersistence";
import { createQueuedMessageStore, type QueuedComposerMessage } from "./queuedMessageStore";

const adapters: IndexedDbQueuedMessagePersistence[] = [];

function adapter() {
  const persistence = createQueuedMessagePersistence();
  adapters.push(persistence);
  return persistence;
}

function message(id: string): QueuedComposerMessage {
  return {
    id,
    prompt: id,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    status: "waiting",
  };
}

function input(): StartThreadTurnInput {
  return {
    commandId: CommandId.make("legacy-command"),
    threadId: ThreadId.make("thread"),
    message: {
      messageId: MessageId.make("legacy-message"),
      role: "user",
      text: "legacy exact payload",
      attachments: [],
      context: {
        version: 1,
        records: [
          {
            kind: "terminal",
            version: 1,
            contextId: ComposerContextId.make("terminal_old"),
            label: "Build",
            terminalId: "terminal",
            terminalLabel: "Build",
            lineStart: 1,
            lineEnd: 2,
            text: "preserved output",
          },
        ],
      },
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    deliveryMode: "steer",
    createdAt: "2026-09-15T00:00:00.000Z",
  };
}

async function seedLegacy() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("d3-outbox", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("messages", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("messages", "readwrite");
      transaction.objectStore("messages").put({
        id: "legacy",
        environmentId: EnvironmentId.make("env"),
        input: input(),
        queuedAt: "2026-09-15T00:00:00.000Z",
        status: "sending",
        prepared: true,
        dispatchAttempted: true,
        sessionUpdatedAtBeforeDispatch: "previous-session",
        localAttachments: [
          {
            type: "image",
            id: "image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 11,
            previewUrl: "blob:old-document",
            file: new File(["image bytes"], "image.png", { type: "image/png" }),
          },
        ],
      });
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", {});
  const pending = new Map<string, Promise<unknown>>();
  type Callback<T> = (lock: { name: string; mode: "exclusive" } | null) => T | Promise<T>;
  vi.stubGlobal("navigator", {
    locks: {
      request<T>(
        name: string,
        optionsOrRun: { ifAvailable: boolean } | Callback<T>,
        callback?: Callback<T>,
      ) {
        const run = typeof optionsOrRun === "function" ? optionsOrRun : callback!;
        if (typeof optionsOrRun !== "function" && optionsOrRun.ifAvailable && pending.has(name))
          return Promise.resolve(run(null));
        const previous = pending.get(name) ?? Promise.resolve();
        const operation = previous
          .catch(() => undefined)
          .then(() => run({ name, mode: "exclusive" }));
        const settled = operation.finally(() => {
          if (pending.get(name) === settled) pending.delete(name);
        });
        pending.set(name, settled);
        return settled;
      },
    },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const persistence of adapters.splice(0)) await persistence.close();
  vi.unstubAllGlobals();
});

describe("IndexedDB queued message persistence", () => {
  it("commits only on transaction completion, reloads bytes, and reopens closed connections", async () => {
    const persistence = adapter();
    const file = new File(["durable bytes"], "notes.txt", { type: "text/plain" });
    await persistence.transact((snapshot) => {
      snapshot.queuesByThreadKey["env:thread"] = [
        {
          ...message("first"),
          files: [
            {
              type: "file",
              id: "file",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: file.size,
              file,
            },
          ],
        },
      ];
    });
    await persistence.close();
    const restored = await persistence.transact(
      (snapshot) => snapshot.queuesByThreadKey["env:thread"]?.[0],
    );
    expect(await restored.result?.files[0]?.file?.text()).toBe("durable bytes");
    expect(restored.result?.id).toBe("first");
    const secondPage = adapter();
    const reread = await secondPage.transact(() => undefined);
    expect(reread.snapshot.revision).toBe(restored.snapshot.revision);
    expect(reread.snapshot.queuesByThreadKey["env:thread"]?.[0]?.prompt).toBe("first");
    expect((await indexedDB.databases()).some((database) => database.name === "d3-outbox")).toBe(
      false,
    );
  });

  it("migrates exact legacy payload and blobs once without deleting the old database", async () => {
    await seedLegacy();
    const persistence = adapter();
    const store = createQueuedMessageStore(persistence);
    await store.getState().hydrate();
    const imported = store.getState().queuesByThreadKey["env:thread"]?.[0];
    expect(imported?.input).toEqual(input());
    expect(imported?.sessionUpdatedAtBeforeDispatch).toBe("previous-session");
    expect(imported?.terminalContexts[0]?.text).toBe("preserved output");
    expect(await imported?.images[0]?.file.text()).toBe("image bytes");
    expect(imported?.images[0]?.previewUrl).not.toBe("blob:old-document");
    expect(await store.getState().take("env:thread", "legacy", null)).toBeNull();
    await store.getState().complete("env:thread", "legacy");
    await persistence.close();
    const reloaded = adapter();
    const next = await reloaded.transact(() => undefined);
    expect(next.snapshot.queuesByThreadKey["env:thread"]).toBeUndefined();
    expect((await indexedDB.databases()).some((database) => database.name === "d3-outbox")).toBe(
      true,
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("d3-outbox");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const original = await new Promise<unknown>((resolve, reject) => {
        const transaction = db.transaction("messages", "readonly");
        const request = transaction.objectStore("messages").get("legacy");
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
      });
      expect(original).toMatchObject({ id: "legacy", input: input(), dispatchAttempted: true });
    } finally {
      db.close();
    }
  });

  it("rolls back all threads and cancellation generation when an IndexedDB write fails", async () => {
    const persistence = adapter();
    const committed = await persistence.transact((snapshot) => {
      snapshot.queuesByThreadKey.a = [message("saved")];
    });
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "metadata")
        throw new DOMException("Queue quota exhausted", "QuotaExceededError");
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    });
    await expect(
      persistence.transact((snapshot) => {
        snapshot.queuesByThreadKey.a = [message("replacement")];
        snapshot.queuesByThreadKey.b = [message("other")];
        snapshot.drainGeneration += 1;
      }),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    failure.mockRestore();
    await persistence.close();
    const after = await adapter().transact(() => undefined);
    expect(after.snapshot.queuesByThreadKey).toEqual(committed.snapshot.queuesByThreadKey);
    expect(after.snapshot.drainGeneration).toBe(committed.snapshot.drainGeneration);
    expect(after.snapshot.revision).toBe(committed.snapshot.revision);
  });

  it("does not commit the migration marker if imported blobs fail to save", async () => {
    await seedLegacy();
    const persistence = adapter();
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "threads") throw new DOMException("No space", "QuotaExceededError");
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    });
    await expect(persistence.transact(() => undefined)).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    failure.mockRestore();
    await persistence.close();
    const imported = await adapter().transact(
      (snapshot) => snapshot.queuesByThreadKey["env:thread"]?.[0],
    );
    expect(imported.result?.id).toBe("legacy");
    expect(await imported.result?.images[0]?.file.text()).toBe("image bytes");
  });

  it("aborts callback failures and rejects in-place mutations instead of silently dropping them", async () => {
    const persistence = adapter();
    await persistence.transact((snapshot) => {
      snapshot.queuesByThreadKey.a = [message("first")];
    });
    await expect(
      persistence.transact((snapshot) => {
        snapshot.queuesByThreadKey.a = [message("not committed")];
        throw new Error("Callback interrupted");
      }),
    ).rejects.toThrow("Callback interrupted");
    await expect(
      persistence.transact((snapshot) => {
        snapshot.queuesByThreadKey.a!.push(message("in-place"));
      }),
    ).rejects.toThrow(TypeError);
    const unchanged = await persistence.transact((snapshot) => snapshot.queuesByThreadKey.a);
    expect(unchanged.result?.map((row) => row.id)).toEqual(["first"]);
  });

  it("serializes competing browser claims against the actual committed row", async () => {
    const first = createQueuedMessageStore(adapter());
    const second = createQueuedMessageStore(adapter());
    const row = await first.getState().enqueue("env:thread", message("first"));
    await second.getState().hydrate();
    // Both real coordinators hold this lock around take + preparation + dispatch.
    await navigator.locks.request("t3-queued-message-send:env:thread", async () => {
      const results = await Promise.all([
        first.getState().take("env:thread", row.id, "tool"),
        second.getState().take("env:thread", row.id, "tool"),
      ]);
      expect(results.filter(Boolean).map((claim) => claim?.id)).toEqual([row.id]);
    });
  });

  it("notifies another adapter only after commit and releases/reopens channel subscriptions", async () => {
    const first = adapter();
    const second = adapter();
    await first.transact(() => undefined);
    await second.transact(() => undefined);
    let unsubscribe: () => void = () => undefined;
    const notification = new Promise<void>((resolve) => {
      unsubscribe = second.subscribe(resolve);
    });
    await first.transact((snapshot) => {
      snapshot.queuesByThreadKey.a = [message("remote")];
    });
    await notification;
    expect(
      (await second.transact((snapshot) => snapshot.queuesByThreadKey.a?.[0]?.id)).result,
    ).toBe("remote");
    unsubscribe();
    await second.close();
    const reopened = new Promise<void>((resolve) => {
      unsubscribe = second.subscribe(resolve);
    });
    await first.transact((snapshot) => {
      snapshot.queuesByThreadKey.a = [message("after reopen")];
    });
    await reopened;
    expect(
      (await second.transact((snapshot) => snapshot.queuesByThreadKey.a?.[0]?.id)).result,
    ).toBe("after reopen");
    unsubscribe();
  });
});
