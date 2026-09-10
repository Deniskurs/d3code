import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
  let viewing = false;
  const delivery = createAgentNotificationDelivery({
    settings: () => settings,
    isViewing: () => viewing,
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
    view: () => {
      viewing = true;
      delivery.reconcile();
    },
  };
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
    h.view();
    await h.delivery.notify(notification());
    expect(h.visible.size).toBe(0);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("hands a repeated event to the OS only once across client consumers", async () => {
    const show = vi.fn(async () => true);
    vi.stubGlobal("window", {
      desktopBridge: { notifications: { show, dismiss: vi.fn(async () => undefined) } },
    });
    const firstTab = harness();
    const secondTab = harness();
    const event = notification();
    await Promise.all([firstTab.delivery.notify(event), secondTab.delivery.notify(event)]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(firstTab.visible.has(event.id)).toBe(true);
    expect(secondTab.visible.has(event.id)).toBe(true);
    firstTab.delivery.clear();
    secondTab.delivery.clear();
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

  it("opens the scoped thread from a browser notification and disables retired clicks", async () => {
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
    const first = notification();
    await h.delivery.notify(first);
    emitted[0]!.dispatchEvent(new Event("click"));
    expect(h.opened).toEqual(["remote/thread"]);
    expect(focus).toHaveBeenCalledOnce();
    expect(closed).toEqual([`${first.headline}: ${first.threadTitle}`]);
    emitted[0]!.dispatchEvent(new Event("click"));
    expect(h.opened).toEqual(["remote/thread"]);
    expect(h.visible.size).toBe(0);
  });

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
