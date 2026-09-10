import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  InfoIcon,
  ListOrderedIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  PauseIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { ComposerBanner } from "../components/chat/ComposerBanner";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Textarea } from "../components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useEnvironment } from "../state/environments";
import { useThreadShell } from "../state/entities";
import { environmentShell } from "../state/shell";
import {
  editOutboxMessage,
  outboxDeliveryState,
  type OutboxDeliveryState,
  type OutboxMessage,
} from "./model";
import { mutateOutbox, useOutbox } from "./store";

function OutboxRow({
  message,
  delivery,
  sendNowDelivery,
}: {
  message: OutboxMessage;
  delivery: OutboxDeliveryState;
  sendNowDelivery: OutboxDeliveryState;
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
  const editable = message.status === "waiting" || message.status === "paused";
  const attachments = message.localAttachments ?? message.input.message.attachments;
  const sendNowUnavailable = sendNowDelivery !== "send";
  const sendNowHint =
    sendNowDelivery === "offline"
      ? "Reconnect and wait for this thread to sync before sending."
      : sendNowDelivery === "unavailable"
        ? "This thread is unavailable."
        : sendNowUnavailable
          ? "Resolve the pending approval or question before sending."
          : "Send ahead of the queue. A running task receives this at its next supported boundary.";
  const status =
    message.status === "sending"
      ? "Submitting"
      : message.status === "failed"
        ? "Needs attention"
        : message.status === "editing"
          ? "Editing"
          : delivery === "offline"
            ? "Offline"
            : delivery === "unavailable"
              ? "Unavailable"
              : delivery === "paused"
                ? "Paused"
                : null;
  const edit = () => {
    setText(message.input.message.text);
    void change((current) => ({
      ...current,
      status: "editing",
      editingFrom: current.status === "paused" ? "paused" : "waiting",
    }));
  };
  return (
    <li>
      <ComposerBanner.Row className="rounded-md hover:bg-foreground/3">
        <ComposerBanner.Icon>
          {status === "Paused" ? <PauseIcon /> : <ChevronRightIcon />}
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left outline-none focus-visible:underline disabled:cursor-default"
                  disabled={!editable || busy}
                  onClick={edit}
                />
              }
            >
              {message.input.message.text || "Attached files"}
            </TooltipTrigger>
            <TooltipPopup className="max-w-sm whitespace-pre-wrap break-words">
              {message.input.message.text || "Attached files"}
            </TooltipPopup>
          </Tooltip>
          {attachments.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"
                    aria-label={`${attachments.length} attachments`}
                  />
                }
              >
                <PaperclipIcon className="size-3" />
                {attachments.length}
              </TooltipTrigger>
              <TooltipPopup>
                {attachments.map((attachment) => attachment.name).join(", ")}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="flex-nowrap">
          {status ? (
            <span role="status" className="text-[11px] text-muted-foreground">
              {status}
            </span>
          ) : null}
          {editable ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      tabIndex={sendNowUnavailable ? 0 : undefined}
                      aria-label={
                        sendNowUnavailable ? `Send now unavailable. ${sendNowHint}` : undefined
                      }
                    />
                  }
                >
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="group h-6 gap-1 rounded-full px-2 text-[11px] duration-150 motion-reduce:transition-none motion-reduce:[&:active:not([aria-haspopup])]:scale-100 sm:text-[11px]"
                    disabled={busy || sendNowUnavailable}
                    aria-label="Send queued message now"
                    onClick={() =>
                      void change((current) => ({ ...current, status: "waiting", sendNow: true }))
                    }
                  >
                    <ArrowUpRightIcon
                      aria-hidden="true"
                      className="size-3.5 text-current transition-transform duration-150 motion-safe:group-hover:-translate-y-px motion-safe:group-hover:translate-x-px motion-reduce:transition-none"
                    />
                    Send now
                  </Button>
                </TooltipTrigger>
                <TooltipPopup className="max-w-64">{sendNowHint}</TooltipPopup>
              </Tooltip>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={busy}
                      aria-label="Queued message actions"
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={edit}>Edit message</MenuItem>
                  <MenuItem
                    onClick={() =>
                      void change((current) => ({
                        ...current,
                        status: current.status === "paused" ? "waiting" : "paused",
                      }))
                    }
                  >
                    {message.status === "paused" ? "Resume from here" : "Pause from here"}
                  </MenuItem>
                  <MenuItem onClick={() => void change(() => undefined)}>
                    Remove from queue
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </>
          ) : null}
          {message.status === "failed" ? (
            <>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void change((current) => ({ ...current, status: "sending", error: undefined }))
                }
              >
                Retry
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={busy}
                      aria-label="Stop retrying this message"
                      onClick={() => void change(() => undefined)}
                    />
                  }
                >
                  <XIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>
                  Remove from this queue. Does not cancel a task already received by the agent.
                </TooltipPopup>
              </Tooltip>
            </>
          ) : null}
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      {message.status === "editing" ? (
        <div className="space-y-2 px-3 pb-2 pt-1">
          <Textarea
            aria-label="Edit queued message"
            size="sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                void change((current) => ({
                  ...current,
                  status: current.editingFrom ?? "waiting",
                }));
              }
            }}
          />
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void change((current) => ({ ...current, status: current.editingFrom ?? "waiting" }))
              }
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={busy}
              onClick={() => void change((current) => editOutboxMessage(current, text))}
            >
              Save message
            </Button>
          </div>
        </div>
      ) : null}
      {message.error || error ? (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {error ?? message.error}
        </p>
      ) : null}
    </li>
  );
}

export function OutboxPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const messages = useOutbox().filter(
    (message) =>
      message.environmentId === environmentId &&
      message.input.threadId === threadId &&
      message.status !== "submitted",
  );
  const environment = useEnvironment(environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  if (messages.length === 0) return null;
  return (
    <ComposerBanner.Attachment data-chat-composer-collapsed-controls="true">
      <ComposerBanner.Root aria-label="Queued messages">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((value) => !value)}
            >
              Queued <ComposerBanner.Count>{messages.length}</ComposerBanner.Count>
              {expanded ? (
                <ChevronDownIcon className="size-3" />
              ) : (
                <ChevronRightIcon className="size-3" />
              )}
            </button>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="About queued messages"
                  />
                }
              >
                <InfoIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup className="max-w-64">
                Saved on this device. Messages run in order while D3 is open and connected. Delivery
                pauses for approvals, stopped tasks, and errors.
              </TooltipPopup>
            </Tooltip>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {expanded ? (
          <ComposerBanner.Scroll>
            <ComposerBanner.Children render={<ul />} id={listId} aria-label="Queued prompts">
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
                  sendNowDelivery={outboxDeliveryState(
                    { ...message, status: "waiting", sendNow: true },
                    thread ?? undefined,
                    environment?.connection.phase === "connected",
                    shell.status === "live",
                  )}
                />
              ))}
            </ComposerBanner.Children>
          </ComposerBanner.Scroll>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
