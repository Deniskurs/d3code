import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { AgentNotification } from "@t3tools/shared/agentAwareness";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export function getAgentNotificationPermission(): NotificationPermission | "unsupported" {
  if (window.desktopBridge?.notifications) return "granted";
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export async function requestAgentNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  const permission = getAgentNotificationPermission();
  if (permission !== "default") return permission;
  return Notification.requestPermission();
}

const DELIVERED_KEY = "d3:agent-notifications:delivered";
const decodeDelivered = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const localDelivered = new Set<string>();

/** One sound/system alert per event across same-origin browser tabs. */
async function claimNotification(id: string): Promise<boolean> {
  const claim = () => {
    let delivered: readonly string[] = [];
    try {
      const saved = localStorage.getItem(DELIVERED_KEY);
      if (saved !== null) delivered = Option.getOrElse(decodeDelivered(saved), () => []);
    } catch {
      // Restricted storage still supports per-client notifications.
    }
    if (localDelivered.has(id) || delivered.includes(id)) return false;
    localDelivered.add(id);
    if (localDelivered.size > 128) localDelivered.delete(localDelivered.values().next().value!);
    try {
      localStorage.setItem(DELIVERED_KEY, JSON.stringify([...delivered.slice(-127), id]));
    } catch {
      // Storage availability must not disable alerts.
    }
    return true;
  };
  return navigator.locks ? navigator.locks.request(DELIVERED_KEY, claim) : claim();
}

let audioContext: AudioContext | null = null;
let lastSoundAt = -Infinity;

/** Audio is unlocked only by a user gesture; never keep an idle audio device running. */
export function installAgentNotificationAudio(): () => void {
  const unlock = () => {
    if (typeof AudioContext === "undefined") return;
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    audioContext ??= new AudioContext();
    void audioContext
      .resume()
      .then(() => audioContext?.suspend())
      .catch(() => undefined);
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    const context = audioContext;
    audioContext = null;
    if (context) void context.close().catch(() => undefined);
  };
}

function playNotificationSound(phase: AgentNotification["phase"]): void {
  const context = audioContext;
  if (!context || Date.now() - lastSoundAt < 750) return;
  lastSoundAt = Date.now();
  void context
    .resume()
    .then(() => {
      if (context !== audioContext || context.state === "closed") return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      oscillator.frequency.setValueAtTime(phase === "completed" ? 660 : 880, start);
      oscillator.frequency.setValueAtTime(phase === "completed" ? 880 : 660, start + 0.1);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.addEventListener(
        "ended",
        () => {
          oscillator.disconnect();
          gain.disconnect();
          void context.suspend().catch(() => undefined);
        },
        { once: true },
      );
      oscillator.start(start);
      oscillator.stop(start + 0.26);
    })
    .catch(() => undefined);
}

async function showSystemNotification(
  notification: AgentNotification,
  onOpen: () => void,
  silent: boolean,
): Promise<(() => void) | null> {
  const title = `${notification.headline}: ${notification.threadTitle}`;
  const body = notification.projectTitle;
  const threadRef = { environmentId: notification.environmentId, threadId: notification.threadId };
  const bridge = window.desktopBridge?.notifications;
  if (bridge) {
    const shown = await bridge.show({ id: notification.id, title, body, threadRef, silent });
    return shown
      ? () => {
          void bridge.dismiss(notification.id).catch(() => undefined);
        }
      : null;
  }
  if (getAgentNotificationPermission() !== "granted") return null;
  const systemNotification = new Notification(title, {
    body,
    tag: scopedThreadKey(threadRef),
    silent,
  });
  const open = () => {
    window.focus();
    onOpen();
  };
  systemNotification.addEventListener("click", open);
  return () => {
    systemNotification.removeEventListener("click", open);
    systemNotification.close();
  };
}

type NotificationSettings = Pick<
  ClientSettings,
  "agentNotificationsEnabled" | "agentNotificationDesktop" | "agentNotificationSound"
>;

export interface AgentNotificationDelivery {
  dismiss(ref: ScopedThreadRef): void;
  open(ref: ScopedThreadRef): void;
  clear(): void;
  reconcile(): void;
  notify(notification: AgentNotification): Promise<void>;
}

/** Owns alert lifetime, including cancellation while native IPC is still pending. */
export function createAgentNotificationDelivery(options: {
  readonly settings: () => NotificationSettings;
  readonly isViewing: (ref: ScopedThreadRef) => boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
  readonly showToast: (notification: AgentNotification, onOpen: () => void) => () => void;
}): AgentNotificationDelivery {
  const active = new Map<
    string,
    {
      notification: AgentNotification;
      closeToast: () => void;
      closeSystem: (() => void) | null;
    }
  >();

  const dismiss = (ref: ScopedThreadRef) => {
    const key = scopedThreadKey(ref);
    const entry = active.get(key);
    if (!entry) return;
    active.delete(key);
    entry.closeToast();
    entry.closeSystem?.();
  };
  const open = (ref: ScopedThreadRef) => {
    if (!active.has(scopedThreadKey(ref))) return;
    dismiss(ref);
    options.onOpen(ref);
  };
  const clear = () => {
    for (const entry of active.values()) dismiss(entry.notification);
  };
  const reconcile = () => {
    const settings = options.settings();
    if (!settings.agentNotificationsEnabled) return clear();
    for (const entry of active.values()) {
      if (options.isViewing(entry.notification)) dismiss(entry.notification);
      else if (!settings.agentNotificationDesktop) {
        entry.closeSystem?.();
        entry.closeSystem = null;
      }
    }
  };

  return {
    dismiss,
    open,
    clear,
    reconcile,
    async notify(notification: AgentNotification) {
      const key = scopedThreadKey(notification);
      if (active.get(key)?.notification.id === notification.id) return;
      dismiss(notification);
      if (!options.settings().agentNotificationsEnabled || options.isViewing(notification)) return;
      if (active.size >= 64) {
        const oldest = active.values().next().value;
        if (oldest) dismiss(oldest.notification);
      }
      const onOpen = () => open(notification);
      const entry = {
        notification,
        closeToast: options.showToast(notification, onOpen),
        closeSystem: null as (() => void) | null,
      };
      active.set(key, entry);
      const claimed = await claimNotification(notification.id).catch(() => false);
      reconcile();
      if (!claimed || active.get(key) !== entry) return;
      if (options.settings().agentNotificationDesktop) {
        entry.closeSystem = await showSystemNotification(
          notification,
          onOpen,
          !options.settings().agentNotificationSound,
        ).catch(() => null);
        reconcile();
        if (active.get(key) !== entry) {
          entry.closeSystem?.();
          return;
        }
      }
      if (!entry.closeSystem && options.settings().agentNotificationSound) {
        playNotificationSound(notification.phase);
      }
    },
  };
}
