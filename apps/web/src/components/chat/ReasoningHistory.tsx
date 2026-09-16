import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { createReasoningHistoryCommand } from "@t3tools/client-runtime/state/reasoning-history";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createReasoningHistoryReader } from "@t3tools/client-runtime/work-log/reasoning-history";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";

const historyCommand = createReasoningHistoryCommand(connectionAtomRuntime);

export function ReasoningHistory(props: {
  readonly threadRef: ScopedThreadRef;
  readonly itemId: string;
  readonly preview: string | null;
}) {
  const loadPage = useAtomCommand(historyCommand, { reportFailure: false });
  const { environmentId, threadId } = props.threadRef;
  const { itemId } = props;
  const reader = useMemo(
    () =>
      createReasoningHistoryReader(async (cursor) => {
        const result = await loadPage({
          environmentId,
          input: { threadId, itemId, ...(cursor === undefined ? {} : { cursor }) },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      }),
    [environmentId, threadId, itemId, loadPage],
  );
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => () => reader.close(), [reader]);

  return (
    <div
      className="mt-1 ms-7 cursor-default space-y-2 rounded-md bg-muted/40 px-3 py-2"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {!state.opened ? (
        <>
          {props.preview ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {props.preview}
            </pre>
          ) : null}
          <button type="button" className="text-xs underline" onClick={() => void reader.load()}>
            View full thinking history
          </button>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Emitted thinking history</span>
            <button type="button" className="underline" onClick={reader.close}>
              Back to preview
            </button>
          </div>
          {state.truncated ? (
            <p role="status" className="text-xs text-muted-foreground">
              The history storage limit was reached. Saved text is preserved; newer thinking remains
              in the live preview.
            </p>
          ) : null}
          {state.pages.length > 0 ? (
            <pre
              aria-label="Thinking history"
              tabIndex={0}
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground"
            >
              {state.pages}
            </pre>
          ) : null}
          {state.loading ? (
            <p role="status" className="text-xs">
              Loading thinking history…
            </p>
          ) : null}
          {state.error ? (
            <div role="alert" className="text-xs text-destructive">
              <p>{state.error}</p>
              <button type="button" className="underline" onClick={() => void reader.load()}>
                Retry
              </button>
            </div>
          ) : state.nextCursor !== null && !state.loading ? (
            <button type="button" className="text-xs underline" onClick={() => void reader.load()}>
              Load more
            </button>
          ) : null}
          {state.pages.length > 0 && state.nextCursor === null && !state.loading ? (
            <p className="text-xs text-muted-foreground">End of currently saved thinking.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
