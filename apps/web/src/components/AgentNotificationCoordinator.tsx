import { useNavigate, useParams } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createAgentNotificationTracker } from "@t3tools/shared/agentAwareness";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  getClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import {
  createAgentNotificationDelivery,
  installAgentNotificationAudio,
  type AgentNotificationDelivery,
} from "../lib/agentNotifications";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";

function EnvironmentAgentNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const deliveryRef = useRef<AgentNotificationDelivery | null>(null);
  const navigate = useNavigate();
  const settings = useClientSettings();
  const route = useParams({ strict: false, select: resolveThreadRouteTarget });
  const draft = useComposerDraftStore((store) =>
    route?.kind === "draft" ? store.getDraftSession(route.draftId) : null,
  );
  const activeRef = resolveActiveThreadRouteRef(route, draft) ?? draft;
  const isAppFocused = useEffectEvent(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  const isSelected = useEffectEvent(
    (ref: ScopedThreadRef) =>
      activeRef?.environmentId === ref.environmentId && activeRef.threadId === ref.threadId,
  );
  const onOpen = useEffectEvent((ref: ScopedThreadRef) => {
    if (!readThreadShell(ref)) return;
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  });
  // React can coalesce renders for a fast turn. Observe shell atom writes
  // directly, without mounting any thread-detail subscriptions.
  useEffect(() => {
    const tracker = createAgentNotificationTracker(environmentId);
    const delivery = createAgentNotificationDelivery({
      settings: getClientSettings,
      isSelected,
      isAppFocused,
      onOpen,
      showToast: (notification, open) => {
        const toastId = toastManager.add(
          stackedThreadToast({
            type:
              notification.phase === "completed"
                ? "success"
                : notification.phase === "failed"
                  ? "error"
                  : "warning",
            title: `${notification.headline}: ${notification.threadTitle}`,
            description: notification.projectTitle,
            timeout: notification.phase === "completed" ? 5_000 : 8_000,
            // Deliberately global: thread-scoped toasts are hidden on other tabs.
            data: { hideCopyButton: true },
            actionProps: { children: "Open thread", onClick: open },
          }),
        );
        return () => toastManager.close(toastId);
      },
    });
    deliveryRef.current = delivery;
    const unsubscribe = appAtomRegistry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (state) => {
        const result = tracker.update(Option.getOrNull(state.snapshot), state.status === "live");
        for (const threadId of result.dismiss)
          delivery.dismiss(scopeThreadRef(environmentId, threadId));
        for (const notification of result.notifications) void delivery.notify(notification);
      },
      { immediate: true },
    );
    const stopClicks = window.desktopBridge?.notifications?.onClicked((ref) => {
      if (ref.environmentId === environmentId) delivery.open(ref);
    });
    const reconcile = () => delivery.reconcile();
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      unsubscribe();
      stopClicks?.();
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
      delivery.clear();
      deliveryRef.current = null;
    };
  }, [environmentId]);

  useEffect(() => {
    const delivery = deliveryRef.current;
    if (!delivery) return;
    if (!settings.agentNotificationsEnabled) delivery.clear();
    else if (activeRef || !settings.agentNotificationDesktop) delivery.reconcile();
  }, [activeRef, settings.agentNotificationsEnabled, settings.agentNotificationDesktop]);
  return null;
}

export function AgentNotificationCoordinator() {
  const { environments } = useEnvironments();
  const hydrated = useClientSettingsHydrated();
  useEffect(installAgentNotificationAudio, []);
  if (!hydrated) return null;
  return environments.map(({ environmentId }) => (
    <EnvironmentAgentNotifications key={environmentId} environmentId={environmentId} />
  ));
}
