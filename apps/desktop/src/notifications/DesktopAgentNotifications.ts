import type { DesktopAgentNotification } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { AGENT_NOTIFICATION_CLICKED_CHANNEL } from "../ipc/channels.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";

const MAX_NOTIFICATIONS = 32;

export class DesktopAgentNotificationError extends Schema.TaggedError<DesktopAgentNotificationError>()(
  "DesktopAgentNotificationError",
  { cause: Schema.Defect() },
) {}

export class DesktopAgentNotifications extends Context.Service<
  DesktopAgentNotifications,
  {
    readonly show: (
      input: DesktopAgentNotification,
      window: Electron.BrowserWindow,
    ) => Effect.Effect<boolean, DesktopAgentNotificationError>;
    readonly dismiss: (id: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/notifications/DesktopAgentNotifications") {}

interface Entry {
  readonly notification: Electron.Notification;
  clicking: boolean;
}

const { logWarning } = makeComponentLogger("desktop-agent-notifications");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const scope = yield* Scope.Scope;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const entries = new Map<string, Entry>();
  let owner: Electron.BrowserWindow | undefined;
  let detachOwner: (() => void) | undefined;
  let stopped = false;

  const retire = (id: string, entry: Entry) => {
    if (entries.get(id) !== entry) return;
    entries.delete(id);
    entry.notification.removeAllListeners();
    try {
      entry.notification.close();
    } catch (cause) {
      runFork(logWarning("failed to close native notification", { cause }));
    }
  };

  const clear = () => {
    const detach = detachOwner;
    detachOwner = undefined;
    owner = undefined;
    detach?.();
    for (const [id, entry] of entries) retire(id, entry);
  };

  const bindOwner = (window: Electron.BrowserWindow) => {
    if (owner === window) return;
    clear();
    // BrowserWindow.webContents throws once its native window is destroyed.
    // Retain the emitter now so shutdown can detach listeners without that getter.
    const webContents = window.webContents;
    owner = window;
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) clear();
    };
    window.on("closed", clear);
    webContents.on("destroyed", clear);
    webContents.on("render-process-gone", clear);
    webContents.on("did-start-navigation", onNavigation);
    detachOwner = () => {
      window.removeListener("closed", clear);
      webContents.removeListener("destroyed", clear);
      webContents.removeListener("render-process-gone", clear);
      webContents.removeListener("did-start-navigation", onNavigation);
    };
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stopped = true;
      clear();
    }),
  );

  return DesktopAgentNotifications.of({
    show: (input, window) =>
      Effect.try({
        try: () => {
          if (
            stopped ||
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            !Electron.Notification.isSupported()
          )
            return false;
          bindOwner(window);
          const previous = entries.get(input.id);
          if (previous) retire(input.id, previous);
          if (entries.size >= MAX_NOTIFICATIONS) {
            const oldest = entries.entries().next().value;
            if (oldest) retire(oldest[0], oldest[1]);
          }
          const notification = new Electron.Notification({
            title: input.title,
            body: input.body,
            silent: input.silent,
          });
          const entry: Entry = { notification, clicking: false };
          entries.set(input.id, entry);
          notification.on("close", () => {
            if (!entry.clicking) retire(input.id, entry);
          });
          notification.on("failed", () => retire(input.id, entry));
          notification.on("click", () => {
            if (stopped || entries.get(input.id) !== entry || entry.clicking) return;
            entry.clicking = true;
            runFork(
              Effect.gen(function* () {
                const main = yield* electronWindow.main;
                if (Option.isNone(main) || main.value !== window) {
                  retire(input.id, entry);
                  return;
                }
                yield* electronWindow.reveal(window);
                if (
                  stopped ||
                  entries.get(input.id) !== entry ||
                  window.isDestroyed() ||
                  window.webContents.isDestroyed()
                )
                  return;
                retire(input.id, entry);
                window.webContents.send(AGENT_NOTIFICATION_CLICKED_CHANNEL, input.threadRef);
              }).pipe(
                Effect.catchCause((cause) =>
                  logWarning("failed to open notification target", { cause }),
                ),
                Effect.ensuring(Effect.sync(() => retire(input.id, entry))),
                Effect.forkIn(scope),
              ),
            );
          });
          try {
            notification.show();
          } catch (cause) {
            retire(input.id, entry);
            throw cause;
          }
          return true;
        },
        catch: (cause) => new DesktopAgentNotificationError({ cause }),
      }),
    dismiss: (id) =>
      Effect.sync(() => {
        const entry = entries.get(id);
        if (entry) retire(id, entry);
      }),
  });
});

export const layer = Layer.effect(DesktopAgentNotifications, make);
