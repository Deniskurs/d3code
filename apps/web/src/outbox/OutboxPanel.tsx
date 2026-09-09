import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEnvironment } from "../state/environments";
import { useThreadShell } from "../state/entities";
import { environmentShell } from "../state/shell";
import { outboxDeliveryState } from "./model";
import { useState } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Button } from "../components/ui/button";
import { editOutboxMessage, type OutboxMessage } from "./model";
import { mutateOutbox, useOutbox } from "./store";

function OutboxRow({
  message,
  delivery,
}: {
  message: OutboxMessage;
  delivery: ReturnType<typeof outboxDeliveryState>;
}) {
  const [text, setText] = useState(message.input.message.text);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function change(update: (current: OutboxMessage) => OutboxMessage | undefined) {
    setBusy(true);
    setError(null);
    try {
      await mutateOutbox(message.id, (current) => {
        if (!current || current.status !== message.status)
          throw new Error("This message has already moved on. The queue has been refreshed.");
        return update(current);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the queue.");
    } finally {
      setBusy(false);
    }
  }
  const editable =
    message.status === "waiting" || message.status === "paused" || message.status === "editing";
  return (
    <li className="space-y-2 border-t border-border/60 py-2.5 first:border-t-0">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm line-clamp-3">
          {message.input.message.text}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground" role="status">
          {message.status === "sending"
            ? "Submitting..."
            : message.status === "submitted"
              ? "Submitted"
              : message.status === "failed"
                ? "Needs attention"
                : message.status === "editing"
                  ? "Paused for editing"
                  : delivery === "offline"
                    ? "Waiting for connection"
                    : delivery === "unavailable"
                      ? "Thread unavailable"
                      : delivery === "paused"
                        ? "Paused"
                        : "Waiting"}
        </span>
      </div>
      {(message.localAttachments ?? message.input.message.attachments).length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {(message.localAttachments ?? message.input.message.attachments)
            .map((attachment) => attachment.name)
            .join(", ")}
        </p>
      ) : null}
      {message.status === "editing" ? (
        <>
          <textarea
            aria-label="Edit queued message"
            className="min-h-24 w-full rounded-md border border-input bg-background p-2 text-sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex gap-1">
            <Button
              size="xs"
              disabled={busy}
              onClick={() => void change((current) => editOutboxMessage(current, text))}
            >
              Save
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void change((current) => ({ ...current, status: "waiting" }))}
            >
              Cancel edit
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-1">
          {editable ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setText(message.input.message.text);
                  void change((current) => ({ ...current, status: "editing" }));
                }}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void change((current) => ({ ...current, status: "waiting", sendNow: true }))
                }
              >
                Send now
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void change((current) => ({
                    ...current,
                    status: current.status === "paused" ? "waiting" : "paused",
                  }))
                }
              >
                {message.status === "paused" ? "Resume queue" : "Pause queue"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void change(() => undefined)}
              >
                Remove
              </Button>
            </>
          ) : null}
          {message.status === "failed" ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void change((current) => ({ ...current, status: "sending", error: undefined }))
                }
              >
                Retry delivery
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void change(() => undefined)}
              >
                Stop retrying
              </Button>
              <span className="self-center text-xs text-muted-foreground">
                Removing this entry does not cancel a task already received by OMP.
              </span>
            </>
          ) : null}
        </div>
      )}
      {message.error || error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? message.error}
        </p>
      ) : null}
    </li>
  );
}

export function OutboxPanel({
  environmentId,
  threadId,
  working,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  working: boolean;
}) {
  const messages = useOutbox().filter(
    (message) => message.environmentId === environmentId && message.input.threadId === threadId,
  );
  const environment = useEnvironment(environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  if (messages.length === 0) return null;
  return (
    <section
      aria-label="Queued messages"
      className="mx-2 mb-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">Queue ({messages.length})</h3>
        <span className="text-xs text-muted-foreground">Saved on this device</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {working
          ? "Runs in order after this task. Send now steers OMP at its next message boundary."
          : "Sends when connected and ready. After a stopped or failed task, use Send now to continue."}
      </p>
      <ul className="max-h-64 overflow-y-auto">
        {messages.map((message) => (
          <OutboxRow
            key={message.id}
            message={message}
            delivery={outboxDeliveryState(
              message,
              thread ?? undefined,
              environment?.connection.phase === "connected",
              shell.status === "live",
            )}
          />
        ))}
      </ul>
    </section>
  );
}
