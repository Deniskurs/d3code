// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

const boundary = vi.hoisted(() => ({
  draft: null as {
    environmentId: string;
    threadId: string;
    promotedTo?: { environmentId: string; threadId: string } | null;
  } | null,
  environmentIds: [] as string[],
  focused: true,
  navigate: vi.fn(),
  nativeDismiss: vi.fn(async (_id: string) => undefined),
  nativeShow: vi.fn(async (_input: { id: string }) => true),
  nativeClickListeners: new Set<(ref: { environmentId: string; threadId: string }) => void>(),
  readableThreads: new Set<string>(),
  routeParams: {} as Record<string, string | undefined>,
  settings: {
    agentNotificationsEnabled: true,
    agentNotificationDesktop: true,
    agentNotificationSound: false,
  },
  shellStates: new Map<string, unknown>(),
  subscribers: new Map<string, (state: unknown) => void>(),
  toastElements: new Map<string, HTMLButtonElement>(),
  toastSequence: 0,
  visible: true,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => boundary.navigate,
  useParams: (options: { select: (params: Record<string, string | undefined>) => unknown }) =>
    options.select(boundary.routeParams),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: { getDraftSession: () => unknown }) => unknown) =>
    select({ getDraftSession: () => boundary.draft }),
}));

vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => boundary.settings,
  useClientSettings: () => boundary.settings,
  useClientSettingsHydrated: () => true,
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    subscribe: (
      environmentId: string,
      listener: (state: unknown) => void,
      options: { immediate?: boolean },
    ) => {
      boundary.subscribers.set(environmentId, listener);
      if (options.immediate) listener(boundary.shellStates.get(environmentId));
      return () => boundary.subscribers.delete(environmentId);
    },
  },
}));

vi.mock("../state/entities", () => ({
  readThreadShell: (ref: { environmentId: string; threadId: string }) =>
    boundary.readableThreads.has(`${ref.environmentId}/${ref.threadId}`),
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: boundary.environmentIds.map((environmentId) => ({ environmentId })),
  }),
}));

vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: (environmentId: string) => environmentId },
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { actionProps?: { children?: string; onClick?: () => void } }) => {
      const id = `toast-${++boundary.toastSequence}`;
      const button = document.createElement("button");
      button.textContent = toast.actionProps?.children ?? "";
      if (toast.actionProps?.onClick) button.addEventListener("click", toast.actionProps.onClick);
      document.body.append(button);
      boundary.toastElements.set(id, button);
      return id;
    },
    close: (id: string) => {
      boundary.toastElements.get(id)?.remove();
      boundary.toastElements.delete(id);
    },
  },
}));

import { AgentNotificationCoordinator } from "./AgentNotificationCoordinator";

const projectId = ProjectId.make("project");
let timestamp = 0;
let root: Root | null = null;

const time = () => `2026-09-10T12:00:${String(++timestamp).padStart(2, "0")}.000Z`;

function thread(id: ThreadId): OrchestrationThreadShell {
  const updatedAt = time();
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function working(source: OrchestrationThreadShell): OrchestrationThreadShell {
  const updatedAt = time();
  return {
    ...source,
    latestUserMessageAt: updatedAt,
    updatedAt,
    session: {
      threadId: source.id,
      providerName: source.modelSelection.instanceId,
      status: "running",
      runtimeMode: "full-access",
      activeTurnId: TurnId.make(`turn-${timestamp}`),
      lastError: null,
      updatedAt,
    },
  };
}

function completed(source: OrchestrationThreadShell): OrchestrationThreadShell {
  const updatedAt = time();
  return {
    ...source,
    updatedAt,
    session: {
      threadId: source.id,
      providerName: source.modelSelection.instanceId,
      status: "ready",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt,
    },
  };
}

function snapshot(...threads: OrchestrationThreadShell[]): OrchestrationShellSnapshot {
  return {
    snapshotSequence: timestamp,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: time(),
        updatedAt: time(),
      },
    ],
    threads,
    updatedAt: time(),
  };
}

function liveState(...threads: OrchestrationThreadShell[]) {
  return { snapshot: Option.some(snapshot(...threads)), status: "live" };
}

async function mountCoordinator(input: {
  environmentIds: EnvironmentId[];
  routeParams: Record<string, string | undefined>;
  baselines: ReadonlyMap<EnvironmentId, OrchestrationThreadShell[]>;
  draft?: typeof boundary.draft;
}) {
  boundary.environmentIds = input.environmentIds;
  boundary.routeParams = input.routeParams;
  boundary.draft = input.draft ?? null;
  for (const [environmentId, threads] of input.baselines) {
    boundary.shellStates.set(environmentId, liveState(...threads));
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<AgentNotificationCoordinator />));
}

async function emit(environmentId: EnvironmentId, ...threads: OrchestrationThreadShell[]) {
  const state = liveState(...threads);
  boundary.shellStates.set(environmentId, state);
  await act(async () => {
    boundary.subscribers.get(environmentId)?.(state);
    await Promise.resolve();
  });
}

function ref(environmentId: EnvironmentId, threadId: ThreadId): ScopedThreadRef {
  return { environmentId, threadId };
}

