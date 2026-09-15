import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { mergeEnvironmentThread } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { useEffect, useRef, useState } from "react";

import { useComposerDraftStore } from "./composerDraftStore";
import { toastManager } from "./components/ui/toast";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "./lib/attachmentUploadQueue";
import { deliverQueuedMessage } from "./queuedMessageDelivery";
import {
  type QueuedComposerMessage,
  useQueuedMessageStore,
  useQueuedMessages,
} from "./queuedMessageStore";
import { appAtomRegistry } from "./rpc/atomRegistry";
import {
  readThreadShell,
  useThreadDetail,
  useThreadShell,
  useThreadStatus,
} from "./state/entities";
import { useEnvironment } from "./state/environments";
import { environmentServerConfigsAtom } from "./state/server";
import { environmentShell } from "./state/shell";
import { environmentThreadDetails, threadEnvironment } from "./state/threads";
import { useAtomCommand } from "./state/use-atom-command";

function reportQueueError(error: unknown) {
  toastManager.add({
    type: "error",
    title: "Queue needs attention",
    description: error instanceof Error ? error.message : "The saved queue could not be updated.",
  });
}

async function prepareQueuedInput(
  ref: ScopedThreadRef,
  message: QueuedComposerMessage,
): Promise<StartThreadTurnInput> {
  if (!message.input)
    throw new Error(
      "This saved message has no delivery snapshot. Restore it to the composer before sending.",
    );
  if (message.dispatchAttempted) return message.input;
  let input = message.input;
  if (!message.legacyPrepared) {
    const attachments = [...message.images, ...message.files];
    const threadKey = scopedThreadKey(ref);
    const current = useQueuedMessageStore
      .getState()
      .queuesByThreadKey[threadKey]?.find((item) => item.id === message.id);
    if (current?.status !== "sending" || current.holdUntilUserAction) {
      throw new Error("Delivery was cancelled before attachments uploaded.");
    }
    // Stop removes an unattempted claim durably. Cancel its uploads immediately
    // rather than waiting for the upload promise before checking that claim.
    const unsubscribe = useQueuedMessageStore.subscribe((state) => {
      const current = state.queuesByThreadKey[threadKey]?.find((item) => item.id === message.id);
      if (current?.status !== "sending" || current.holdUntilUserAction) {
        for (const attachment of attachments) {
          if (readAttachmentUpload(attachment.id)?.status === "uploading") {
            releaseAttachmentUpload(attachment.id);
          }
        }
      }
    });
    try {
      for (const image of attachments) {
        if (readAttachmentUpload(image.id)?.status === "failed") {
          retryAttachmentUpload({ environmentId: ref.environmentId, image });
        } else {
          startAttachmentUpload({ environmentId: ref.environmentId, image });
        }
      }
      await awaitAttachmentUploads(attachments.map((item) => item.id));
      const uploaded = getUploadedAttachments({
        environmentId: ref.environmentId,
        images: attachments,
      });
      if (!uploaded)
        throw new Error("An attachment could not upload. Check the connection and retry delivery.");
      const ids = new Map(attachments.map((item, index) => [item.id, uploaded[index]!.id]));
      input = {
        ...input,
        message: {
          ...input.message,
          attachments: [...input.message.attachments, ...uploaded],
          ...(input.message.context !== undefined
            ? {
                context: {
                  ...input.message.context,
                  records: input.message.context.records.map((record) =>
                    (record.kind === "image" || record.kind === "file") && "attachmentId" in record
                      ? {
                          ...record,
                          attachmentId: ids.get(record.attachmentId) ?? record.attachmentId,
                        }
                      : record,
                  ),
                },
              }
            : {}),
        },
      };
    } finally {
      unsubscribe();
    }
  }
  const context = input.message.context;
  const supportsContext =
    appAtomRegistry.get(environmentServerConfigsAtom).get(ref.environmentId)?.environment
      .capabilities.inlineMessageContext === true;
  if (context !== undefined && !supportsContext) {
    const { context: _context, ...body } = input.message;
    input = {
      ...input,
      message: {
        ...body,
        text: serializeLegacyContextMessage({ text: body.text, records: context.records }),
      },
    };
  }
  // Imported inputs retain their original method semantics and complete payload.
  return message.legacyInput ? input : { ...input, deliveryMode: "steer" };
}

