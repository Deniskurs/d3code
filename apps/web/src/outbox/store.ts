import { useSyncExternalStore } from "react";
import type { OutboxMessage } from "./model";

const STORE = "messages";
const LOCK = "d3-outbox-storage";
let database: Promise<IDBDatabase> | undefined;
let snapshot: readonly OutboxMessage[] = [];
const listeners = new Set<() => void>();
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(LOCK);

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("d3-outbox", 1);
    request.addEventListener("upgradeneeded", () =>
      request.result.createObjectStore(STORE, { keyPath: "id" }),
    );
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
    request.addEventListener("blocked", () => {
      database = undefined;
      reject(new Error("Close other D3 tabs to open the queue."));
    });
  }));
}

async function transaction<A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
) {
  const tx = (await openDatabase()).transaction(STORE, mode);
  const result = run(tx.objectStore(STORE));
  await new Promise<void>((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("Could not save the queue.")));
    tx.addEventListener("error", () => reject(tx.error));
  });
  return result.result;
}

export async function readMessages(): Promise<OutboxMessage[]> {
  return ((await transaction("readonly", (store) => store.getAll())) as OutboxMessage[]).sort(
    (a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id),
  );
}

export async function refreshOutbox() {
  // The same lock prevents a slower read from overwriting a newer mutation.
  await navigator.locks.request(LOCK, async () => {
    snapshot = await readMessages();
    listeners.forEach((listener) => listener());
  });
}
channel?.addEventListener("message", () => {
  void refreshOutbox().catch(() => undefined);
});

export async function mutateOutbox(
  id: string,
  update: (current: OutboxMessage | undefined) => OutboxMessage | undefined,
) {
  return navigator.locks.request(LOCK, async () => {
    const current = (await readMessages()).find((message) => message.id === id);
    const next = update(current);
    if (next) await transaction("readwrite", (store) => store.put(next));
    else await transaction("readwrite", (store) => store.delete(id));
    snapshot = await readMessages();
    listeners.forEach((listener) => listener());
    // BroadcastChannel is scoped to this origin and has no targetOrigin argument.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    channel?.postMessage("changed");
    return next;
  });
}

export function enqueueOutbox(message: OutboxMessage) {
  return mutateOutbox(message.id, (current) => current ?? message);
}
export function useOutbox() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
  );
}
export function getOutbox() {
  return snapshot;
}
