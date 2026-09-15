import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { create } from "zustand";

import type { ComposerSubmissionIntent } from "./composer-logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";
import {
  createQueuedMessagePersistence,
  type QueuedMessagePersistence,
  type QueueSnapshot,
} from "./queuedMessagePersistence";
import type { ReviewCommentContext } from "./reviewCommentContext";

/** The original composer snapshot and immutable dispatch identity live in the same durable row. */
export interface QueuedComposerMessage {
  id: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  submissionIntent: ComposerSubmissionIntent;
  queuedAfterToolActivityId: string | null;
  holdUntilUserAction?: boolean;
  createdAt: string;
  input?: StartThreadTurnInput;
  status?: "waiting" | "sending" | "submitted" | "failed";
  error?: string;
  sendNow?: boolean;
  dispatchAttempted?: boolean;
  sessionUpdatedAtBeforeDispatch?: string | null;
  legacyInput?: boolean;
  legacyPrepared?: boolean;
}

export interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  hydrated: boolean;
  storageError: string | null;
  drainGeneration: number;
  hydrate(): Promise<void>;
  refresh(): Promise<void>;
  enqueue(
    threadKey: string,
    message: Omit<QueuedComposerMessage, "id">,
  ): Promise<QueuedComposerMessage>;
  take(
    threadKey: string,
    id: string,
    toolActivityId: string | null,
  ): Promise<QueuedComposerMessage | null>;
  remove(threadKey: string, id: string): Promise<QueuedComposerMessage | null>;
  holdAtFront(threadKey: string, message: QueuedComposerMessage): Promise<void>;
  /** Retained rows stay durable and held; only removed rows are returned for composer restoration. */
  drain(threadKey: string, retainIds?: readonly string[]): Promise<QueuedComposerMessage[]>;
  pause(threadKey: string, id: string, paused: boolean): Promise<void>;
  requestSendNow(threadKey: string, id: string): Promise<void>;
  markDispatching(
    threadKey: string,
    id: string,
    input: StartThreadTurnInput,
    sessionUpdatedAtBeforeDispatch?: string | null,
  ): Promise<StartThreadTurnInput | null>;
  markSubmitted(threadKey: string, id: string): Promise<void>;
  fail(threadKey: string, id: string, error: string): Promise<void>;
  /** Caller must have observed the original message and its session/turn acknowledgement. */
  complete(threadKey: string, id: string): Promise<void>;
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];
const isDefinitelyUnsent = (message: QueuedComposerMessage) =>
  !message.dispatchAttempted && message.status !== "submitted";

