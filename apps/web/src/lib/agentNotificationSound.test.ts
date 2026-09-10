import * as NodeTimersPromises from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type DesktopAgentNotification,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AgentNotification } from "@t3tools/shared/agentAwareness";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let serial = 0;
let insideGesture = false;
const cleanups: Array<() => void> = [];
function notification(): AgentNotification {
  return {
    id: `sound-${++serial}`,
    environmentId: EnvironmentId.make("remote"),
    threadId: ThreadId.make(`thread-${serial}`),
    phase: "completed",
    projectTitle: "Project",
    threadTitle: "Task",
    headline: "Agent finished",
    modelTitle: "model",
    updatedAt: "2026-09-10T12:00:00.000Z",
    deepLink: "/threads/remote/thread",
  };
}

function audioDevice() {
  const nodes: Array<EventTarget & { started: boolean; audible: boolean }> = [];
  const contexts: AudioContextFixture[] = [];
  const resumeResults: Array<() => Promise<void>> = [];
  const started = deferred<void>();
  class AudioContextFixture {
    state = "suspended";
    unlocked = false;
    currentTime = 0;
    destination = {};
    constructor() {
      contexts.push(this);
    }
    async resume() {
      if (!this.unlocked && !insideGesture && !window.desktopBridge) {
        throw new Error("A user gesture is required");
      }
      await (resumeResults.shift()?.() ?? Promise.resolve());
      this.state = "running";
      this.unlocked = true;
    }
    async suspend() {
      this.state = "suspended";
    }
    async close() {
      this.state = "closed";
    }
    createOscillator() {
      const node = Object.assign(new EventTarget(), {
        started: false,
        audible: false,
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: () => {
          node.started = true;
          node.audible = this.state === "running";
          started.resolve();
        },
        stop: vi.fn(),
      });
      nodes.push(node);
      return node;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }
  }
  vi.stubGlobal("AudioContext", AudioContextFixture);
  return { nodes, contexts, resumeResults, started };
}

