import * as NodeEvents from "node:events";
import { assert, describe, it } from "@effect/vitest";
import { DesktopAgentNotification, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";

const electronMocks = vi.hoisted(() => ({
  notifications: [] as Electron.Notification[],
  supported: vi.fn(() => true),
}));

vi.mock("electron", async () => {
  // Mock factories run before static imports initialize their bindings.
  const { EventEmitter } = await import("node:events");
  return {
    Notification: class extends EventEmitter {
      static isSupported = electronMocks.supported;
      show = vi.fn();
      close = vi.fn(() => this.emit("close"));
      constructor(_options: Electron.NotificationConstructorOptions) {
        super();
        electronMocks.notifications.push(this as unknown as Electron.Notification);
      }
    },
  };
});

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAgentNotifications from "./DesktopAgentNotifications.ts";
import * as NotificationIpc from "../ipc/methods/agentNotifications.ts";
import { AGENT_NOTIFICATION_CLICKED_CHANNEL } from "../ipc/channels.ts";

const input = Schema.decodeSync(DesktopAgentNotification)({
  id: "attention:remote:thread",
  title: "Approval needed",
  body: "Agent needs your approval",
  threadRef: { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("thread") },
  silent: true,
});

interface WindowFixture {
  readonly window: Electron.BrowserWindow;
  readonly state: {
    minimized: boolean;
    visible: boolean;
    focused: boolean;
    destroyed: boolean;
  };
  readonly webContents: NodeEvents.EventEmitter & { readonly send: Mock };
}

function makeWindow() {
  const state = { minimized: true, visible: false, focused: false, destroyed: false };
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    id: 42,
    isDestroyed: () => state.destroyed,
    send: vi.fn(),
  });
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    id: 1,
    webContents,
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    restore: () => {
      state.minimized = false;
    },
    show: () => {
      state.visible = true;
    },
    focus: () => {
      state.focused = true;
    },
  });
  return { window: window as unknown as Electron.BrowserWindow, state, webContents };
}

const withHarness = <A, E>(
  run: (
    service: DesktopAgentNotifications.DesktopAgentNotifications["Service"],
    fixture: WindowFixture,
  ) => Effect.Effect<
    A,
    E,
    ElectronWindow.ElectronWindow | DesktopAgentNotifications.DesktopAgentNotifications
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = makeWindow();
      const windows = yield* ElectronWindow.make;
      yield* windows.setMain(fixture.window);
      const service = yield* DesktopAgentNotifications.make.pipe(
        Effect.provideService(ElectronWindow.ElectronWindow, windows),
      );
      return yield* run(service, fixture).pipe(
        Effect.provideService(ElectronWindow.ElectronWindow, windows),
        Effect.provideService(DesktopAgentNotifications.DesktopAgentNotifications, service),
      );
    }),
  ).pipe(Effect.provideService(HostProcessPlatform, "linux"));

beforeEach(() => {
  electronMocks.notifications.length = 0;
  electronMocks.supported.mockReturnValue(true);
});

