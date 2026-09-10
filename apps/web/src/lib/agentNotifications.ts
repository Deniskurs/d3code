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

/** Commit a cross-tab claim only when this client can deliver that channel. */
async function claimNotification(id: string, deliver: () => boolean): Promise<boolean> {
  const claim = () => {
    let delivered: readonly string[] = [];
    try {
      const saved = localStorage.getItem(DELIVERED_KEY);
      if (saved !== null) delivered = Option.getOrElse(decodeDelivered(saved), () => []);
    } catch {
      // Restricted storage still supports per-client notifications.
    }
    if (localDelivered.has(id) || delivered.includes(id)) return false;
    if (!deliver()) return false;
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
let audioUnlocked = false;
let audioActivation: Promise<void> | null = null;
let audioSuspension: Promise<void> | null = null;
let pendingSounds = 0;
let playingSounds = 0;

function suspendIdleAudio(context: AudioContext): Promise<void> | undefined {
  if (context !== audioContext || pendingSounds > 0 || playingSounds > 0) {
    return;
  }
  if (audioSuspension) return audioSuspension;
  const suspension = context.suspend().catch(() => undefined);
  audioSuspension = suspension;
  void suspension.then(() => {
    if (audioSuspension === suspension) audioSuspension = null;
  });
  return suspension;
}

/** Capture gestures before editors stop propagation; failed activation can be retried. */
export function installAgentNotificationAudio(): () => void {
  const target = window;
  const unlock = () => {
    if (typeof AudioContext === "undefined" || audioUnlocked) return;
    try {
      const context = (audioContext ??= new AudioContext());
      const activation = context
        .resume()
        .then(async () => {
          if (context !== audioContext || audioActivation !== activation) return;
          audioUnlocked = context.state === "running";
          await suspendIdleAudio(context);
        })
        .catch(() => {
          if (context === audioContext && audioActivation === activation) audioUnlocked = false;
        });
      audioActivation = activation;
      void activation.then(() => {
        if (audioActivation === activation) audioActivation = null;
      });
    } catch {
      // A later gesture can retry if the audio device was unavailable.
    }
  };
  target.addEventListener("pointerdown", unlock, true);
  target.addEventListener("keydown", unlock, true);
  return () => {
    target.removeEventListener("pointerdown", unlock, true);
    target.removeEventListener("keydown", unlock, true);
    const context = audioContext;
    audioContext = null;
    audioUnlocked = false;
    audioActivation = null;
    audioSuspension = null;
    pendingSounds = 0;
    playingSounds = 0;
    lastSoundAt = -Infinity;
    if (context) void context.close().catch(() => undefined);
  };
}

async function playNotificationSound(
  notification: AgentNotification,
  canPlay: () => boolean,
): Promise<void> {
  // Browser tabs need activation. Electron's app renderer permits autoplay,
  // including alerts that arrive before the first click after launch.
  if (!canPlay() || typeof AudioContext === "undefined") return;
  if (!audioUnlocked && !audioActivation && !window.desktopBridge) return;
  let context: AudioContext;
  try {
    context = audioContext ??= new AudioContext();
  } catch {
    return;
  }
  pendingSounds += 1;
  try {
    await audioActivation;
    await audioSuspension;
    if (context !== audioContext || !canPlay()) return;
    await context.resume();
    if (context !== audioContext || context.state !== "running") return;
    audioUnlocked = true;
    await claimNotification(`sound:${notification.id}`, () => {
      if (context !== audioContext || context.state !== "running" || !canPlay()) return false;
      const now = Date.now();
      if (now - lastSoundAt < 750) return true;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      oscillator.frequency.setValueAtTime(notification.phase === "completed" ? 660 : 880, start);
      oscillator.frequency.setValueAtTime(
        notification.phase === "completed" ? 880 : 660,
        start + 0.1,
      );
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
          if (context !== audioContext) return;
          playingSounds -= 1;
          void suspendIdleAudio(context);
        },
        { once: true },
      );
      oscillator.start(start);
      oscillator.stop(start + 0.26);
      playingSounds += 1;
      lastSoundAt = now;
      return true;
    });
  } catch {
    // A transient device failure does not revoke an earlier user activation.
    // Leave this event unclaimed so another audio-ready tab can deliver it.
  } finally {
    if (context === audioContext) {
      pendingSounds -= 1;
      await suspendIdleAudio(context);
    }
  }
}

