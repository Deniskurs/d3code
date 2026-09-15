import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { EnvironmentId } from "@t3tools/contracts";

import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import {
  asKnownContextRecord,
  previewAnnotationFromRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
} from "./lib/composerContextRecords";
import type { QueuedComposerMessage } from "./queuedMessageStore";

export interface QueueSnapshot {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  drainGeneration: number;
  revision: number;
  legacyMigrationComplete: boolean;
}

/** Internal seam: replace changed rows/arrays; callbacks run synchronously on the latest commit. */
export interface QueuedMessagePersistence {
  transact<T>(
    update: (snapshot: QueueSnapshot) => T,
  ): Promise<{ snapshot: QueueSnapshot; result: T }>;
  subscribe(listener: () => void): () => void;
  recover(threadKey: string, run: () => Promise<void>): Promise<void>;
}

export interface IndexedDbQueuedMessagePersistence extends QueuedMessagePersistence {
  close(): Promise<void>;
}

interface LegacyMessage {
  id: string;
  environmentId: EnvironmentId;
  input: StartThreadTurnInput;
  queuedAt: string;
  status: "waiting" | "paused" | "editing" | "sending" | "submitted" | "failed";
  error?: string;
  localAttachments?: readonly (ComposerImageAttachment | ComposerFileAttachment)[];
  prepared?: boolean;
  dispatchAttempted?: boolean;
  sessionUpdatedAtBeforeDispatch?: string | null;
}

/** Runs in the same transaction as the marker: retiring a migrated row cannot resurrect it. */
export function importLegacyQueue(snapshot: QueueSnapshot, legacy: readonly LegacyMessage[]): void {
  if (snapshot.legacyMigrationComplete) return;
  for (const previous of [...legacy].sort(
    (a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id),
  )) {
    const threadKey = scopedThreadKey({
      environmentId: previous.environmentId,
      threadId: previous.input.threadId,
    });
    const queue = snapshot.queuesByThreadKey[threadKey] ?? [];
    if (queue.some((message) => message.id === previous.id)) continue;
    // Old sending rows without the newer flag may already have reached the server.
    const attempted =
      previous.dispatchAttempted ??
      (previous.status === "sending" ||
        previous.status === "submitted" ||
        previous.status === "failed");
    const message: QueuedComposerMessage = {
      id: previous.id,
      input: previous.input,
      prompt: previous.input.message.text,
      createdAt: previous.queuedAt,
      images: [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      submissionIntent: "foreground",
      queuedAfterToolActivityId: null,
      status: previous.status === "submitted" ? "submitted" : attempted ? "failed" : "waiting",
      holdUntilUserAction: true,
      dispatchAttempted: attempted,
      legacyInput: true,
      legacyPrepared: previous.prepared === true || attempted,
      ...(previous.error !== undefined ? { error: previous.error } : {}),
      ...(previous.sessionUpdatedAtBeforeDispatch !== undefined
        ? { sessionUpdatedAtBeforeDispatch: previous.sessionUpdatedAtBeforeDispatch }
        : {}),
    };
    for (const attachment of previous.localAttachments ?? []) {
      if (attachment.type === "image" && attachment.file)
        message.images.push(attachment as ComposerImageAttachment);
      else message.files.push(attachment as ComposerFileAttachment);
    }
    for (const raw of previous.input.message.context?.records ?? []) {
      const record = asKnownContextRecord(raw);
      if (record?.kind === "terminal")
        message.terminalContexts.push(
          terminalContextDraftFromRecord(record, previous.input.threadId),
        );
      else if (record?.kind === "review-comment")
        message.reviewComments.push(reviewCommentFromRecord(record));
      else if (record?.kind === "preview-annotation")
        message.previewAnnotations.push(previewAnnotationFromRecord(record));
    }
    snapshot.queuesByThreadKey[threadKey] = [...queue, message];
  }
  snapshot.legacyMigrationComplete = true;
}

const DATABASE = "t3-queued-messages";
const STORAGE_LOCK = "t3-queued-message-storage";
const THREADS = "threads";
const META = "metadata";

function openDatabase(onClose: () => void): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let failed = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore(THREADS, { keyPath: "key" });
      request.result.createObjectStore(META);
    };
    request.onsuccess = () => {
      if (failed) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => {
        request.result.close();
        onClose();
      };
      request.result.onclose = onClose;
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open the queue."));
    request.onblocked = () => {
      failed = true;
      reject(new Error("Close older T3 tabs to open the message queue."));
    };
  });
}

async function readLegacyMessages(): Promise<LegacyMessage[]> {
  // Aborting an initial upgrade probes absence without creating/deleting a legacy database.
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open("d3-outbox");
    let absent = false;
    let failed = false;
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      if (failed) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => (absent ? resolve(null) : reject(request.error));
    request.onblocked = () => {
      failed = true;
      reject(new Error("Close older D3 tabs to recover their message queue."));
    };
  });
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains("messages")) return [];
    return await new Promise<LegacyMessage[]>((resolve, reject) => {
      const transaction = db.transaction("messages", "readonly");
      const request = transaction.objectStore("messages").getAll();
      transaction.oncomplete = () => resolve(request.result as LegacyMessage[]);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Could not read the old queue."));
    });
  } finally {
    db.close();
  }
}

