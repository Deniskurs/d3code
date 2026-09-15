import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";

import {
  isQueuedMessageDue,
  latestCompletedToolActivityId,
  type QueuedComposerMessage,
  type QueuedMessageStoreState,
} from "./queuedMessageStore";
import { derivePhase } from "./session-logic";

export interface QueueDeliverySnapshot {
  thread: EnvironmentThread | null;
  ready: boolean;
  rewinding: boolean;
}

type DeliveryStore = Pick<
  QueuedMessageStoreState,
  | "refresh"
  | "take"
  | "drainGeneration"
  | "markDispatching"
  | "markSubmitted"
  | "complete"
  | "fail"
  | "queuesByThreadKey"
  | "hydrated"
  | "storageError"
>;

/** A message projection alone is not an acknowledgement of the new turn. */
export function hasQueuedMessageReceipt(
  message: QueuedComposerMessage,
  thread: EnvironmentThread,
): boolean {
  const input = message.input;
  if (!input || !thread.messages.some((item) => item.id === input.message.messageId)) return false;
  const session = thread.session;
  if (!session) return false;
  const phase = derivePhase(session);
  if (phase === "connecting") return false;
  // A running session or a later tool boundary acknowledges mid-turn steering.
  if (phase === "running") {
    return (
      (message.sessionUpdatedAtBeforeDispatch != null &&
        session.updatedAt > message.sessionUpdatedAtBeforeDispatch) ||
      (input.createdAt != null && session.updatedAt >= input.createdAt) ||
      latestCompletedToolActivityId(thread.activities) !== message.queuedAfterToolActivityId
    );
  }
  const turn = thread.latestTurn;
  if (session.updatedAt === message.sessionUpdatedAtBeforeDispatch || turn?.state === "running")
    return false;
  return (
    input.createdAt != null &&
    ((turn != null && turn.requestedAt >= input.createdAt) || session.updatedAt > input.createdAt)
  );
}

function queuedMessageSafetyAllows(
  message: QueuedComposerMessage,
  snapshot: QueueDeliverySnapshot,
): boolean {
  const { thread } = snapshot;
  if (!snapshot.ready || snapshot.rewinding || !thread || thread.archivedAt || thread.deletedAt)
    return false;
  const pending = derivePendingRequests(thread.activities);
  if (pending.approvals.length > 0 || pending.userInputs.length > 0) return false;
  if (
    !message.sendNow &&
    (thread.session?.status === "error" ||
      thread.session?.status === "interrupted" ||
      thread.session?.status === "stopped" ||
      thread.latestTurn?.state === "error" ||
      thread.latestTurn?.state === "interrupted")
  )
    return false;
  return !message.holdUntilUserAction;
}

export function canDeliverQueuedMessage(
  message: QueuedComposerMessage,
  snapshot: QueueDeliverySnapshot,
): boolean {
  return (
    queuedMessageSafetyAllows(message, snapshot) &&
    isQueuedMessageDue({
      message,
      phase: derivePhase(snapshot.thread?.session ?? null),
      latestToolActivityId: latestCompletedToolActivityId(snapshot.thread?.activities ?? []),
    })
  );
}

/** Runs under the per-thread cross-tab send lock, separate from storage transactions. */
export async function deliverQueuedMessage(options: {
  threadKey: string;
  store: () => DeliveryStore;
  snapshot: () => QueueDeliverySnapshot;
  prepare: (message: QueuedComposerMessage) => Promise<StartThreadTurnInput>;
  dispatch: (input: StartThreadTurnInput) => Promise<void>;
}): Promise<boolean> {
  const { threadKey, store, snapshot } = options;
  await store().refresh();
  if (!store().hydrated || store().storageError) return false;
  const queue = store().queuesByThreadKey[threadKey] ?? [];
  const view = snapshot();
  if (!view.ready || view.rewinding || !view.thread) return false;
  const submitted = queue.find((item) => item.status === "submitted");
  if (submitted) {
    if (!hasQueuedMessageReceipt(submitted, view.thread)) return false;
    await store().complete(threadKey, submitted.id);
    return true;
  }
  if (queue.some((item) => item.status === "sending")) return false;
  const candidate = queue.find((item) => item.sendNow && !item.holdUntilUserAction) ?? queue[0];
  if (!candidate || !canDeliverQueuedMessage(candidate, view)) return false;
  // Ambiguous retries may already be present even if the dispatch response was lost.
  if (candidate.dispatchAttempted && hasQueuedMessageReceipt(candidate, view.thread)) {
    await store().complete(threadKey, candidate.id);
    return true;
  }
  const drainGeneration = store().drainGeneration;
  const claimed = await store().take(
    threadKey,
    candidate.id,
    latestCompletedToolActivityId(view.thread.activities),
  );
  if (!claimed) return false;
  try {
    const prepared =
      claimed.dispatchAttempted && claimed.input ? claimed.input : await options.prepare(claimed);
    // Drain/Stop can run while uploads are pending, including from another tab.
    await store().refresh();
    const current = store().queuesByThreadKey[threadKey]?.find((item) => item.id === claimed.id);
    if (!current || current.status !== "sending") return true;
    const dispatchView = snapshot();
    // A claim already consumed its timing boundary; recheck safety, not timing.
    if (
      store().storageError ||
      store().drainGeneration !== drainGeneration ||
      !queuedMessageSafetyAllows(current, dispatchView)
    ) {
      await store().fail(
        threadKey,
        claimed.id,
        "Delivery paused during preparation. Retry when the thread is ready.",
      );
      return true;
    }
    const input = await store().markDispatching(
      threadKey,
      claimed.id,
      prepared,
      dispatchView.thread?.session?.updatedAt ?? null,
    );
    if (!input) return true;
    const dispatchState = store();
    const dispatching = dispatchState.queuesByThreadKey[threadKey]?.find(
      (item) => item.id === claimed.id,
    );
    if (
      !dispatching ||
      dispatching.status !== "sending" ||
      dispatchState.storageError ||
      dispatchState.drainGeneration !== drainGeneration ||
      !queuedMessageSafetyAllows(dispatching, snapshot())
    ) {
      await store().fail(
        threadKey,
        claimed.id,
        "Delivery paused before dispatch. Retry when the thread is ready.",
      );
      return true;
    }
    await options.dispatch(input);
    await store().markSubmitted(threadKey, claimed.id);
  } catch (error) {
    await store().fail(
      threadKey,
      claimed.id,
      error instanceof Error
        ? error.message
        : "Delivery could not be confirmed. Retry with the same message.",
    );
  }
  return true;
}
