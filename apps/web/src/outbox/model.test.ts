import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import {
  editOutboxMessage,
  nextOutboxMessage,
  outboxDeliveryState,
  shouldQueueSubmission,
  type OutboxMessage,
} from "./model";

const message: OutboxMessage = {
  id: "message",
  environmentId: EnvironmentId.make("environment"),
  queuedAt: "2026-09-09T10:00:00.000Z",
  status: "waiting",
  input: {
    commandId: CommandId.make("command"),
    threadId: ThreadId.make("thread"),
    message: {
      messageId: MessageId.make("message"),
      role: "user",
      text: "Original",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-09T10:01:00.000Z",
  },
};
// The scheduler only depends on these shell fields, not titles or model catalogs.
const ready = {
  archivedAt: null,
  session: { status: "ready" },
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
} as OrchestrationThreadShell;
const running = { ...ready, session: { ...ready.session!, status: "running" as const } };
const state = (item = message, thread = ready, connected = true, live = true) =>
  outboxDeliveryState(item, thread, connected, live);

describe("device outbox delivery", () => {
  it("waits for a live connected snapshot and a finished task", () => {
    expect(state(message, running)).toBe("waiting");
    expect(state(message, ready, false)).toBe("offline");
    expect(state(message, ready, true, false)).toBe("offline");
    expect(state()).toBe("send");
  });
  it("pauses after stop, error, approval or user input", () => {
    for (const status of ["error", "interrupted", "stopped"] as const) {
      expect(state(message, { ...ready, session: { ...ready.session!, status } })).toBe("paused");
    }
    expect(state(message, { ...ready, hasPendingApprovals: true })).toBe("paused");
    expect(state(message, { ...ready, hasPendingUserInput: true })).toBe("paused");
    expect(state({ ...message, sendNow: true }, { ...ready, hasPendingUserInput: true })).toBe(
      "paused",
    );
    expect(
      state(
        { ...message, status: "sending", dispatchAttempted: true },
        { ...ready, hasPendingApprovals: true },
      ),
    ).toBe("paused");
  });
  it("send now steers a running task but never bypasses required answers", () => {
    expect(state({ ...message, sendNow: true }, running)).toBe("send");
    expect(state({ ...message, sendNow: true }, { ...running, hasPendingApprovals: true })).toBe(
      "paused",
    );
  });
  it("cannot drain a message while it is being edited or explicitly paused", () => {
    expect(state({ ...message, status: "editing" })).toBe("paused");
    expect(state({ ...message, status: "paused" })).toBe("paused");
    expect(state({ ...message, status: "failed" })).toBe("paused");
  });
  it("holds the next message until the acknowledged turn appears and settles", () => {
    const submitted = { ...message, status: "submitted" as const };
    expect(state(submitted)).toBe("submitted");
    const turn = {
      turnId: TurnId.make("turn"),
      state: "completed" as const,
      requestedAt: "2026-09-09T10:00:00.000Z",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    };
    expect(state(submitted, { ...ready, latestTurn: turn })).toBe("submitted");
    expect(
      state(submitted, {
        ...ready,
        latestTurn: { ...turn, requestedAt: message.input.createdAt!, state: "running" },
      }),
    ).toBe("submitted");
    expect(
      state(submitted, {
        ...ready,
        latestTurn: { ...turn, requestedAt: message.input.createdAt! },
      }),
    ).toBe("finished");
  });
  it("drains checkpoint-free completion, but not a stale idle acknowledgement", () => {
    const submitted = { ...message, status: "submitted" as const };
    const projectedMessage = {
      ...ready,
      latestUserMessageAt: message.input.createdAt!,
      session: { ...ready.session!, updatedAt: "2026-09-09T10:00:59.000Z" },
    };
    expect(state(submitted, projectedMessage)).toBe("submitted");
    expect(state(message, projectedMessage)).toBe("waiting");
    const completed = {
      ...projectedMessage,
      session: { ...projectedMessage.session, updatedAt: "2026-09-09T10:01:05.000Z" },
    };
    expect(state(submitted, completed)).toBe("finished");
    expect(state(message, completed)).toBe("send");
    expect(state(submitted, { ...completed, backgroundLiveness: "working" })).toBe("submitted");
    expect(state(submitted, { ...completed, backgroundLiveness: "monitoring" })).toBe("finished");
    expect(
      state(
        { ...submitted, sessionUpdatedAtBeforeDispatch: completed.session.updatedAt },
        completed,
      ),
    ).toBe("submitted");
  });
  it("rechecks work after preparing attachments without treating preparation as dispatch", () => {
    expect(state({ ...message, status: "sending", dispatchAttempted: false }, running)).toBe(
      "waiting",
    );
    expect(state({ ...message, status: "sending", dispatchAttempted: true }, running)).toBe("send");
  });
  it("recovers an interrupted dispatch without changing the immutable command", () => {
    const sending = { ...message, status: "sending" as const };
    expect(state(sending, running)).toBe("send");
    expect(() => editOutboxMessage(sending, "Changed")).toThrow();
    expect(sending.input.commandId).toBe("command");
  });
  it("saves an edit without dropping attachments, model options, or identity", () => {
    const edited = editOutboxMessage({ ...message, status: "editing" }, "Updated");
    expect(edited.status).toBe("waiting");
    expect(edited.input).toEqual({
      ...message.input,
      message: { ...message.input.message, text: "Updated" },
    });
    expect(() => editOutboxMessage({ ...message, status: "editing" }, "  ")).toThrow();
  });
  it("keeps a deliberately paused queue paused after editing", () => {
    const edited = editOutboxMessage(
      { ...message, status: "editing", editingFrom: "paused" },
      "Updated",
    );
    expect(edited.status).toBe("paused");
    expect(state(edited)).toBe("paused");
  });
  it("does not dispatch to an archived or missing thread", () => {
    expect(state(message, { ...ready, archivedAt: "2026-09-09T10:00:00.000Z" })).toBe(
      "unavailable",
    );
    expect(outboxDeliveryState(message, undefined, true, true)).toBe("unavailable");
  });
});

describe("queue-first submissions", () => {
  it("starts idle threads immediately, including an uncreated draft", () => {
    expect(shouldQueueSubmission(ready, false)).toBe(false);
    expect(shouldQueueSubmission(null, false)).toBe(false);
  });
  it("queues running, starting, background work and local dispatch catch-up", () => {
    expect(shouldQueueSubmission(running, false)).toBe(true);
    expect(
      shouldQueueSubmission(
        { ...ready, session: { ...ready.session!, status: "starting" } },
        false,
      ),
    ).toBe(true);
    expect(shouldQueueSubmission({ ...ready, backgroundLiveness: "working" }, false)).toBe(true);
    expect(shouldQueueSubmission({ ...ready, backgroundLiveness: "monitoring" }, false)).toBe(
      false,
    );
    expect(shouldQueueSubmission(ready, false, true)).toBe(true);
  });
  it("does not leapfrog saved messages or bypass required answers", () => {
    expect(shouldQueueSubmission(ready, true)).toBe(true);
    expect(shouldQueueSubmission({ ...ready, hasPendingApprovals: true }, false)).toBe(true);
    expect(shouldQueueSubmission({ ...ready, hasPendingUserInput: true }, false)).toBe(true);
  });
  it("keeps FIFO, including paused heads, unless a waiting item explicitly requests Send now", () => {
    const paused = { ...message, status: "paused" as const };
    const second = { ...message, id: "second" };
    expect(nextOutboxMessage([paused, second])).toBe(paused);
    const explicit = { ...second, sendNow: true };
    expect(nextOutboxMessage([paused, explicit])).toBe(explicit);
    expect(nextOutboxMessage([paused, { ...explicit, status: "editing" }])).toBe(paused);
  });
});
