import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { AgentNotification } from "@t3tools/shared/agentAwareness";
import {
  createAgentNotificationDelivery,
  getAgentNotificationPermission,
  requestAgentNotificationPermission,
} from "./agentNotifications";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function heldNotificationLocks() {
  const gate = deferred<void>();
  let tail: Promise<void> = Promise.resolve();
  const names: string[] = [];
  const request = vi.fn((name: string, callback: () => boolean | Promise<boolean>) => {
    names.push(name);
    if (name !== "d3:agent-notifications:delivered") {
      return Promise.resolve().then(callback);
    }
    const result = tail.then(() => gate.promise).then(callback);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
  return { names, release: gate.resolve, request };
}

let sequence = 0;
function notification(overrides: Partial<AgentNotification> = {}): AgentNotification {
  return {
    id: `event-${++sequence}`,
    environmentId: EnvironmentId.make("remote"),
    threadId: ThreadId.make("thread"),
    projectTitle: "Project",
    threadTitle: "Task",
    phase: "completed",
    headline: "Agent finished",
    modelTitle: "model",
    updatedAt: "2026-09-10T12:00:00.000Z",
    deepLink: "/threads/remote/thread",
    ...overrides,
  };
}

function harness() {
  const settings = {
    agentNotificationsEnabled: true,
    agentNotificationSound: false,
    agentNotificationDesktop: true,
  };
  const opened: string[] = [];
  const visible = new Map<string, () => void>();
  let selected: ScopedThreadRef | null = null;
  let focused = true;
  const delivery = createAgentNotificationDelivery({
    settings: () => settings,
    isSelected: (ref) =>
      selected?.environmentId === ref.environmentId && selected.threadId === ref.threadId,
    isAppFocused: () => focused,
    onOpen: (ref) => opened.push(`${ref.environmentId}/${ref.threadId}`),
    showToast: (event, onOpen) => {
      visible.set(event.id, onOpen);
      return () => {
        visible.delete(event.id);
      };
    },
  });
  return {
    delivery,
    settings,
    opened,
    visible,
    select: (ref: ScopedThreadRef | null) => {
      selected = ref;
      delivery.reconcile();
    },
    focus: (value: boolean) => {
      focused = value;
      delivery.reconcile();
    },
  };
}

async function realmHarness(selected: ScopedThreadRef) {
  // Resetting between imports is intentional: each module instance models a renderer realm.
  vi.resetModules();
  const module = await import("./agentNotifications");
  const showToast = vi.fn(() => vi.fn());
  const delivery = module.createAgentNotificationDelivery({
    settings: () => ({
      agentNotificationsEnabled: true,
      agentNotificationSound: false,
      agentNotificationDesktop: true,
    }),
    isSelected: (ref) =>
      selected.environmentId === ref.environmentId && selected.threadId === ref.threadId,
    isAppFocused: () => false,
    onOpen: vi.fn(),
    showToast,
  });
  return { delivery, showToast };
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", {});
  vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("agent notification delivery", () => {
  it("keeps a selected background thread's native alert without an Open thread toast", async () => {
    const show = vi.fn(async () => true);
    const dismiss = vi.fn(async () => undefined);
    vi.stubGlobal("window", { desktopBridge: { notifications: { show, dismiss } } });
    const h = harness();
    const event = notification();
    h.focus(false);
    h.select(event);
    await h.delivery.notify(event);
    expect(h.visible.size).toBe(0);
    expect(show).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
    h.delivery.open(event);
    expect(h.opened).toEqual([]);
    expect(dismiss).toHaveBeenCalledWith(event.id);
  });

  it("does not alert for the selected foreground thread", async () => {
    const show = vi.fn(async () => true);
    vi.stubGlobal("window", {
      desktopBridge: { notifications: { show, dismiss: vi.fn(async () => undefined) } },
    });
    const h = harness();
    const event = notification();
    h.select(event);
    await h.delivery.notify(event);
    expect(h.visible.size).toBe(0);
    expect(show).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retires the toast on selection during native handoff with app focus %s",
    async (focused) => {
      const started = deferred<void>();
      const acknowledgement = deferred<boolean>();
      const dismiss = vi.fn(async () => undefined);
      vi.stubGlobal("window", {
        desktopBridge: {
          notifications: {
            show: () => {
              started.resolve();
              return acknowledgement.promise;
            },
            dismiss,
          },
        },
      });
      const h = harness();
      const event = notification();
      h.focus(focused);
      const pending = h.delivery.notify(event);
      await started.promise;
      expect(h.visible.has(event.id)).toBe(true);
      h.select(event);
      expect(h.visible.size).toBe(0);
      // Leaving again must not resurrect a toast or an already-retired native alert.
      h.select({ environmentId: event.environmentId, threadId: ThreadId.make("other") });
      acknowledgement.resolve(true);
      await pending;
      expect(h.visible.size).toBe(0);
      if (focused) {
        expect(dismiss).toHaveBeenCalledWith(event.id);
        h.delivery.open(event);
        expect(h.opened).toEqual([]);
      } else {
        expect(dismiss).not.toHaveBeenCalled();
        h.delivery.open(event);
        expect(h.opened).toEqual(["remote/thread"]);
      }
    },
  );

  it("withdraws only the toast on background selection, then the native alert on focus", async () => {
    const dismiss = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktopBridge: { notifications: { show: vi.fn(async () => true), dismiss } },
    });
    const h = harness();
    const event = notification();
    await h.delivery.notify(event);
    h.focus(false);
    h.select(event);
    expect(h.visible.size).toBe(0);
    expect(dismiss).not.toHaveBeenCalled();
    h.focus(true);
    expect(dismiss).toHaveBeenCalledWith(event.id);
    h.delivery.open(event);
    expect(h.opened).toEqual([]);
  });

  it("keeps the Open thread action for the same thread ID in another environment", async () => {
    const h = harness();
    const event = notification();
    h.select({ environmentId: EnvironmentId.make("local"), threadId: event.threadId });
    await h.delivery.notify(event);
    h.delivery.reconcile();
    expect(h.visible.has(event.id)).toBe(true);
    h.visible.get(event.id)!();
    expect(h.opened).toEqual(["remote/thread"]);
    expect(h.visible.size).toBe(0);
  });

  it("keeps all background-thread alerts usable when browser permission is denied", async () => {
    const h = harness();
    const first = notification();
    const second = notification({ threadId: ThreadId.make("omp") });
    await h.delivery.notify(first);
    await h.delivery.notify(second);
    expect([...h.visible.keys()]).toEqual([first.id, second.id]);
    h.visible.get(second.id)!();
    expect(h.opened).toEqual(["remote/omp"]);
    expect([...h.visible.keys()]).toEqual([first.id]);
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    h.delivery.clear();
  });

  it("retires a pending native alert instead of resurrecting it after work resumes", async () => {
    const started = deferred<void>();
    const acknowledgement = deferred<boolean>();
    const dismiss = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        notifications: {
          show: () => {
            started.resolve();
            return acknowledgement.promise;
          },
          dismiss,
        },
      },
    });
    const h = harness();
    const event = notification();
    const pending = h.delivery.notify(event);
    await started.promise;
    h.delivery.dismiss(event);
    acknowledgement.resolve(true);
    await pending;
    expect(h.visible.size).toBe(0);
    expect(dismiss).toHaveBeenCalledWith(event.id);
    h.delivery.open(event);
    expect(h.opened).toEqual([]);
  });

  it("silences the viewed thread and withdraws alerts when disabled", async () => {
    const show = vi.fn(async () => true);
    const dismiss = vi.fn(async () => undefined);
    vi.stubGlobal("window", { desktopBridge: { notifications: { show, dismiss } } });
    const h = harness();
    const event = notification();
    await h.delivery.notify(event);
    h.settings.agentNotificationDesktop = false;
    h.delivery.reconcile();
    expect(dismiss).toHaveBeenCalledWith(event.id);
    expect([...h.visible.keys()]).toEqual([event.id]);
    h.settings.agentNotificationsEnabled = false;
    h.delivery.reconcile();
    expect(h.visible.size).toBe(0);
    h.settings.agentNotificationsEnabled = true;
    h.select(event);
    await h.delivery.notify(notification());
    expect(h.visible.size).toBe(0);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("serializes system delivery under the shared Web Lock across module realms", async () => {
    const locks = heldNotificationLocks();
    vi.stubGlobal("navigator", { locks: { request: locks.request } });
    const show = vi.fn(async () => true);
    vi.stubGlobal("window", {
      desktopBridge: { notifications: { show, dismiss: vi.fn(async () => undefined) } },
    });
    const event = notification();
    const firstTab = await realmHarness(event);
    const secondTab = await realmHarness(event);

    const pending = [firstTab.delivery.notify(event), secondTab.delivery.notify(event)];
    await Promise.resolve();
    expect(locks.names).toEqual([
      "d3:agent-notifications:delivered",
      "d3:agent-notifications:delivered",
    ]);
    expect(show).not.toHaveBeenCalled();
    expect(firstTab.showToast).not.toHaveBeenCalled();
    expect(secondTab.showToast).not.toHaveBeenCalled();

    locks.release();
    await Promise.all(pending);
    expect(show).toHaveBeenCalledOnce();
    firstTab.delivery.clear();
    secondTab.delivery.clear();
  });

  it("keeps the in-app action when the Web Locks request is rejected", async () => {
    vi.stubGlobal("navigator", {
      locks: { request: vi.fn(() => Promise.reject(new Error("Lock manager unavailable"))) },
    });
    const show = vi.fn(async () => true);
    vi.stubGlobal("window", {
      desktopBridge: { notifications: { show, dismiss: vi.fn(async () => undefined) } },
    });
    const h = harness();
    const event = notification();

    await h.delivery.notify(event);

    expect(show).not.toHaveBeenCalled();
    expect(h.visible.has(event.id)).toBe(true);
    h.delivery.clear();
  });

  it("keeps newer alerts when an earlier native handoff finishes late", async () => {
    const firstStarted = deferred<void>();
    const firstAck = deferred<boolean>();
    const old = notification();
    const current = notification({ phase: "waiting_for_input" });
    const dismiss = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        notifications: {
          show: (input: { id: string }) => {
            if (input.id === old.id) {
              firstStarted.resolve();
              return firstAck.promise;
            }
            return Promise.resolve(true);
          },
          dismiss,
        },
      },
    });
    const h = harness();
    const pending = h.delivery.notify(old);
    await firstStarted.promise;
    await h.delivery.notify(current);
    firstAck.resolve(true);
    await pending;
    expect([...h.visible.keys()]).toEqual([current.id]);
    expect(dismiss).toHaveBeenCalledWith(old.id);
    expect(dismiss).not.toHaveBeenCalledWith(current.id);
    h.visible.get(current.id)!();
    expect(h.opened).toEqual(["remote/thread"]);
  });

  it.each([false, true])(
    "refocuses browser notifications without redundant navigation when selected is %s",
    async (selected) => {
      const emitted: EventTarget[] = [];
      const closed: string[] = [];
      class BrowserNotification extends EventTarget {
        static permission = "granted";
        constructor(title: string) {
          super();
          emitted.push(this);
          this.addEventListener("close", () => closed.push(title));
        }
        close() {
          this.dispatchEvent(new Event("close"));
        }
      }
      const focus = vi.fn();
      vi.stubGlobal("window", { focus });
      vi.stubGlobal("Notification", BrowserNotification);
      const h = harness();
      const event = notification();
      h.focus(false);
      if (selected) h.select(event);
      await h.delivery.notify(event);
      expect(h.visible.has(event.id)).toBe(!selected);
      emitted[0]!.dispatchEvent(new Event("click"));
      expect(h.opened).toEqual(selected ? [] : ["remote/thread"]);
      expect(focus).toHaveBeenCalledOnce();
      expect(closed).toEqual([`${event.headline}: ${event.threadTitle}`]);
      emitted[0]!.dispatchEvent(new Event("click"));
      expect(h.opened).toEqual(selected ? [] : ["remote/thread"]);
      expect(focus).toHaveBeenCalledOnce();
      expect(h.visible.size).toBe(0);
    },
  );

  it("requests browser permission only on explicit request and tolerates unsupported browsers", async () => {
    const requestPermission = vi.fn(async () => "granted" as const);
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    expect(getAgentNotificationPermission()).toBe("default");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(await requestAgentNotificationPermission()).toBe("granted");
    vi.stubGlobal("Notification", undefined);
    expect(await requestAgentNotificationPermission()).toBe("unsupported");
    const h = harness();
    const event = notification();
    await h.delivery.notify(event);
    expect([...h.visible.keys()]).toEqual([event.id]);
    h.delivery.clear();
  });
});
