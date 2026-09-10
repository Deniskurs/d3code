import { useEffect, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import {
  getAgentNotificationPermission,
  requestAgentNotificationPermission,
} from "../../lib/agentNotifications";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function NotificationSettingsSection() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const [permission, setPermission] = useState(getAgentNotificationPermission);
  const [requestPending, setRequestPending] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const hasNativeNotifications =
    typeof window !== "undefined" && Boolean(window.desktopBridge?.notifications);

  useEffect(() => {
    const refreshPermission = () => setPermission(getAgentNotificationPermission());
    window.addEventListener("focus", refreshPermission);
    return () => window.removeEventListener("focus", refreshPermission);
  }, []);

  const requestPermission = async () => {
    setRequestPending(true);
    setPermissionError(null);
    try {
      setPermission(await requestAgentNotificationPermission());
    } catch {
      setPermission(getAgentNotificationPermission());
      setPermissionError(
        "Could not request permission. Check this site's notification permission in your browser settings.",
      );
    } finally {
      setRequestPending(false);
    }
  };

  const permissionStatus = hasNativeNotifications
    ? "Delivered through the desktop app. Allow this app in your OS notification settings; Focus or Do Not Disturb may silence alerts."
    : permission === "granted"
      ? "Allowed in this browser. Your OS notification settings and Focus or Do Not Disturb may still silence alerts."
      : permission === "denied"
        ? "Blocked by your browser. Open this site's permissions in your browser settings and allow notifications. In-app alerts still work."
        : permission === "unsupported"
          ? "System notifications are unavailable in this browser. Use a supported browser over HTTPS or the desktop app. In-app alerts still work."
          : "Use Allow notifications to request browser permission. In-app alerts work without it.";

  return (
    <SettingsSection id="notifications" title="Notifications">
      <SettingsRow
        {...searchableSetting("agent-notifications")}
        description="Get in-app alerts when agents finish or need attention, across all threads and providers in connected environments. The thread you're viewing stays quiet while this window is focused."
        control={
          <Switch
            checked={settings.agentNotificationsEnabled}
            onCheckedChange={(checked) => {
              void updateSettings({ agentNotificationsEnabled: checked });
            }}
            aria-label="Agent alerts"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("agent-notification-sound")}
        description="Play a sound for agent alerts, independently of system notifications."
        control={
          <Switch
            checked={settings.agentNotificationSound}
            disabled={!settings.agentNotificationsEnabled}
            onCheckedChange={(checked) => {
              void updateSettings({ agentNotificationSound: checked });
            }}
            aria-label="Notification sound"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("agent-notification-desktop")}
        description="Also deliver agent alerts through your desktop or browser notification system."
        status={
          <div className="space-y-2" aria-live="polite">
            <p>{permissionStatus}</p>
            {permissionError ? <p>{permissionError}</p> : null}
            {!hasNativeNotifications && permission === "default" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !settings.agentNotificationsEnabled ||
                  !settings.agentNotificationDesktop ||
                  requestPending
                }
                onClick={() => void requestPermission()}
              >
                {requestPending ? "Requesting permission…" : "Allow notifications"}
              </Button>
            ) : null}
          </div>
        }
        control={
          <Switch
            checked={settings.agentNotificationDesktop}
            disabled={!settings.agentNotificationsEnabled}
            onCheckedChange={(checked) => {
              void updateSettings({ agentNotificationDesktop: checked });
            }}
            aria-label="System notifications"
          />
        }
      />
    </SettingsSection>
  );
}
