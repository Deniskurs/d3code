import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";

import { createAgentNotificationTracker, projectThreadAwareness } from "./agentAwareness.ts";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const time = (second: number) => `2026-09-10T12:00:${String(second).padStart(2, "0")}.000Z`;

function thread(
  id: string,
  provider = "codex",
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make(provider), model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: time(0),
    updatedAt: time(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function snapshot(...threads: OrchestrationThreadShell[]): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: time(0),
        updatedAt: time(0),
      },
    ],
    threads,
    updatedAt: time(0),
  };
}

function working(source: OrchestrationThreadShell, second = 1): OrchestrationThreadShell {
  return {
    ...source,
    latestUserMessageAt: time(second),
    updatedAt: time(second),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    session: {
      threadId: source.id,
      providerName: source.modelSelection.instanceId,
      status: "running",
      runtimeMode: "full-access",
      activeTurnId: TurnId.make(`turn-${second}`),
      lastError: null,
      updatedAt: time(second),
    },
  };
}

function finished(source: OrchestrationThreadShell, second = 2): OrchestrationThreadShell {
  return {
    ...source,
    updatedAt: time(second),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: {
      threadId: source.id,
      providerName: source.modelSelection.instanceId,
      status: "ready",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: time(second),
    },
  };
}

describe("agent notification transitions", () => {
  it("baselines cached state and reconnects without replaying old alerts", () => {
    const tracker = createAgentNotificationTracker(environmentId);
    const run = working(thread("codex"));
    const done = finished(run);
    expect(tracker.update(snapshot(done), false).notifications).toEqual([]);
    expect(tracker.update(snapshot(run), true).notifications).toEqual([]);
    expect(tracker.update(snapshot(done), true).notifications.map((item) => item.phase)).toEqual([
      "completed",
    ]);
    expect(tracker.update(snapshot(done), false).dismiss).toEqual([done.id]);
    expect(tracker.update(snapshot(done), true).notifications).toEqual([]);
    expect(
      tracker.update(snapshot({ ...done, title: "Renamed", updatedAt: time(3) }), true)
        .notifications,
    ).toEqual([]);
  });

  it("observes every thread/provider and keeps equal thread ids in separate environments", () => {
    const tracker = createAgentNotificationTracker(environmentId);
    const remote = createAgentNotificationTracker(EnvironmentId.make("remote"));
    const runs = [
      working(thread("one", "codex")),
      working(thread("two", "omp")),
      working(thread("three", "custom-provider")),
    ];
    tracker.update(snapshot(...runs), true);
    remote.update(snapshot(runs[0]!), true);
    const done = runs.map((run) => finished(run));
    const alerts = tracker.update(snapshot(...done), true).notifications;
    expect(alerts.map((item) => [item.threadId, item.phase])).toEqual([
      ["one", "completed"],
      ["two", "completed"],
      ["three", "completed"],
    ]);
    const remoteAlert = remote.update(snapshot(done[0]!), true).notifications[0]!;
    expect(remoteAlert.environmentId).toBe("remote");
    expect(remoteAlert.id).not.toBe(alerts[0]!.id);
  });

  it("does not call idle session acquisition or an interrupted turn a completion", () => {
    const tracker = createAgentNotificationTracker(environmentId);
    const idle = thread("idle");
    tracker.update(snapshot(idle), true);
    expect(tracker.update(snapshot(finished(idle)), true).notifications).toEqual([]);
    const run = working(idle);
    tracker.update(snapshot(run), true);
    expect(
      tracker.update(
        snapshot({
          ...run,
          session: null,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "interrupted",
            requestedAt: time(1),
            startedAt: time(1),
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        true,
      ).notifications,
    ).toEqual([]);
  });

  it("alerts once per attention edge and retires resolved or deleted threads", () => {
    const tracker = createAgentNotificationTracker(environmentId);
    const run = working(thread("omp", "omp"));
    tracker.update(snapshot(run), true);
    const approval = { ...run, hasPendingApprovals: true, updatedAt: time(2) };
    expect(
      tracker.update(snapshot(approval), true).notifications.map((item) => item.phase),
    ).toEqual(["waiting_for_approval"]);
    expect(
      tracker.update(snapshot({ ...approval, updatedAt: time(3) }), true).notifications,
    ).toEqual([]);
    const input = { ...run, hasPendingUserInput: true, updatedAt: time(4) };
    const waiting = tracker.update(snapshot(input), true);
    expect(waiting.dismiss).toEqual([run.id]);
    expect(waiting.notifications.map((item) => item.phase)).toEqual(["waiting_for_input"]);
    tracker.update(snapshot({ ...run, updatedAt: time(5) }), true);
    expect(
      tracker
        .update(snapshot({ ...approval, updatedAt: time(6) }), true)
        .notifications.map((item) => item.phase),
    ).toEqual(["waiting_for_approval"]);
    expect(tracker.update(snapshot(), true).dismiss).toEqual([run.id]);
  });

  it("defers completion while native background work is running and surfaces plans", () => {
    const tracker = createAgentNotificationTracker(environmentId);
    const run = working(thread("omp", "omp"));
    tracker.update(snapshot(run), true);
    const background = { ...finished(run), backgroundLiveness: "working" as const };
    expect(
      projectThreadAwareness({ environmentId, project: { title: "Project" }, thread: background })
        ?.phase,
    ).toBe("running");
    expect(tracker.update(snapshot(background), true).notifications).toEqual([]);
    const done = { ...background, backgroundLiveness: null, updatedAt: time(3) };
    expect(tracker.update(snapshot(done), true).notifications.map((item) => item.phase)).toEqual([
      "completed",
    ]);
    expect(
      tracker
        .update(snapshot({ ...done, hasActionableProposedPlan: true, updatedAt: time(4) }), true)
        .notifications.map((item) => item.phase),
    ).toEqual(["waiting_for_input"]);
    expect(tracker.update(snapshot({ ...done, updatedAt: time(5) }), true).notifications).toEqual(
      [],
    );
  });

  it("reports repeated checkpoint-free turns but not unrelated ready-session updates", () => {
    const tracker = createAgentNotificationTracker(environmentId);
    const first = working(thread("fast"));
    tracker.update(snapshot(first), true);
    expect(
      tracker.update(snapshot(finished(first)), true).notifications.map((item) => item.phase),
    ).toEqual(["completed"]);
    const second = working(finished(first), 3);
    tracker.update(snapshot(second), true);
    expect(
      tracker.update(snapshot(finished(second, 4)), true).notifications.map((item) => item.phase),
    ).toEqual(["completed"]);
    expect(tracker.update(snapshot(finished(second, 5)), true).notifications).toEqual([]);
  });

  it("catches a fast materialized turn without observing its running snapshot", () => {
    const tracker = createAgentNotificationTracker(environmentId);
    tracker.update(snapshot(thread("fast")), true);
    const done = thread("fast", "codex", {
      latestTurn: {
        turnId: TurnId.make("fast-turn"),
        state: "completed",
        requestedAt: time(1),
        startedAt: time(1),
        completedAt: time(2),
        assistantMessageId: null,
      },
      updatedAt: time(2),
    });
    expect(tracker.update(snapshot(done), true).notifications.map((item) => item.phase)).toEqual([
      "completed",
    ]);
  });

  it("reports a failure once and discards alerts when the thread is archived", () => {
    const tracker = createAgentNotificationTracker(environmentId);
    const run = working(thread("failed"));
    tracker.update(snapshot(run), true);
    const failed = {
      ...finished(run),
      session: { ...finished(run).session!, status: "error" as const, lastError: "Process exited" },
    };
    expect(
      tracker.update(snapshot(failed), true).notifications.map((item) => [item.phase, item.detail]),
    ).toEqual([["failed", "Process exited"]]);
    expect(tracker.update(snapshot({ ...failed, updatedAt: time(3) }), true).notifications).toEqual(
      [],
    );
    expect(tracker.update(snapshot({ ...failed, archivedAt: time(4) }), true).dismiss).toEqual([
      run.id,
    ]);
  });
});