export function createQueuedMessageStore(
  persistence: QueuedMessagePersistence = createQueuedMessagePersistence(),
) {
  return create<QueuedMessageStoreState>()((set, get) => {
    let hydration: Promise<void> | undefined;
    let operations: Promise<unknown> = Promise.resolve();
    let publishedRevision = -1;
    const urls = new Map<string, string>();
    const imageKey = (message: QueuedComposerMessage, image: ComposerImageAttachment) =>
      `${message.id}:${image.id}`;
    const present = (message: QueuedComposerMessage): QueuedComposerMessage => ({
      ...message,
      images: message.images.map((image) => {
        const key = imageKey(message, image);
        let previewUrl = urls.get(key);
        if (!previewUrl) {
          previewUrl = URL.createObjectURL(image.file);
          urls.set(key, previewUrl);
        }
        return { ...image, previewUrl };
      }),
    });
    const publish = (
      snapshot: QueueSnapshot,
      transferred: readonly QueuedComposerMessage[] = [],
    ) => {
      if (snapshot.revision === publishedRevision) {
        if (get().storageError) set({ storageError: null });
        return;
      }
      // remove/drain transfer preview URL ownership to the composer instead of revoking it.
      const transfers = new Set(
        transferred.flatMap((message) => message.images.map((image) => imageKey(message, image))),
      );
      const live = new Set<string>();
      const queuesByThreadKey = Object.fromEntries(
        Object.entries(snapshot.queuesByThreadKey)
          .filter(([, queue]) => queue.length)
          .map(([key, queue]) => [
            key,
            queue.map((message) => {
              for (const image of message.images) live.add(imageKey(message, image));
              return present(message);
            }),
          ]),
      );
      for (const [key, url] of urls) {
        if (live.has(key)) continue;
        if (!transfers.has(key)) URL.revokeObjectURL(url);
        urls.delete(key);
      }
      publishedRevision = snapshot.revision;
      set({ queuesByThreadKey, drainGeneration: snapshot.drainGeneration, storageError: null });
    };
    // Serializing publication as well as writes prevents a stale read overwriting a local commit.
    const transact = <T>(
      update: (snapshot: QueueSnapshot) => T,
      transfer?: (result: T) => readonly QueuedComposerMessage[],
    ): Promise<T> => {
      const operation = operations.then(async () => {
        try {
          const { snapshot, result } = await persistence.transact(update);
          const transferred = transfer?.(result) ?? [];
          // Materialize returned drafts before releasing their URL ownership.
          const presented = transferred.map(present);
          publish(snapshot, presented);
          if (Array.isArray(result) && transfer) return presented as T;
          if (result !== null && transfer) return (presented[0] ?? result) as T;
          return result;
        } catch (error) {
          set({
            storageError:
              error instanceof Error ? error.message : "Could not save the message queue.",
          });
          throw error;
        }
      });
      operations = operation.catch(() => undefined);
      return operation;
    };
    const updateMessage = (
      threadKey: string,
      id: string,
      update: (message: QueuedComposerMessage) => QueuedComposerMessage | null,
    ) =>
      transact((snapshot) => {
        const queue = snapshot.queuesByThreadKey[threadKey];
        if (!queue?.some((message) => message.id === id)) return;
        snapshot.queuesByThreadKey[threadKey] = queue.flatMap((message) => {
          if (message.id !== id) return [message];
          const next = update(message);
          return next ? [next] : [];
        });
      });
    const refresh = async () => {
      await transact(() => undefined);
      for (const [threadKey, queue] of Object.entries(get().queuesByThreadKey)) {
        if (!queue.some((message) => message.status === "sending")) continue;
        await persistence.recover(threadKey, () =>
          transact((snapshot) => {
            const current = snapshot.queuesByThreadKey[threadKey];
            if (!current?.some((message) => message.status === "sending")) return;
            snapshot.queuesByThreadKey[threadKey] = current.map((message) =>
              message.status === "sending"
                ? {
                    ...message,
                    status: "failed",
                    holdUntilUserAction: true,
                    sendNow: false,
                    error: message.dispatchAttempted
                      ? "Delivery was interrupted; check the conversation before retrying the same message."
                      : "Preparation was interrupted. Resume this message when ready.",
                  }
                : message,
            );
          }),
        );
      }
    };
    persistence.subscribe(() => {
      void get()
        .refresh()
        .catch(() => undefined);
    });
    return {
      queuesByThreadKey: {},
      hydrated: false,
      storageError: null,
      drainGeneration: 0,
      async hydrate() {
        if (get().hydrated && !get().storageError) return;
        if (hydration) return hydration;
        hydration = (async () => {
          await refresh();
          set({ hydrated: true, storageError: null });
        })()
          .catch((error: unknown) => {
            set({
              storageError:
                error instanceof Error ? error.message : "Could not restore the message queue.",
            });
            throw error;
          })
          .finally(() => {
            hydration = undefined;
          });
        return hydration;
      },
      async refresh() {
        if (!get().hydrated) await get().hydrate();
        else await refresh();
      },
      async enqueue(threadKey, message) {
        const entry: QueuedComposerMessage = {
          ...structuredClone(message),
          id: randomUUID(),
          status: "waiting",
          dispatchAttempted: false,
        };
        await get().hydrate();
        await transact((snapshot) => {
          snapshot.queuesByThreadKey[threadKey] = [
            ...(snapshot.queuesByThreadKey[threadKey] ?? []),
            entry,
          ];
        });
        return get().queuesByThreadKey[threadKey]!.find((item) => item.id === entry.id)!;
      },
      async take(threadKey, id, toolActivityId) {
        if (!get().hydrated || get().storageError) return null;
        return transact((snapshot) => {
          const queue = snapshot.queuesByThreadKey[threadKey];
          const entry = queue?.find((message) => message.id === id);
          if (
            !queue ||
            !entry ||
            entry.holdUntilUserAction ||
            (entry.status ?? "waiting") !== "waiting" ||
            queue.some((message) => message.status === "sending" || message.status === "submitted")
          )
            return null;
          const candidate =
            queue.find((message) => message.sendNow && !message.holdUntilUserAction) ?? queue[0];
          if (candidate?.id !== id) return null;
          const claimed: QueuedComposerMessage = {
            ...entry,
            status: "sending",
            queuedAfterToolActivityId: toolActivityId,
          };
          snapshot.queuesByThreadKey[threadKey] = queue.map((message) =>
            message.id === id ? claimed : { ...message, queuedAfterToolActivityId: toolActivityId },
          );
          return claimed;
        });
      },
      async remove(threadKey, id) {
        await get().hydrate();
        return transact(
          (snapshot) => {
            const queue = snapshot.queuesByThreadKey[threadKey];
            const entry = queue?.find((message) => message.id === id);
            if (!queue || !entry || !isDefinitelyUnsent(entry)) return null;
            snapshot.queuesByThreadKey[threadKey] = queue.filter((message) => message.id !== id);
            return entry;
          },
          (message) => (message ? [message] : []),
        );
      },
      async holdAtFront(threadKey, message) {
        await get().hydrate();
        await transact((snapshot) => {
          const queue = snapshot.queuesByThreadKey[threadKey] ?? [];
          const current = queue.find((entry) => entry.id === message.id);
          if (!current && !isDefinitelyUnsent(message)) return;
          const entry = current ?? message;
          if (entry.status === "submitted") return;
          snapshot.queuesByThreadKey[threadKey] = [
            {
              ...entry,
              status: entry.dispatchAttempted ? "failed" : "waiting",
              holdUntilUserAction: true,
              sendNow: false,
            },
            ...queue.filter((item) => item.id !== message.id),
          ];
        });
      },
      async drain(threadKey, retainIds = []) {
        await get().hydrate();
        return transact(
          (snapshot) => {
            snapshot.drainGeneration += 1;
            const retained = new Set(retainIds);
            const removed: QueuedComposerMessage[] = [];
            snapshot.queuesByThreadKey[threadKey] = (
              snapshot.queuesByThreadKey[threadKey] ?? []
            ).flatMap((message) => {
              if (!isDefinitelyUnsent(message)) return [message];
              if (retained.has(message.id))
                return [
                  {
                    ...message,
                    status: "waiting" as const,
                    holdUntilUserAction: true,
                    sendNow: false,
                  },
                ];
              removed.push(message);
              return [];
            });
            return removed;
          },
          (messages) => messages,
        );
      },
      async pause(threadKey, id, paused) {
        await get().hydrate();
        await updateMessage(threadKey, id, (message) =>
          message.status === "submitted" || message.status === "sending"
            ? message
            : { ...message, holdUntilUserAction: paused, sendNow: false },
        );
      },
      async requestSendNow(threadKey, id) {
        await get().hydrate();
        await updateMessage(threadKey, id, (message) =>
          message.status === "submitted" || message.status === "sending"
            ? message
            : { ...message, status: "waiting", holdUntilUserAction: false, sendNow: true },
        );
      },
      async markDispatching(threadKey, id, input, sessionUpdatedAtBeforeDispatch) {
        if (!get().hydrated || get().storageError) return null;
        return transact((snapshot) => {
          const queue = snapshot.queuesByThreadKey[threadKey];
          const entry = queue?.find((message) => message.id === id);
          if (!queue || !entry || entry.status !== "sending" || entry.holdUntilUserAction)
            return null;
          if (entry.dispatchAttempted) return entry.input ?? null;
          if (
            entry.input &&
            (entry.input.threadId !== input.threadId ||
              entry.input.commandId !== input.commandId ||
              entry.input.message.messageId !== input.message.messageId)
          )
            throw new Error("Queued message identity cannot change during preparation.");
          snapshot.queuesByThreadKey[threadKey] = queue.map((message) =>
            message.id === id
              ? {
                  ...message,
                  input,
                  dispatchAttempted: true,
                  ...(sessionUpdatedAtBeforeDispatch !== undefined
                    ? { sessionUpdatedAtBeforeDispatch }
                    : {}),
                }
              : message,
          );
          return input;
        });
      },
      async markSubmitted(threadKey, id) {
        await updateMessage(threadKey, id, (message) =>
          message.dispatchAttempted ? { ...message, status: "submitted", sendNow: false } : message,
        );
      },
      async fail(threadKey, id, error) {
        await updateMessage(threadKey, id, (message) =>
          message.status === "submitted"
            ? message
            : { ...message, status: "failed", error, holdUntilUserAction: true, sendNow: false },
        );
      },
      async complete(threadKey, id) {
        await updateMessage(threadKey, id, (message) =>
          message.dispatchAttempted || message.status === "submitted" ? null : message,
        );
      },
    };
  });
}

