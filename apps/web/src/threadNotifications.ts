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

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;

export function setNotificationBadge(count: number) {
  const bridge = window.desktopBridge;
  let image: string | null = null;
  if (count > 0 && (!bridge || bridge.getClientPlatform?.() === "win32")) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#e5484d";
      context.beginPath();
      context.arc(32, 32, 28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), 32, 34);
      image = canvas.toDataURL("image/png");
    }
  }
  if (!bridge) {
    if (image) {
      if (!badgeFavicon) {
        originalFavicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
        badgeFavicon = document.createElement("link");
        badgeFavicon.rel = "icon";
        badgeFavicon.type = "image/png";
        badgeFavicon.sizes.value = "64x64";
        originalFavicon?.remove();
        document.head.append(badgeFavicon);
      }
      badgeFavicon.href = image;
    } else if (badgeFavicon) {
      badgeFavicon.remove();
      badgeFavicon = undefined;
      if (originalFavicon) document.head.append(originalFavicon);
      originalFavicon = undefined;
    }
  }
  void bridge?.setNotificationBadge?.({ count, image }).catch(() => undefined);
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
