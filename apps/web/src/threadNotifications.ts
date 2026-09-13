import type { ClientSettings, ClientSettingsPatch } from "@t3tools/contracts/settings";

type NotificationMode = ClientSettings["notificationMode"];
export const NOTIFICATION_MODE_LABELS = {
  off: "Off",
  notifications: "Notifications only",
  sound: "Sound only",
  "notifications-and-sound": "Notifications with sound",
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

function notificationMode(sound: boolean, desktop: boolean): NotificationMode {
  return sound
    ? desktop
      ? "notifications-and-sound"
      : "sound"
    : desktop
      ? "notifications"
      : "off";
}

/** Preserve saved D3 channel opt-outs when loading settings predating the mode selector. */
export function normalizeNotificationSettings(settings: ClientSettings): ClientSettings {
  const sound = settings.agentNotificationSound && hasNotificationSound(settings.notificationMode);
  const desktop =
    settings.agentNotificationDesktop && hasDesktopNotifications(settings.notificationMode);
  return {
    ...settings,
    agentNotificationSound: sound,
    agentNotificationDesktop: desktop,
    notificationMode: notificationMode(sound, desktop),
  };
}

/** The preset and individual channel switches edit the same delivery preferences. */
export function applyNotificationSettingsPatch(
  settings: ClientSettings,
  patch: ClientSettingsPatch,
): ClientSettings {
  const next = { ...settings, ...patch };
  if (patch.notificationMode !== undefined) {
    next.agentNotificationSound = hasNotificationSound(patch.notificationMode);
    next.agentNotificationDesktop = hasDesktopNotifications(patch.notificationMode);
  } else if (
    patch.agentNotificationSound !== undefined ||
    patch.agentNotificationDesktop !== undefined
  ) {
    next.notificationMode = notificationMode(
      next.agentNotificationSound,
      next.agentNotificationDesktop,
    );
  }
  return next;
}