async function showSystemNotification(
  notification: AgentNotification,
  onOpen: () => void,
): Promise<(() => void) | null> {
  const title = `${notification.headline}: ${notification.threadTitle}`;
  const body = notification.projectTitle;
  const threadRef = { environmentId: notification.environmentId, threadId: notification.threadId };
  const bridge = window.desktopBridge?.notifications;
  if (bridge) {
    const shown = await bridge.show({ id: notification.id, title, body, threadRef, silent: true });
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
    silent: true,
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
  readonly isSelected: (ref: ScopedThreadRef) => boolean;
  readonly isAppFocused: () => boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
  readonly showToast: (notification: AgentNotification, onOpen: () => void) => () => void;
}): AgentNotificationDelivery {
  const active = new Map<
    string,
    {
      notification: AgentNotification;
      closeToast: (() => void) | null;
      closeSystem: (() => void) | null;
    }
  >();
  const isViewing = (ref: ScopedThreadRef) => options.isSelected(ref) && options.isAppFocused();

  const dismiss = (ref: ScopedThreadRef) => {
    const key = scopedThreadKey(ref);
    const entry = active.get(key);
    if (!entry) return;
    active.delete(key);
    entry.closeToast?.();
    entry.closeSystem?.();
  };
  const open = (ref: ScopedThreadRef) => {
    if (!active.has(scopedThreadKey(ref))) return;
    dismiss(ref);
    if (!options.isSelected(ref)) options.onOpen(ref);
  };
  const clear = () => {
    for (const entry of active.values()) dismiss(entry.notification);
  };
  const reconcile = () => {
    const settings = options.settings();
    if (!settings.agentNotificationsEnabled) return clear();
    for (const entry of active.values()) {
      if (isViewing(entry.notification)) {
        dismiss(entry.notification);
        continue;
      }
      if (options.isSelected(entry.notification)) {
        entry.closeToast?.();
        entry.closeToast = null;
      }
      if (!settings.agentNotificationDesktop) {
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
      if (!options.settings().agentNotificationsEnabled || isViewing(notification)) return;
      if (active.size >= 64) {
        const oldest = active.values().next().value;
        if (oldest) dismiss(oldest.notification);
      }
      const onOpen = () => open(notification);
      const entry = {
        notification,
        closeToast: options.isSelected(notification)
          ? null
          : options.showToast(notification, onOpen),
        closeSystem: null as (() => void) | null,
      };
      active.set(key, entry);
      const canDeliver = () =>
        active.get(key) === entry &&
        options.settings().agentNotificationsEnabled &&
        !isViewing(notification);
      // Sound is independent of OS delivery and its permission/settings. Separate
      // claims let an audio-ready tab sound an event another tab already displayed.
      const sound = playNotificationSound(
        notification,
        () => canDeliver() && options.settings().agentNotificationSound,
      );
      const system = async () => {
        const claimed = await claimNotification(
          `system:${notification.id}`,
          () =>
            canDeliver() &&
            options.settings().agentNotificationDesktop &&
            getAgentNotificationPermission() === "granted",
        ).catch(() => false);
        if (!claimed || !canDeliver()) return;
        entry.closeSystem = await showSystemNotification(notification, onOpen).catch(() => null);
        reconcile();
        if (active.get(key) !== entry) entry.closeSystem?.();
      };
      await Promise.all([sound, system()]);
    },
  };
}