beforeEach(() => {
  boundary.draft = null;
  boundary.environmentIds = [];
  boundary.focused = true;
  boundary.navigate.mockReset();
  boundary.nativeDismiss.mockReset();
  boundary.nativeShow.mockReset().mockResolvedValue(true);
  boundary.nativeClickListeners.clear();
  boundary.readableThreads.clear();
  boundary.routeParams = {};
  boundary.settings.agentNotificationsEnabled = true;
  boundary.settings.agentNotificationDesktop = true;
  boundary.settings.agentNotificationSound = false;
  boundary.shellStates.clear();
  boundary.subscribers.clear();
  boundary.toastElements.clear();
  boundary.toastSequence = 0;
  boundary.visible = true;
  localStorage.clear();
  document.body.replaceChildren();
  vi.spyOn(document, "hasFocus").mockImplementation(() => boundary.focused);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (boundary.visible ? "visible" : "hidden"),
  });
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      notifications: {
        show: boundary.nativeShow,
        dismiss: boundary.nativeDismiss,
        onClicked: (listener: (ref: { environmentId: string; threadId: string }) => void) => {
          boundary.nativeClickListeners.add(listener);
          return () => boundary.nativeClickListeners.delete(listener);
        },
      },
    },
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  vi.restoreAllMocks();
});

describe("AgentNotificationCoordinator", () => {
  it.each([false, true])(
    "keeps the selected %s draft conversation quiet while promotion catches up",
    async (promoted) => {
      const environmentId = EnvironmentId.make("local");
      const threadId = ThreadId.make(`reserved-${promoted}`);
      const run = working(thread(threadId));
      await mountCoordinator({
        environmentIds: [environmentId],
        routeParams: { draftId: "draft" },
        baselines: new Map([[environmentId, [run]]]),
        draft: {
          environmentId,
          threadId,
          promotedTo: promoted ? ref(environmentId, threadId) : null,
        },
      });

      expect(boundary.nativeShow).not.toHaveBeenCalled();
      await emit(environmentId, completed(run));

      expect(boundary.nativeShow).not.toHaveBeenCalled();
      expect(document.querySelector("button")).toBeNull();
    },
  );

  it("delivers a selected background alert without a toast or redundant native-click navigation", async () => {
    const environmentId = EnvironmentId.make("local");
    const threadId = ThreadId.make("selected");
    const run = working(thread(threadId));
    boundary.focused = false;
    await mountCoordinator({
      environmentIds: [environmentId],
      routeParams: { environmentId, threadId },
      baselines: new Map([[environmentId, [run]]]),
    });

    await emit(environmentId, completed(run));
    await vi.waitFor(() => expect(boundary.nativeShow).toHaveBeenCalledOnce());
    expect(document.querySelector("button")).toBeNull();

    for (const listener of boundary.nativeClickListeners) listener(ref(environmentId, threadId));
    expect(boundary.nativeDismiss).toHaveBeenCalledWith(boundary.nativeShow.mock.calls[0]?.[0].id);
    expect(boundary.navigate).not.toHaveBeenCalled();
  });

  it("keeps equal thread IDs in other environments actionable and opens the scoped route", async () => {
    const selectedEnvironmentId = EnvironmentId.make("local");
    const notifyingEnvironmentId = EnvironmentId.make("remote");
    const threadId = ThreadId.make("same-thread");
    const run = working(thread(threadId));
    boundary.readableThreads.add(`${notifyingEnvironmentId}/${threadId}`);
    await mountCoordinator({
      environmentIds: [notifyingEnvironmentId],
      routeParams: { environmentId: selectedEnvironmentId, threadId },
      baselines: new Map([[notifyingEnvironmentId, [run]]]),
    });

    await emit(notifyingEnvironmentId, completed(run));
    const openButton = document.querySelector("button");
    expect(openButton?.textContent).toBe("Open thread");
    openButton?.click();

    expect(boundary.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: notifyingEnvironmentId, threadId },
    });
    expect(document.querySelector("button")).toBeNull();
  });

  it.each(["focus", "visibilitychange"] as const)(
    "reconciles a selected background alert on %s",
    async (eventName) => {
      const environmentId = EnvironmentId.make(`env-${eventName}`);
      const threadId = ThreadId.make(`thread-${eventName}`);
      const run = working(thread(threadId));
      boundary.focused = eventName !== "focus";
      boundary.visible = eventName !== "visibilitychange";
      await mountCoordinator({
        environmentIds: [environmentId],
        routeParams: { environmentId, threadId },
        baselines: new Map([[environmentId, [run]]]),
      });
      await emit(environmentId, completed(run));
      await vi.waitFor(() => expect(boundary.nativeShow).toHaveBeenCalledOnce());

      boundary.focused = true;
      boundary.visible = true;
      if (eventName === "focus") window.dispatchEvent(new Event(eventName));
      else document.dispatchEvent(new Event(eventName));

      expect(boundary.nativeDismiss).toHaveBeenCalledWith(
        boundary.nativeShow.mock.calls[0]?.[0].id,
      );
    },
  );

  it("removes shell and native-click observers on unmount", async () => {
    const environmentId = EnvironmentId.make("cleanup");
    const threadId = ThreadId.make("cleanup-thread");
    const run = working(thread(threadId));
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    await mountCoordinator({
      environmentIds: [environmentId],
      routeParams: { environmentId, threadId },
      baselines: new Map([[environmentId, [run]]]),
    });
    expect(boundary.subscribers.size).toBe(1);
    expect(boundary.nativeClickListeners.size).toBe(1);

    await act(async () => root!.unmount());
    root = null;
    expect(boundary.subscribers.size).toBe(0);
    expect(boundary.nativeClickListeners.size).toBe(0);
    expect(removeWindowListener).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    await emit(environmentId, completed(run));
    expect(boundary.nativeShow).not.toHaveBeenCalled();
    expect(boundary.navigate).not.toHaveBeenCalled();
  });
});
