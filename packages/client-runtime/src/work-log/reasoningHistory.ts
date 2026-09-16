import type { ReasoningHistoryPage } from "@t3tools/contracts";

export interface ReasoningHistoryView {
  readonly opened: boolean;
  readonly pages: ReadonlyArray<string>;
  readonly nextCursor: number | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly truncated?: boolean;
}

const INITIAL: ReasoningHistoryView = {
  opened: false,
  pages: [],
  nextCursor: null,
  loading: false,
  error: null,
};

/** One reader per environment/thread/item. Closing releases text and ignores pending responses. */
export function createReasoningHistoryReader(
  fetchPage: (cursor?: number) => Promise<ReasoningHistoryPage>,
) {
  let state = INITIAL;
  let generation = 0;
  const listeners = new Set<() => void>();
  const update = (next: ReasoningHistoryView) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      generation += 1;
      update(INITIAL);
    },
    load: async () => {
      if (state.loading || (state.pages.length > 0 && state.nextCursor === null)) return;
      const requestGeneration = generation;
      const cursor = state.pages.length === 0 ? undefined : (state.nextCursor ?? undefined);
      update({ ...state, opened: true, loading: true, error: null });
      try {
        const page = await fetchPage(cursor);
        if (generation !== requestGeneration) return;
        update({
          opened: true,
          pages: [...state.pages, page.text],
          nextCursor: page.nextCursor,
          loading: false,
          error: null,
          ...(state.truncated || page.truncated ? { truncated: true } : {}),
        });
      } catch (error) {
        if (generation !== requestGeneration) return;
        update({
          ...state,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not load thinking history. Retry when connected.",
        });
      }
    },
  };
}