export const useQueuedMessageStore = createQueuedMessageStore();

/** Select by sequence, not array position: persisted activity snapshots need not be sorted. */
export function latestCompletedToolActivityId(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly sequence?: number | undefined;
    readonly createdAt: string;
  }>,
): string | null {
  let latest: (typeof activities)[number] | null = null;
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") continue;
    if (
      latest === null ||
      (activity.sequence ?? -1) > (latest.sequence ?? -1) ||
      ((activity.sequence ?? -1) === (latest.sequence ?? -1) &&
        activity.createdAt > latest.createdAt)
    )
      latest = activity;
  }
  return latest?.id ?? null;
}

export function isQueuedMessageDue(input: {
  message: Pick<
    QueuedComposerMessage,
    "queuedAfterToolActivityId" | "holdUntilUserAction" | "status" | "sendNow"
  >;
  phase: "connecting" | "running" | "ready" | "disconnected";
  latestToolActivityId: string | null;
}): boolean {
  if (input.message.holdUntilUserAction || (input.message.status ?? "waiting") !== "waiting")
    return false;
  if (input.phase === "connecting" || input.phase === "disconnected") return false;
  if (input.message.sendNow || input.phase === "ready") return true;
  return input.latestToolActivityId !== input.message.queuedAfterToolActivityId;
}

export function useQueuedMessages(threadKey: string): QueuedComposerMessage[] {
  return useQueuedMessageStore((state) => state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE);
}
