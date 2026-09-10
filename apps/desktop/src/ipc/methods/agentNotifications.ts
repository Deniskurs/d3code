import { DesktopAgentNotification } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAgentNotifications from "../../notifications/DesktopAgentNotifications.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class AgentNotificationUnauthorizedSenderError extends Schema.TaggedError<AgentNotificationUnauthorizedSenderError>()(
  "AgentNotificationUnauthorizedSenderError",
  {},
) {}

const ensureTrustedSender = Effect.fn("desktop.ipc.agentNotifications.ensureTrustedSender")(
  function* (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id
    ) {
      return yield* new AgentNotificationUnauthorizedSenderError();
    }
    return main.value;
  },
);

export const show = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_NOTIFICATION_SHOW_CHANNEL,
  payload: DesktopAgentNotification,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.agentNotifications.show")(function* (input, event) {
    const window = yield* ensureTrustedSender(event);
    return yield* (yield* DesktopAgentNotifications.DesktopAgentNotifications).show(input, window);
  }),
});

export const dismiss = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_NOTIFICATION_DISMISS_CHANNEL,
  payload: DesktopAgentNotification.fields.id,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.agentNotifications.dismiss")(function* (id, event) {
    yield* ensureTrustedSender(event);
    yield* (yield* DesktopAgentNotifications.DesktopAgentNotifications).dismiss(id);
  }),
});