async function client(options: { system?: boolean; native?: boolean; activate?: boolean } = {}) {
  // Separate module instances represent separate renderer realms, sharing only storage.
  vi.resetModules();
  const module = await import("./agentNotifications");
  const windowTarget = new (class extends EventTarget {
    override dispatchEvent(event: Event) {
      insideGesture = true;
      try {
        return super.dispatchEvent(event);
      } finally {
        insideGesture = false;
      }
    }
  })();
  const show = vi.fn(async (_input: DesktopAgentNotification) => true);
  Object.assign(
    windowTarget,
    options.native
      ? { desktopBridge: { notifications: { show, dismiss: vi.fn(async () => undefined) } } }
      : {},
  );
  vi.stubGlobal("window", windowTarget);
  cleanups.push(module.installAgentNotificationAudio());
  const settings = {
    agentNotificationsEnabled: true,
    agentNotificationSound: true,
    agentNotificationDesktop: options.system ?? false,
  };
  let selected: ScopedThreadRef | null = null;
  let focused = true;
  const delivery = module.createAgentNotificationDelivery({
    settings: () => settings,
    isSelected: (ref) =>
      selected?.environmentId === ref.environmentId && selected.threadId === ref.threadId,
    isAppFocused: () => focused,
    onOpen: vi.fn(),
    showToast: () => vi.fn(),
  });
  cleanups.push(delivery.clear);
  if (options.activate !== false) {
    windowTarget.dispatchEvent(new Event("pointerdown"));
    // Let the trusted-gesture activation finish before issuing an alert.
    await NodeTimersPromises.setImmediate();
  }
  return {
    delivery,
    settings,
    windowTarget,
    show,
    select: (ref: ScopedThreadRef) => {
      selected = ref;
      delivery.reconcile();
    },
    focus: (value: boolean) => {
      focused = value;
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
  vi.stubGlobal("Notification", { permission: "denied" });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("notification sound reliability", () => {
  it("sounds a selected background thread but leaves the foreground thread silent", async () => {
    const audio = audioDevice();
    const h = await client({ native: true, system: true });
    const foreground = notification();
    h.select(foreground);
    await h.delivery.notify(foreground);
    expect(audio.nodes).toHaveLength(0);
    expect(h.show).not.toHaveBeenCalled();
    const background = notification();
    h.focus(false);
    h.select(background);
    await h.delivery.notify(background);
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
    expect(h.show).toHaveBeenCalledOnce();
  });

  it("cancels a selected thread's pending sound when the app gains focus", async () => {
    const audio = audioDevice();
    const h = await client();
    const resumed = deferred<void>();
    const requested = deferred<void>();
    audio.resumeResults.push(() => {
      requested.resolve();
      return resumed.promise;
    });
    const event = notification();
    h.focus(false);
    h.select(event);
    const pending = h.delivery.notify(event);
    await requested.promise;
    h.focus(true);
    resumed.resolve();
    await pending;
    expect(audio.nodes).toHaveLength(0);
  });

  it("plays the app sound even when native notification handoff succeeds", async () => {
    const audio = audioDevice();
    const h = await client({ native: true, system: true });
    await h.delivery.notify(notification());
    expect(h.show).toHaveBeenCalledOnce();
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
    expect(h.show.mock.calls[0]?.[0]).toMatchObject({ silent: true });
  });

  it("lets an audio-ready tab sound an event first observed by an unactivated tab", async () => {
    const audio = audioDevice();
    const unactivated = await client({ activate: false });
    const ready = await client();
    const event = notification();
    await unactivated.delivery.notify(event);
    await ready.delivery.notify(event);
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
  });

  it("retries audio activation on a later gesture after the first attempt is rejected", async () => {
    const audio = audioDevice();
    audio.resumeResults.push(() => Promise.reject(new Error("Audio activation rejected")));
    const h = await client();
    expect(audio.contexts[0]?.state).toBe("suspended");
    h.windowTarget.dispatchEvent(new Event("keydown"));
    await NodeTimersPromises.setImmediate();
    await h.delivery.notify(notification());
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
  });

  it("can sound a desktop alert before the first interaction", async () => {
    const audio = audioDevice();
    const h = await client({ native: true, system: true, activate: false });
    await h.delivery.notify(notification());
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
  });

  it("does not wait for native IPC acknowledgement before playing", async () => {
    const audio = audioDevice();
    const h = await client({ native: true, system: true });
    const acknowledgement = deferred<boolean>();
    h.show.mockImplementationOnce(() => acknowledgement.promise);
    const pending = h.delivery.notify(notification());
    await audio.started.promise;
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
    acknowledgement.resolve(true);
    await pending;
  }, 1_000);

  it("does not permanently silence later alerts after a transient resume failure", async () => {
    const audio = audioDevice();
    const h = await client();
    audio.resumeResults.push(() => Promise.reject(new Error("Audio device interrupted")));
    await h.delivery.notify(notification());
    expect(audio.nodes).toHaveLength(0);
    await h.delivery.notify(notification());
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
  });

  it("plays once when two audio-ready tabs observe the same transition", async () => {
    const audio = audioDevice();
    const first = await client();
    const second = await client();
    const event = notification();
    await Promise.all([first.delivery.notify(event), second.delivery.notify(event)]);
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
  });

  it("keeps audio running when an alert arrives during activation", async () => {
    const audio = audioDevice();
    const activation = deferred<void>();
    audio.resumeResults.push(() => activation.promise);
    const h = await client({ activate: false });
    h.windowTarget.dispatchEvent(new Event("pointerdown"));
    const pending = h.delivery.notify(notification());
    activation.resolve();
    await pending;
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
    expect(audio.contexts[0]?.state).toBe("running");
    audio.nodes[0]!.dispatchEvent(new Event("ended"));
    await NodeTimersPromises.setImmediate();
    expect(audio.contexts[0]?.state).toBe("suspended");
  });

  it("does not play a stale or muted alert after delayed audio resume", async () => {
    const audio = audioDevice();
    const h = await client();
    const resumed = deferred<void>();
    const requested = deferred<void>();
    audio.resumeResults.push(() => {
      requested.resolve();
      return resumed.promise;
    });
    const event = notification();
    const pending = h.delivery.notify(event);
    await requested.promise;
    h.settings.agentNotificationSound = false;
    h.delivery.dismiss(event);
    resumed.resolve();
    await pending;
    expect(audio.nodes).toHaveLength(0);
  });

  it("respects muting and coalesces only nearby sounds", async () => {
    const audio = audioDevice();
    const h = await client();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    h.settings.agentNotificationSound = false;
    await h.delivery.notify(notification());
    expect(audio.nodes).toHaveLength(0);
    h.settings.agentNotificationSound = true;
    await h.delivery.notify(notification());
    audio.nodes[0]!.dispatchEvent(new Event("ended"));
    clock.mockReturnValue(1_250);
    await h.delivery.notify(notification());
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
    clock.mockReturnValue(2_000);
    await h.delivery.notify(notification());
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(2);
  });

  it("does not replay a coalesced sound when another tab observes it later", async () => {
    const audio = audioDevice();
    const first = await client();
    const second = await client();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await first.delivery.notify(notification());
    audio.nodes[0]!.dispatchEvent(new Event("ended"));
    clock.mockReturnValue(1_250);
    const coalesced = notification();
    await first.delivery.notify(coalesced);
    clock.mockReturnValue(2_000);
    await second.delivery.notify(coalesced);
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(1);
    // Coalescing consumes this event, not the next distinct notification.
    await second.delivery.notify(notification());
    expect(audio.nodes.filter((node) => node.audible)).toHaveLength(2);
  });
});
