import { toastManager } from "../components/ui/toast";
import {
  startAttachmentUpload,
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
} from "../lib/attachmentUploadQueue";
import { useEffect, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { useComposerDraftStore } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { useEnvironments, useEnvironment } from "../state/environments";
import { readThreadShell, useThreadShells } from "../state/entities";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { nextOutboxMessage, outboxDeliveryState } from "./model";
import { readMessages, mutateOutbox, refreshOutbox, useOutbox } from "./store";

function EnvironmentOutbox({ environmentId }: { environmentId: EnvironmentId }) {
  const messages = useOutbox();
  const threads = useThreadShells();
  const rewindingThreadKeys = useComposerDraftStore((store) => store.rewindingThreadKeys);
  const environment = useEnvironment(environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const live = useRef({ threads, environment, shell });
  live.current = { threads, environment, shell };
  useEffect(() => {
    const threadIds = new Set(
      messages
        .filter((message) => message.environmentId === environmentId)
        .map((message) => message.input.threadId),
    );
    for (const threadId of threadIds) {
      const pending = messages.filter(
        (item) => item.environmentId === environmentId && item.input.threadId === threadId,
      );
      const candidate = nextOutboxMessage(pending);
      const thread = threads.find(
        (item) => item.environmentId === environmentId && item.id === threadId,
      );
      if (!candidate) continue;
      const eligibility = outboxDeliveryState(
        candidate,
        thread,
        environment?.connection.phase === "connected",
        shell.status === "live",
        rewindingThreadKeys.has(scopedThreadKey({ environmentId, threadId })),
      );
      if (eligibility !== "send" && eligibility !== "finished") continue;
      let changed = false;
      void navigator.locks
        .request(
          `d3-outbox-send:${environmentId}:${threadId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) return;
            for (;;) {
              const candidates = (await readMessages()).filter(
                (item) => item.environmentId === environmentId && item.input.threadId === threadId,
              );
              const message = nextOutboxMessage(candidates);
              if (!message) return;
              const state = live.current;
              const thread = readThreadShell({ environmentId, threadId }) ?? undefined;
              const action = outboxDeliveryState(
                message,
                thread,
                state.environment?.connection.phase === "connected",
                state.shell.status === "live",
                useComposerDraftStore
                  .getState()
                  .rewindingThreadKeys.has(scopedThreadKey({ environmentId, threadId })),
              );
              if (action === "finished") {
                changed = true;
                await mutateOutbox(message.id, (current) =>
                  current?.status === "submitted" ? undefined : current,
                );
                continue;
              }
              if (action !== "send") return;
              changed = true;
              let claimed = await mutateOutbox(message.id, (current) =>
                current === undefined || current.status !== message.status
                  ? current
                  : {
                      ...current,
                      status: "sending",
                      dispatchAttempted:
                        current.dispatchAttempted ??
                        (current.input.createdAt != null || current.status === "sending"),
                    },
              );
              if (!claimed || claimed.status !== "sending") return;
              try {
                if (!claimed.prepared) {
                  const attachments = claimed.localAttachments ?? [];
                  for (const attachment of attachments)
                    startAttachmentUpload({ environmentId, image: attachment });
                  await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
                  const uploaded = getUploadedAttachments({ environmentId, images: attachments });
                  if (!uploaded)
                    throw new Error(
                      "An attachment could not upload. Check the connection and retry delivery.",
                    );
                  const uploadedIdByLocalId = new Map(
                    attachments.map((attachment, index) => [attachment.id, uploaded[index]!.id]),
                  );
                  const prepared = await mutateOutbox(
                    claimed.id,
                    (current) =>
                      current && {
                        ...current,
                        prepared: true,
                        input: {
                          ...current.input,
                          message: {
                            ...current.input.message,
                            attachments: uploaded,
                            ...(current.input.message.context !== undefined
                              ? {
                                  context: {
                                    ...current.input.message.context,
                                    records: current.input.message.context.records.map((record) =>
                                      (record.kind === "image" || record.kind === "file") &&
                                      "attachmentId" in record
                                        ? {
                                            ...record,
                                            attachmentId:
                                              uploadedIdByLocalId.get(record.attachmentId) ??
                                              record.attachmentId,
                                          }
                                        : record,
                                    ),
                                  },
                                }
                              : {}),
                          },
                        },
                      },
                  );
                  if (!prepared) return;
                  claimed = prepared;
                }
                const dispatchThread = readThreadShell({ environmentId, threadId }) ?? undefined;
                const retryingDispatch = claimed.dispatchAttempted !== false;
                if (!retryingDispatch) {
                  const context = claimed.input.message.context;
                  const supportsInlineMessageContext =
                    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)
                      ?.environment.capabilities.inlineMessageContext === true;
                  const legacyMessage =
                    context !== undefined && !supportsInlineMessageContext
                      ? (() => {
                          const { context: _context, ...message } = claimed.input.message;
                          return {
                            ...message,
                            text: serializeLegacyContextMessage({
                              text: message.text,
                              records: context.records,
                            }),
                          };
                        })()
                      : undefined;
                  const dispatching = await mutateOutbox(claimed.id, (current) =>
                    current
                      ? {
                          ...current,
                          dispatchAttempted: true,
                          sessionUpdatedAtBeforeDispatch:
                            dispatchThread?.session?.updatedAt ?? null,
                          input: {
                            ...current.input,
                            ...(legacyMessage !== undefined ? { message: legacyMessage } : {}),
                            createdAt: new Date().toISOString(),
                            deliveryMode: current.sendNow ? "steer" : "queue",
                          },
                        }
                      : current,
                  );
                  if (!dispatching) return;
                  claimed = dispatching;
                }
                if (
                  outboxDeliveryState(
                    { ...claimed, dispatchAttempted: retryingDispatch },
                    readThreadShell({ environmentId, threadId }) ?? undefined,
                    live.current.environment?.connection.phase === "connected",
                    live.current.shell.status === "live",
                    useComposerDraftStore
                      .getState()
                      .rewindingThreadKeys.has(scopedThreadKey({ environmentId, threadId })),
                  ) !== "send"
                ) {
                  await mutateOutbox(claimed.id, (current) =>
                    current
                      ? { ...current, status: "waiting", dispatchAttempted: retryingDispatch }
                      : current,
                  );
                  return;
                }
                const result = await start({ environmentId, input: claimed.input });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                const sentNow = claimed.sendNow;
                await mutateOutbox(
                  claimed.id,
                  (current) =>
                    current && (sentNow ? undefined : { ...current, status: "submitted" }),
                );
                releaseDraftAttachments(claimed.localAttachments ?? []);
              } catch (error) {
                await mutateOutbox(
                  claimed.id,
                  (current) =>
                    current && {
                      ...current,
                      status: "failed",
                      error:
                        error instanceof Error
                          ? error.message
                          : "Delivery could not be confirmed. Retry safely with the same message.",
                    },
                );
              }
              return;
            }
          },
        )
        .then(async () => {
          // Notify once after releasing the delivery lock. A fast turn can settle
          // before its acknowledgement, while a render still sees the lock held.
          if (changed) await refreshOutbox();
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Queue needs attention",
            description:
              error instanceof Error ? error.message : "Reopen D3 to recover the saved queue.",
          });
        });
    }
  }, [messages, threads, rewindingThreadKeys, environment, shell, environmentId, start]);
  return null;
}

export function OutboxCoordinator() {
  const { environments } = useEnvironments();
  useEffect(() => {
    void refreshOutbox().catch(() => undefined);
  }, []);
  return environments.map((environment) => (
    <EnvironmentOutbox key={environment.environmentId} environmentId={environment.environmentId} />
  ));
}
