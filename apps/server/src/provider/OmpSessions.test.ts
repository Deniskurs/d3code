import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  TerminalWriteError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OmpHistoryMessage,
  type OrchestrationCommand,
  type OrchestrationThread,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { makeOmpSessions } from "./OmpSessions.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "./Services/ProviderSessionDirectory.ts";
import { ProviderService } from "./Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";

const native = {
  cwd: "",
  messages: [] as OmpHistoryMessage[],
  lists: [] as unknown[],
};
vi.mock("./acp/OmpAcpSupport.ts", async (original) => ({
  ...(await original<typeof import("./acp/OmpAcpSupport.ts")>()),
  makeOmpAcpRuntime: () =>
    Effect.succeed({
      initialize: () =>
        Effect.succeed({ agentCapabilities: { sessionCapabilities: { list: {}, fork: {} } } }),
      request: (method: string, input: { cwd?: string }) =>
        Effect.sync(() => {
          if (method === "session/list") {
            native.lists.push(input);
            return {
              sessions: [
                { sessionId: "native-session", cwd: native.cwd, title: "Native conversation" },
              ],
            };
          }
          return { configOptions: [] };
        }),
    }),
}));
vi.mock("./ompSteering.ts", () => ({
  createOmpSteering: async () => ({
    extensionPath: "unused.mjs",
    close: async () => {},
    readHistory: async () => ({
      sessionId: "native-session",
      messages: native.messages,
      model: "openai/test-model",
    }),
  }),
}));

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  native.cwd = yield* fs.makeTempDirectoryScoped();
  native.messages = [{ role: "user", text: "Original", nativeId: "native-first" }];
  native.lists = [];
  const now = "2026-09-10T12:00:00.000Z";
  const projectId = ProjectId.make("project");
  const threadId = ThreadId.make("thread");
  const instanceId = ProviderInstanceId.make("omp");
  const thread: OrchestrationThread = {
    id: threadId,
    projectId,
    title: "Native conversation",
    modelSelection: { instanceId, model: "openai/test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    messages: [
      {
        id: MessageId.make("d3-first"),
        role: "user",
        text: "Original",
        streaming: false,
        turnId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
    pullRequests: [],
    session: null,
  };
  let binding: ProviderRuntimeBindingWithMetadata = {
    threadId,
    provider: ProviderDriverKind.make("omp"),
    providerInstanceId: instanceId,
    resumeCursor: { schemaVersion: 1, sessionId: "native-session" },
    runtimePayload: {},
    lastSeenAt: now,
  };
  const commands: OrchestrationCommand[] = [];
  const writes: string[] = [];
  const refreshed = yield* Deferred.make<void>();
  const failed = yield* Deferred.make<void>();
  let listener: (event: TerminalEvent) => Effect.Effect<void> = () => Effect.void;
  let metadata: (event: TerminalMetadataStreamEvent) => Effect.Effect<void> = () => Effect.void;
  let stops = 0;
  let failWrite = false;
  const closed: string[] = [];
  const layer = Layer.mergeAll(
    ServerSettingsService.layerTest(),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            title: "Project",
            workspaceRoot: native.cwd,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          }),
        ),
      getThreadDetailById: () => Effect.succeed(Option.some(thread)),
    }),
    Layer.mock(ProviderSessionDirectory)({
      listBindings: () => Effect.sync(() => [binding]),
      upsert: (next) =>
        Effect.gen(function* () {
          const previous = binding.runtimePayload as Record<string, unknown>;
          binding = {
            ...binding,
            ...next,
            runtimePayload: { ...previous, ...(next.runtimePayload as Record<string, unknown>) },
          };
          if (
            previous.ompTerminalHandoff &&
            (binding.runtimePayload as Record<string, unknown>).ompTerminalHandoff === false
          )
            yield* Deferred.succeed(refreshed, undefined);
        }),
    }),
    Layer.mock(ProviderService)({
      stopSession: () =>
        Effect.sync(() => {
          stops++;
        }),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          commands.push(command);
          if (command.type === "thread.activity.append") yield* Deferred.succeed(failed, undefined);
          return { sequence: commands.length };
        }),
    }),
    Layer.mock(TerminalManager)({
      subscribe: (value) =>
        Effect.sync(() => {
          listener = value;
          return () => {};
        }),
      subscribeMetadata: (value) =>
        Effect.sync(() => {
          metadata = value;
          return () => {};
        }),
      open: (input) =>
        Effect.gen(function* () {
          const snapshot: TerminalSessionSnapshot = {
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd: input.cwd,
            worktreePath: null,
            status: "running",
            pid: 123,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "OMP",
            updatedAt: now,
          };
          yield* metadata({
            type: "upsert",
            terminal: { ...snapshot, hasRunningSubprocess: true },
          });
          return snapshot;
        }),
      write: (input) =>
        Effect.gen(function* () {
          if (failWrite)
            return yield* new TerminalWriteError({
              threadId: input.threadId,
              terminalId: input.terminalId,
              terminalPid: 123,
              cause: new Error("Test write failed"),
            });
          writes.push(input.data);
        }),
      close: (input) =>
        Effect.sync(() => {
          closed.push(input.terminalId ?? "");
        }),
    }),
  );
  const sessions = yield* makeOmpSessions.pipe(Effect.provide(layer));
  return {
    sessions,
    closed,
    failWrites: () => {
      failWrite = true;
    },
    commands,
    writes,
    refreshed,
    failed,
    input: { instanceId, projectId, threadId, sessionId: "native-session" },
    emit: (event: TerminalEvent) => listener(event),
    stops: () => stops,
  };
});

