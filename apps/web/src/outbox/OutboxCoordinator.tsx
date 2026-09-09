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
import { useEnvironments, useEnvironment } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { outboxDeliveryState } from "./model";
import { readMessages, mutateOutbox, refreshOutbox, useOutbox } from "./store";

function EnvironmentOutbox({ environmentId }: { environmentId: EnvironmentId }) {
  const messages = useOutbox();
  const threads = useThreadShells();
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
      const candidate =
        pending.find((item) => item.sendNow && item.status === "waiting") ?? pending[0];
      const thread = threads.find(
        (item) => item.environmentId === environmentId && item.id === threadId,
      );
      if (!candidate) continue;
      const eligibility = outboxDeliveryState(
        candidate,
        thread,
        environment?.connection.phase === "connected",
        shell.status === "live",
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
              const message =
                candidates.find((item) => item.sendNow && item.status === "waiting") ??
                candidates[0];
              if (!message) return;
              const state = live.current;
              const thread = state.threads.find(
                (item) => item.environmentId === environmentId && item.id === threadId,
              );
              const action = outboxDeliveryState(
                message,
                thread,
                state.environment?.connection.phase === "connected",
                state.shell.status === "live",
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
                      input:
                        current.status === "sending"
                          ? current.input
                          : {
                              ...current.input,
                              createdAt: new Date().toISOString(),
                              deliveryMode: current.sendNow ? "steer" : "queue",
                            },
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
                  const prepared = await mutateOutbox(
                    claimed.id,
                    (current) =>
                      current && {
                        ...current,
                        prepared: true,
                        input: {
                          ...current.input,
                          message: { ...current.input.message, attachments: uploaded },
                        },
                      },
                  );
                  if (!prepared) return;
                  claimed = prepared;
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
  }, [messages, threads, environment, shell, environmentId, start]);
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
