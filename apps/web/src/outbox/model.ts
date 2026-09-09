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
  readonly sendNow?: boolean;
}

export function outboxDeliveryState(
  message: OutboxMessage,
  thread: OrchestrationThreadShell | undefined,
  connected: boolean,
  live: boolean,
): "offline" | "unavailable" | "paused" | "waiting" | "send" | "submitted" | "finished" {
  if (!connected || !live) return "offline";
  if (!thread || thread.archivedAt) return "unavailable";
  if (message.status === "submitted") {
    // A dispatch acknowledgement can arrive before its projection. Do not send
    // the next item against the idle snapshot from before this command.
    const turn = thread.latestTurn;
    return turn &&
      message.input.createdAt &&
      turn.requestedAt >= message.input.createdAt &&
      turn.state !== "running" &&
      thread.session?.status !== "running" &&
      thread.session?.status !== "starting"
      ? "finished"
      : "submitted";
  }
  if (message.status === "paused" || message.status === "editing" || message.status === "failed")
    return "paused";
  if (message.status === "sending") return "send"; // Retry the same immutable command after a reload.
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "paused";
  if (
    !message.sendNow &&
    (thread.session?.status === "error" ||
      thread.session?.status === "interrupted" ||
      thread.session?.status === "stopped" ||
      thread.latestTurn?.state === "error" ||
      thread.latestTurn?.state === "interrupted")
  )
    return "paused";
  const busy =
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running";
  return busy && !message.sendNow ? "waiting" : "send";
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
    status: "waiting",
    input: {
      ...message.input,
      message: { ...message.input.message, text },
    },
  };
}
