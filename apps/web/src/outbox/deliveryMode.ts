import { useSyncExternalStore } from "react";
const modes = new Map<string, "steer" | "queue">();
const listeners = new Set<() => void>();
export function useDeliveryMode(threadKey: string) {
  const mode = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => {
      if (!modes.has(threadKey)) {
        try {
          modes.set(
            threadKey,
            sessionStorage.getItem(`d3-delivery:${threadKey}`) === "queue" ? "queue" : "steer",
          );
        } catch {
          modes.set(threadKey, "steer");
        }
      }
      return modes.get(threadKey) ?? "steer";
    },
  );
  return [
    mode,
    (next: "steer" | "queue") => {
      modes.set(threadKey, next);
      try {
        sessionStorage.setItem(`d3-delivery:${threadKey}`, next);
      } catch {
        /* Keep the current session preference in memory. */
      }
      listeners.forEach((listener) => listener());
    },
  ] as const;
}
