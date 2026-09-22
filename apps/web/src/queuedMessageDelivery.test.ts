import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canDeliverQueuedMessage,
  deliverQueuedMessage,
  hasQueuedMessageReceipt,
} from "./queuedMessageDelivery";
import type { QueuedMessagePersistence, QueueSnapshot } from "./queuedMessagePersistence";
import { createQueuedMessageStore, type QueuedComposerMessage } from "./queuedMessageStore";

const threadId = ThreadId.make("thread-1");
const environmentId = EnvironmentId.make("environment-1");
const key = `${environmentId}:${threadId}`;
const before = "2026-09-15T00:00:00.000Z";
const queuedAt = "2026-09-15T00:00:10.000Z";
const after = "2026-09-15T00:00:11.000Z";

function message(id = "one"): QueuedComposerMessage {
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
    createdAt: queuedAt,
    status: "waiting",
    dispatchAttempted: false,
    input: {
      threadId,
      commandId: CommandId.make(`command-${id}`),
      createdAt: queuedAt,
      message: { messageId: MessageId.make(id), role: "user", text: id, attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
  };
}

function thread(overrides: Partial<EnvironmentThread> = {}): EnvironmentThread {
  return {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    pullRequests: [],
    createdAt: before,
    updatedAt: before,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: before,
    },
    ...overrides,
  };
}