export function createQueuedMessagePersistence(): IndexedDbQueuedMessagePersistence {
  let database: Promise<IDBDatabase> | undefined;
  let legacy: LegacyMessage[] | undefined;
  let channel: BroadcastChannel | undefined;
  const listeners = new Set<() => void>();
  const ensureChannel = () => {
    if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(STORAGE_LOCK);
      channel.onmessage = () => {
        for (const listener of listeners) listener();
      };
    }
  };
  return {
    async close() {
      const close = async () => {
        const pending = database;
        database = undefined;
        legacy = undefined;
        channel?.close();
        channel = undefined;
        if (pending) (await pending.catch(() => undefined))?.close();
      };
      if (globalThis.navigator?.locks) await navigator.locks.request(STORAGE_LOCK, close);
      else await close();
    },
    subscribe(listener) {
      listeners.add(listener);
      ensureChannel();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          channel?.close();
          channel = undefined;
        }
      };
    },
    async recover(threadKey, run) {
      if (!globalThis.navigator?.locks)
        throw new Error("Durable queued delivery requires browser storage locks.");
      await navigator.locks.request(
        `t3-queued-message-send:${threadKey}`,
        { ifAvailable: true },
        async (lock) => {
          if (lock) await run();
        },
      );
    },
    async transact<T>(update: (snapshot: QueueSnapshot) => T) {
      if (!globalThis.indexedDB || !globalThis.navigator?.locks)
        throw new Error("Durable message storage is unavailable in this browser.");
      ensureChannel();
      return navigator.locks.request(STORAGE_LOCK, async () => {
        const db = await (database ??= openDatabase(() => {
          database = undefined;
        }).catch((error: unknown) => {
          database = undefined;
          throw error;
        }));
        if (legacy === undefined) {
          const migrated = await new Promise<boolean>((resolve, reject) => {
            const transaction = db.transaction(META, "readonly");
            const request = transaction.objectStore(META).get("state");
            transaction.oncomplete = () =>
              resolve(request.result?.legacyMigrationComplete === true);
            transaction.onabort = () => reject(transaction.error);
          });
          legacy = migrated ? [] : await readLegacyMessages();
        }
        let changed = false;
        const outcome = await new Promise<{ snapshot: QueueSnapshot; result: T }>(
          (resolve, reject) => {
            const transaction = db.transaction([THREADS, META], "readwrite");
            const threads = transaction.objectStore(THREADS);
            const metadata = transaction.objectStore(META);
            const rows = threads.getAll();
            const meta = metadata.get("state");
            let committed: { snapshot: QueueSnapshot; result: T };
            let failure: unknown;
            meta.onsuccess = () => {
              try {
                const original = Object.fromEntries(
                  (rows.result as { key: string; messages: QueuedComposerMessage[] }[]).map(
                    (row) => [row.key, row.messages],
                  ),
                );
                for (const queue of Object.values(original)) {
                  for (const message of queue) Object.freeze(message);
                  Object.freeze(queue);
                }
                const oldMeta = meta.result as
                  | { drainGeneration: number; revision: number; legacyMigrationComplete: boolean }
                  | undefined;
                const snapshot: QueueSnapshot = {
                  queuesByThreadKey: { ...original },
                  drainGeneration: oldMeta?.drainGeneration ?? 0,
                  revision: oldMeta?.revision ?? 0,
                  legacyMigrationComplete: oldMeta?.legacyMigrationComplete ?? false,
                };
                importLegacyQueue(snapshot, legacy ?? []);
                const result = update(snapshot);
                for (const key of new Set([
                  ...Object.keys(original),
                  ...Object.keys(snapshot.queuesByThreadKey),
                ])) {
                  const messages = snapshot.queuesByThreadKey[key];
                  if (messages === original[key]) continue;
                  changed = true;
                  if (!messages?.length) threads.delete(key);
                  else
                    threads.put({
                      key,
                      messages: messages.map((message) => ({
                        ...message,
                        images: message.images.map((image) => ({ ...image, previewUrl: "" })),
                      })),
                    });
                }
                if (
                  snapshot.drainGeneration !== oldMeta?.drainGeneration ||
                  snapshot.legacyMigrationComplete !== oldMeta?.legacyMigrationComplete
                ) {
                  changed = true;
                }
                if (changed) {
                  snapshot.revision += 1;
                  metadata.put(
                    {
                      drainGeneration: snapshot.drainGeneration,
                      revision: snapshot.revision,
                      legacyMigrationComplete: snapshot.legacyMigrationComplete,
                    },
                    "state",
                  );
                }
                committed = { snapshot, result };
              } catch (error) {
                failure = error;
                transaction.abort();
              }
            };
            transaction.oncomplete = () => resolve(committed);
            transaction.onabort = () =>
              reject(
                failure ?? transaction.error ?? new Error("Could not save the message queue."),
              );
          },
        );
        if (changed) {
          // BroadcastChannel is origin-scoped, not a Window postMessage destination.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          channel?.postMessage("changed");
        }
        return outcome;
      });
    },
  };
}