describe("DesktopAgentNotifications", () => {
  it.effect("reveals the main window and emits an environment-qualified target once", () =>
    withHarness((service, { window, state, webContents }) =>
      Effect.gen(function* () {
        assert.isTrue(yield* NotificationIpc.show.handler(input, { sender: { id: 42 } }));
        const notification = electronMocks.notifications[0]!;
        const clicked = new Promise<void>((resolve) => {
          webContents.send.mockImplementationOnce(() => resolve());
        });
        notification.emit("click");
        notification.emit("close");
        yield* Effect.promise(() => clicked);
        assert.deepEqual(webContents.send.mock.calls, [
          [AGENT_NOTIFICATION_CLICKED_CHANNEL, input.threadRef],
        ]);
        assert.deepEqual(state, {
          minimized: false,
          visible: true,
          focused: true,
          destroyed: false,
        });
        notification.emit("click");
        assert.equal(webContents.send.mock.calls.length, 1);
        assert.deepEqual(notification.eventNames(), []);
        yield* service.dismiss(input.id);
        assert.isFalse(window.isDestroyed());
      }),
    ),
  );

  it.effect("replaces duplicate ids and ignores late close and click callbacks", () =>
    withHarness((service, { window, webContents }) =>
      Effect.gen(function* () {
        yield* service.show(input, window);
        const old = electronMocks.notifications[0]!;
        const lateClose = old.listeners("close")[0]!;
        const lateClick = old.listeners("click")[0]!;
        yield* service.show(
          {
            ...input,
            threadRef: { ...input.threadRef, environmentId: EnvironmentId.make("other") },
          },
          window,
        );
        const replacement = electronMocks.notifications[1]!;
        lateClose();
        lateClick();
        assert.equal(webContents.send.mock.calls.length, 0);
        assert.equal(vi.mocked(old.close).mock.calls.length, 1);
        yield* service.dismiss(input.id);
        assert.equal(vi.mocked(replacement.close).mock.calls.length, 1);
        replacement.emit("click");
        assert.equal(webContents.send.mock.calls.length, 0);
      }),
    ),
  );

  it.effect("bounds retained notifications and clears native resources on renderer teardown", () =>
    withHarness((service, { window, webContents }) =>
      Effect.gen(function* () {
        for (let index = 0; index < 33; index += 1) {
          yield* service.show({ ...input, id: `notice-${index}` }, window);
        }
        assert.equal(vi.mocked(electronMocks.notifications[0]!.close).mock.calls.length, 1);
        webContents.emit("destroyed");
        for (const notification of electronMocks.notifications) {
          assert.equal(vi.mocked(notification.close).mock.calls.length, 1);
          assert.deepEqual(notification.eventNames(), []);
          notification.emit("click");
        }
        assert.deepEqual(window.eventNames(), []);
        assert.deepEqual(webContents.eventNames(), []);
        assert.equal(webContents.send.mock.calls.length, 0);
      }),
    ),
  );

  it.effect("closes alerts and removes owner listeners when its scope shuts down", () =>
    Effect.gen(function* () {
      const fixture = yield* withHarness((service, fixture) =>
        Effect.gen(function* () {
          yield* service.show(input, fixture.window);
          return fixture;
        }),
      );
      const notification = electronMocks.notifications[0]!;
      assert.equal(vi.mocked(notification.close).mock.calls.length, 1);
      assert.deepEqual(notification.eventNames(), []);
      assert.deepEqual(fixture.window.eventNames(), []);
      assert.deepEqual(fixture.webContents.eventNames(), []);
      notification.emit("click");
      assert.equal(fixture.webContents.send.mock.calls.length, 0);
    }),
  );

  it.effect("rejects unscoped payloads and non-main senders before native delivery", () =>
    withHarness((_service, { webContents }) =>
      Effect.gen(function* () {
        const unscoped = yield* Effect.exit(
          NotificationIpc.show.handler(
            { ...input, threadRef: { threadId: "thread" } },
            { sender: { id: 42 } },
          ),
        );
        assert.equal(unscoped._tag, "Failure");
        if (unscoped._tag === "Failure") {
          assert.propertyVal(Cause.squash(unscoped.cause), "_tag", "SchemaError");
        }
        const foreign = yield* Effect.exit(
          NotificationIpc.show.handler(input, { sender: { id: 99 } }),
        );
        assert.equal(foreign._tag, "Failure");
        if (foreign._tag === "Failure") {
          assert.propertyVal(
            Cause.squash(foreign.cause),
            "_tag",
            "AgentNotificationUnauthorizedSenderError",
          );
        }
        assert.equal(electronMocks.notifications.length, 0);
        assert.equal(webContents.send.mock.calls.length, 0);
      }),
    ),
  );

  it.effect("returns false when native notifications are unsupported", () =>
    withHarness((service, { window }) =>
      Effect.gen(function* () {
        electronMocks.supported.mockReturnValue(false);
        assert.isFalse(yield* service.show(input, window));
        assert.equal(electronMocks.notifications.length, 0);
        assert.deepEqual(window.eventNames(), []);
      }),
    ),
  );
});