function QueuedThread({ threadKey, threadRef }: { threadKey: string; threadRef: ScopedThreadRef }) {
  const messages = useQueuedMessages(threadKey);
  const detail = useThreadDetail(threadRef);
  const threadShell = useThreadShell(threadRef);
  const status = useThreadStatus(threadRef);
  const environment = useEnvironment(threadRef.environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(threadRef.environmentId));
  const rewinding = useComposerDraftStore((state) => state.rewindingThreadKeys.has(threadKey));
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const busy = useRef(false);
  const dirty = useRef(false);
  const live = useRef({ environment, shell, status });
  live.current = { environment, shell, status };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (environment?.connection.phase === "connected" && status === "live") {
      void useQueuedMessageStore.getState().refresh().catch(reportQueueError);
    }
  }, [environment?.connection.phase, status]);
  useEffect(() => {
    if (busy.current) {
      dirty.current = true;
      return;
    }
    if (!navigator.locks) {
      reportQueueError(new Error("Durable queue delivery requires browser lock support."));
      return;
    }
    busy.current = true;
    dirty.current = false;
    void navigator.locks
      .request(`t3-queued-message-send:${threadKey}`, { ifAvailable: true }, async (lock) => {
        if (!lock || !mounted.current) return;
        await deliverQueuedMessage({
          threadKey,
          store: useQueuedMessageStore.getState,
          snapshot: () => {
            const currentShell = readThreadShell(threadRef);
            const awaitingSession =
              currentShell?.latestUserMessageAt != null &&
              (currentShell.session == null ||
                currentShell.latestUserMessageAt > currentShell.session.updatedAt);
            return {
              thread: mergeEnvironmentThread(
                appAtomRegistry.get(environmentThreadDetails.detailAtom(threadRef)),
                currentShell,
              ),
              ready:
                mounted.current &&
                currentShell !== null &&
                live.current.environment?.connection.phase === "connected" &&
                live.current.shell.status === "live" &&
                appAtomRegistry.get(environmentThreadDetails.statusAtom(threadRef)) === "live" &&
                !currentShell.hasPendingApprovals &&
                !currentShell.hasPendingUserInput &&
                !awaitingSession,
              rewinding: useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey),
            };
          },
          prepare: (message) => prepareQueuedInput(threadRef, message),
          dispatch: async (input) => {
            const result = await start({ environmentId: threadRef.environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            const sent = useQueuedMessageStore
              .getState()
              .queuesByThreadKey[threadKey]?.find(
                (message) => message.input?.message.messageId === input.message.messageId,
              );
            if (sent) releaseDraftAttachments([...sent.images, ...sent.files]);
          },
        });
      })
      .catch(reportQueueError)
      .finally(() => {
        busy.current = false;
        // Store publications can render while this lock is still held. Re-run
        // once after releasing it so acknowledgements cannot be stranded.
        if (dirty.current && mounted.current) setRevision((value) => value + 1);
      });
  }, [
    messages,
    detail,
    threadShell,
    status,
    environment,
    shell,
    rewinding,
    start,
    threadKey,
    threadRef,
    revision,
  ]);
  return null;
}

/** Mount once inside the root atom/connection providers, outside routed content. */
export function QueuedMessageCoordinator() {
  const hydrated = useQueuedMessageStore((state) => state.hydrated);
  const queues = useQueuedMessageStore((state) => state.queuesByThreadKey);
  useEffect(() => {
    const refresh = () => {
      void useQueuedMessageStore.getState().refresh().catch(reportQueueError);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    void useQueuedMessageStore.getState().hydrate().catch(reportQueueError);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  if (!hydrated) return null;
  return Object.keys(queues).map((threadKey) => {
    if (!queues[threadKey]?.length) return null;
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef ? (
      <QueuedThread key={threadKey} threadKey={threadKey} threadRef={threadRef} />
    ) : null;
  });
}