it.layer(NodeServices.layer)("Native OMP sessions", (it) => {
  it.effect("lists across projects and identifies the current native session", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const page = yield* h.sessions.read({ ...h.input, sessionId: undefined, scope: "all" });
      expect(native.lists).toEqual([{}]);
      expect(page).toMatchObject({ currentSession: { sessionId: "native-session" } });
      yield* h.sessions.read({ ...h.input, sessionId: undefined, scope: "project" });
      expect(native.lists.at(-1)).toEqual({ cwd: native.cwd });
      expect(h.stops()).toBe(0);
    }),
  );

  it.effect("releases D3 ownership and imports terminal work automatically on exit", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const opened = yield* h.sessions.action({
        ...h.input,
        action: "terminal",
        terminalId: "term-2",
      });
      expect(opened).toMatchObject({ terminalId: "term-2" });
      expect(h.stops()).toBe(1);
      expect(h.writes[0]).toContain("exec env");
      expect(h.writes[0]).toContain("'--resume' 'native-session'");
      const blocked = yield* Effect.flip(h.sessions.action({ ...h.input, action: "refresh" }));
      expect(blocked.message).toContain("Exit OMP");
      native.messages.push({
        role: "assistant",
        text: "Work from the terminal",
        nativeId: "native-next",
      });
      yield* h.emit({
        type: "exited",
        threadId: h.input.threadId,
        terminalId: "term-2",
        exitCode: 0,
        exitSignal: null,
      });
      yield* Deferred.await(h.refreshed);
      const imported = h.commands.find((command) => command.type === "thread.history.import");
      expect(imported).toMatchObject({ messages: [{ text: "Work from the terminal" }] });
    }),
  );

  it.effect("closes its new terminal if launching OMP fails and permits explicit recovery", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      h.failWrites();
      const failure = yield* Effect.flip(
        h.sessions.action({ ...h.input, action: "terminal", terminalId: "term-failed" }),
      );
      expect(failure.message).toContain("Failed to write");
      expect(h.closed).toEqual(["term-failed"]);
      yield* h.sessions.action({ ...h.input, action: "refresh" });
      yield* Deferred.await(h.refreshed);
    }),
  );

  it.effect("preserves the external handoff boundary until the user returns", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.sessions.action({ ...h.input, action: "handoff" });
      native.messages.push({ role: "assistant", text: "External work", nativeId: "external" });
      const rejected = yield* Effect.flip(
        h.sessions.action({ ...h.input, action: "terminal", terminalId: "term-new" }),
      );
      expect(rejected.message).toContain("Return to D3");
      expect(h.writes).toEqual([]);
      yield* h.sessions.action({ ...h.input, action: "refresh" });
      expect(h.commands.find((command) => command.type === "thread.history.import")).toMatchObject({
        messages: [{ text: "External work" }],
      });
    }),
  );

  it.effect("preserves the D3 conversation when the terminal switches native branches", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.sessions.action({ ...h.input, action: "terminal", terminalId: "term-3" });
      native.messages = [{ role: "user", text: "Other branch", nativeId: "other" }];
      yield* h.emit({ type: "closed", threadId: h.input.threadId, terminalId: "term-3" });
      yield* Deferred.await(h.failed);
      expect(h.commands.some((command) => command.type === "thread.history.import")).toBe(false);
      expect(h.commands.at(-1)).toMatchObject({
        activity: {
          kind: "omp.session.sync.failed",
          payload: { detail: expect.stringContaining("branch changed") },
        },
      });
    }),
  );
});