interface TestPersistence extends QueuedMessagePersistence {
  withSendLock<T>(threadKey: string, run: () => Promise<T>): Promise<T | undefined>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function memoryPersistence(): TestPersistence {
  let saved: QueueSnapshot = {
    queuesByThreadKey: {},
    drainGeneration: 0,
    revision: 0,
    legacyMigrationComplete: true,
  };
  const sendLocks = new Set<string>();
  async function withSendLock<T>(threadKey: string, run: () => Promise<T>): Promise<T | undefined> {
    if (sendLocks.has(threadKey)) return undefined;
    sendLocks.add(threadKey);
    try {
      return await run();
    } finally {
      sendLocks.delete(threadKey);
    }
  }
  return {
    async transact(update) {
      const next = structuredClone(saved);
      const result = update(next);
      next.revision += 1;
      saved = next;
      return { snapshot: structuredClone(saved), result };
    },
    subscribe: () => () => {},
    recover: async (threadKey, run) => {
      await withSendLock(threadKey, run);
    },
    withSendLock,
  };
}

function projectedMessage(id: string) {
  return {
    id: MessageId.make(id),
    role: "user" as const,
    text: id,
    turnId: null,
    streaming: false,
    createdAt: queuedAt,
    updatedAt: queuedAt,
  };
}

function tool(id: string, sequence: number) {
  return {
    id: EventId.make(id),
    kind: "tool.completed",
    tone: "info" as const,
    summary: "Tool finished",
    payload: {},
    turnId: null,
    sequence,
    createdAt: after,
  };
}

async function harness() {
  const persistence = memoryPersistence();
  const store = createQueuedMessageStore(persistence);
  await store.getState().hydrate();
  let current = thread();
  const dispatch = vi
    .fn<(input: StartThreadTurnInput) => Promise<void>>()
    .mockResolvedValue(undefined);
  const prepare = vi.fn(async (entry: QueuedComposerMessage) => entry.input!);
  const run = () =>
    persistence.withSendLock(key, () =>
      deliverQueuedMessage({
        threadKey: key,
        store: store.getState,
        snapshot: () => ({ thread: current, ready: true, rewinding: false }),
        prepare,
        dispatch,
      }),
    );
  return {
    store,
    dispatch,
    prepare,
    run,
    setThread: (value: EnvironmentThread) => {
      current = value;
    },
  };
}

describe("native OMP command delivery", () => {
  it.each([false, true])(
    "keeps a native command out of mid-turn steering (send now=%s)",
    (sendNow) => {
      const entry = message("/plan");
      entry.sendNow = sendNow;
      const current = thread({
        activities: [tool("finished-tool", 1)],
        session: { ...thread().session!, providerName: "omp", status: "running" },
      });
      expect(
        canDeliverQueuedMessage(entry, { thread: current, ready: true, rewinding: false }),
      ).toBe(false);
      expect(
        canDeliverQueuedMessage(entry, {
          thread: { ...current, session: { ...current.session!, status: "ready" } },
          ready: true,
          rewinding: false,
        }),
      ).toBe(true);
    },
  );

  it("continues delivering ordinary OMP follow-ups at tool boundaries", () => {
    const current = thread({
      activities: [tool("finished-tool", 1)],
      session: { ...thread().session!, providerName: "omp", status: "running" },
    });
    expect(
      canDeliverQueuedMessage(message("please explain"), {
        thread: current,
        ready: true,
        rewinding: false,
      }),
    ).toBe(true);
  });

  it("keeps a saved native command unclaimed until idle so Stop can still cancel it", async () => {
    const h = await harness();
    const current = thread({
      activities: [tool("finished-tool", 1)],
      session: { ...thread().session!, providerName: "omp", status: "running" },
    });
    h.setThread(current);
    const entry = await h.store.getState().enqueue(key, message("/plan"));
    await h.store.getState().requestSendNow(key, entry.id);
    await h.run();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    const restored = await h.store.getState().drain(key);
    expect(restored.map((item) => item.prompt)).toEqual(["/plan"]);
    h.setThread({ ...current, session: { ...current.session!, status: "ready" } });
    await h.run();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

describe("queued delivery receipts", () => {
  it("does not treat a projected message with the pre-send ready session as acknowledgement", () => {
    const entry = {
      ...message(),
      status: "submitted" as const,
      sessionUpdatedAtBeforeDispatch: before,
    };
    const projected = thread({ messages: [projectedMessage("one")] });
    expect(hasQueuedMessageReceipt(entry, projected)).toBe(false);
    expect(
      hasQueuedMessageReceipt(entry, {
        ...projected,
        session: { ...projected.session!, status: "starting", updatedAt: after },
      }),
    ).toBe(false);
    expect(
      hasQueuedMessageReceipt(entry, {
        ...projected,
        session: { ...projected.session!, status: "running", updatedAt: after },
      }),
    ).toBe(true);
    expect(
      hasQueuedMessageReceipt(entry, {
        ...projected,
        session: { ...projected.session!, updatedAt: after },
      }),
    ).toBe(true);
    expect(
      hasQueuedMessageReceipt(
        entry,
        thread({ session: { ...projected.session!, updatedAt: after } }),
      ),
    ).toBe(false);
  });

  it("keeps the next message behind the consumed tool boundary after acknowledgement", async () => {
    const h = await harness();
    await h.store.getState().enqueue(key, message("one"));
    await h.store.getState().enqueue(key, message("two"));
    const base = thread();
    const running = thread({
      activities: [tool("tool-1", 1)],
      session: { ...base.session!, status: "running" },
    });
    h.setThread(running);
    await h.run();
    await h.run();
    expect(h.dispatch.mock.calls.map(([input]) => input.message.messageId)).toEqual(["one"]);
    h.setThread({
      ...running,
      messages: [projectedMessage("one")],
      session: { ...running.session!, updatedAt: after },
    });
    await h.run(); // retires the acknowledged row, not another dispatch
    await h.run(); // same boundary remains consumed
    expect(h.dispatch.mock.calls.map(([input]) => input.message.messageId)).toEqual(["one"]);
    h.setThread({
      ...running,
      messages: [projectedMessage("one")],
      activities: [tool("tool-1", 1), tool("tool-2", 2)],
      session: { ...running.session!, updatedAt: after },
    });
    await h.run();
    expect(h.dispatch.mock.calls.map(([input]) => input.message.messageId)).toEqual(["one", "two"]);
  });
});

describe("queued delivery cancellation and recovery", () => {
  it("does not dispatch or resurrect a claim drained while preparation is pending", async () => {
    const h = await harness();
    const entry = await h.store.getState().enqueue(key, message());
    const preparing = deferred<void>();
    const resume = deferred<StartThreadTurnInput>();
    h.prepare.mockImplementationOnce(async () => {
      preparing.resolve();
      return resume.promise;
    });
    const delivery = h.run();
    await preparing.promise;
    const restored = await h.store.getState().drain(key);
    resume.resolve(entry.input!);
    await delivery;
    expect(restored.map((item) => item.input?.message.messageId)).toEqual(["one"]);
    expect(h.dispatch.mock.calls).toEqual([]);
    expect(h.store.getState().queuesByThreadKey[key] ?? []).toEqual([]);
  });

  it("holds an upload whose thread starts rewinding, without dispatching", async () => {
    const persistence = memoryPersistence();
    const store = createQueuedMessageStore(persistence);
    await store.getState().enqueue(key, message());
    let rewinding = false;
    const dispatch = vi.fn();
    await persistence.withSendLock(key, () =>
      deliverQueuedMessage({
        threadKey: key,
        store: store.getState,
        snapshot: () => ({ thread: thread(), ready: true, rewinding }),
        prepare: async (entry) => {
          rewinding = true;
          return entry.input!;
        },
        dispatch,
      }),
    );
    expect(dispatch.mock.calls).toEqual([]);
    expect(store.getState().queuesByThreadKey[key]?.[0]?.holdUntilUserAction).toBe(true);
  });

  it("never automatically retries an ambiguous failure and explicit retry keeps its exact prepared command", async () => {
    const h = await harness();
    const entry = await h.store.getState().enqueue(key, message());
    const finalized = {
      ...entry.input!,
      message: { ...entry.input!.message, text: "immutable serialized context" },
    };
    h.prepare.mockResolvedValueOnce(finalized);
    h.dispatch.mockRejectedValueOnce(new Error("response lost"));
    await h.run();
    await h.run();
    expect(h.dispatch.mock.calls.map(([input]) => input)).toEqual([finalized]);
    expect(await h.store.getState().drain(key)).toEqual([]);
    await h.store.getState().requestSendNow(key, entry.id);
    h.prepare.mockRejectedValue(new Error("retry must not prepare again"));
    await h.run();
    expect(h.dispatch.mock.calls.map(([input]) => input)).toEqual([finalized, finalized]);
    expect(h.store.getState().queuesByThreadKey[key]?.[0]?.status).toBe("submitted");
  });

  it("does not send when persisting the exact prepared command fails", async () => {
    const h = await harness();
    await h.store.getState().enqueue(key, message());
    h.store.setState({
      markDispatching: async () => {
        throw new Error("disk full");
      },
    });
    await h.run();
    expect(h.dispatch.mock.calls).toEqual([]);
    expect(h.store.getState().queuesByThreadKey[key]?.[0]?.error).toBe("disk full");
    expect(h.store.getState().queuesByThreadKey[key]?.[0]?.holdUntilUserAction).toBe(true);
  });

  it("Stop after the durable dispatch marker prevents network delivery without restoring an ambiguous draft", async () => {
    const h = await harness();
    await h.store.getState().enqueue(key, message());
    const markDispatching = h.store.getState().markDispatching;
    h.store.setState({
      markDispatching: async (...args) => {
        const input = await markDispatching(...args);
        await h.store.getState().drain(key);
        return input;
      },
    });
    await h.run();
    expect(h.dispatch.mock.calls).toEqual([]);
    expect(await h.store.getState().drain(key)).toEqual([]);
    expect(h.store.getState().queuesByThreadKey[key]?.[0]?.holdUntilUserAction).toBe(true);
  });

  it("rechecks a claim held after marking dispatch even without a Stop generation change", async () => {
    const h = await harness();
    const entry = await h.store.getState().enqueue(key, message());
    const markDispatching = h.store.getState().markDispatching;
    h.store.setState({
      markDispatching: async (...args) => {
        const input = await markDispatching(...args);
        await h.store.getState().fail(key, entry.id, "Delivery was paused");
        return input;
      },
    });
    await h.run();
    expect(h.dispatch.mock.calls).toEqual([]);
    expect(h.store.getState().queuesByThreadKey[key]?.[0]?.holdUntilUserAction).toBe(true);
  });

  it("Send now bypasses timing but not offline or rewind safety", () => {
    const entry = { ...message(), sendNow: true };
    const current = thread();
    expect(
      canDeliverQueuedMessage(entry, { thread: current, ready: false, rewinding: false }),
    ).toBe(false);
    expect(canDeliverQueuedMessage(entry, { thread: current, ready: true, rewinding: true })).toBe(
      false,
    );
    expect(canDeliverQueuedMessage(entry, { thread: current, ready: true, rewinding: false })).toBe(
      true,
    );
  });
});
