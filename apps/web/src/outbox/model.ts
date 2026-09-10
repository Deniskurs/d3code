import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";

export interface OutboxMessage {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly input: StartThreadTurnInput;
  readonly queuedAt: string;
  readonly status: "waiting" | "paused" | "editing" | "sending" | "submitted" | "failed";
  readonly error?: string | undefined;
  readonly localAttachments?: readonly (ComposerImageAttachment | ComposerFileAttachment)[];
  readonly prepared?: boolean;
  readonly editingFrom?: "waiting" | "paused";
  readonly sendNow?: boolean;
  readonly dispatchAttempted?: boolean;
  readonly sessionUpdatedAtBeforeDispatch?: string | null;
}

export type OutboxDeliveryState =
  | "offline"
  | "unavailable"
  | "paused"
  | "waiting"
  | "send"
  | "submitted"
  | "finished";

function threadHasPendingWork(thread: OrchestrationThreadShell): boolean {
  return (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness === "working" ||
    (thread.latestUserMessageAt != null &&
      (thread.session == null || thread.latestUserMessageAt > thread.session.updatedAt))
  );
}

export function shouldQueueSubmission(
  thread: OrchestrationThreadShell | null | undefined,
  hasPendingMessages: boolean,
  dispatchPending = false,
): boolean {
  return (
    hasPendingMessages ||
    dispatchPending ||
    (thread != null &&
      (threadHasPendingWork(thread) || thread.hasPendingApprovals || thread.hasPendingUserInput))
  );
}

export function nextOutboxMessage(messages: readonly OutboxMessage[]): OutboxMessage | undefined {
  return messages.find((message) => message.sendNow && message.status === "waiting") ?? messages[0];
}

export function outboxDeliveryState(
  message: OutboxMessage,
  thread: OrchestrationThreadShell | undefined,
  connected: boolean,
  live: boolean,
): OutboxDeliveryState {
  if (!connected || !live) return "offline";
  if (!thread || thread.archivedAt) return "unavailable";
  if (message.status === "submitted") {
    // Message projection alone is not completion: its session may still be the
    // idle snapshot from before dispatch. A newer settled session also covers
    // text-only turns whose shell has no checkpoint-backed latestTurn.
    const createdAt = message.input.createdAt;
    const turn = thread.latestTurn;
    const turnSettled =
      createdAt != null &&
      turn != null &&
      turn.requestedAt >= createdAt &&
      turn.state !== "running";
    const sessionSettled =
      createdAt != null &&
      thread.latestUserMessageAt != null &&
      thread.latestUserMessageAt >= createdAt &&
      thread.session != null &&
      thread.session.updatedAt > thread.latestUserMessageAt;
    const sessionAdvanced =
      message.sessionUpdatedAtBeforeDispatch === undefined ||
      thread.session?.updatedAt !== message.sessionUpdatedAtBeforeDispatch;
    return (turnSettled || sessionSettled) && sessionAdvanced && !threadHasPendingWork(thread)
      ? "finished"
      : "submitted";
  }
  if (message.status === "paused" || message.status === "editing" || message.status === "failed")
    return "paused";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "paused";
  if (message.status === "sending" && message.dispatchAttempted !== false) return "send";
  if (
    !message.sendNow &&
    (thread.session?.status === "error" ||
      thread.session?.status === "interrupted" ||
      thread.session?.status === "stopped" ||
      thread.latestTurn?.state === "error" ||
      thread.latestTurn?.state === "interrupted")
  )
    return "paused";
  return threadHasPendingWork(thread) && !message.sendNow ? "waiting" : "send";
}

export function editOutboxMessage(message: OutboxMessage, text: string): OutboxMessage {
  if (message.status !== "editing") throw new Error("This message is no longer being edited.");
  if (
    !text.trim() &&
    (message.localAttachments ?? message.input.message.attachments).length === 0
  ) {
    throw new Error("Enter a message before saving.");
  }
  return {
    ...message,
    status: message.editingFrom ?? "waiting",
    input: {
      ...message.input,
      message: { ...message.input.message, text },
    },
  };
}
