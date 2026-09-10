import {
  CommandId,
  ProjectId,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  OmpSettings,
  OmpSavedSession,
  OmpHistoryMessage,
  OmpSessionsError,
  ProviderDriverKind,
  ThreadId,
  type OmpSessionsReadInput,
  type OmpSessionsReadResult,
  type OmpSessionsActionInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as AcpSchema from "effect-acp/schema";
import { ServerSettingsService } from "../serverSettings.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "./Services/ProviderSessionDirectory.ts";
import { ProviderService } from "./Services/ProviderService.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { withOmpSearchPath } from "./ompEnvironment.ts";
import {
  makeOmpAcpRuntime,
  OMP_RESUME_VERSION,
  parseOmpResume,
  getOmpAcpCurrentModel,
} from "./acp/OmpAcpSupport.ts";
import {
  hasOmpTerminalHandoff,
  ompResumeCommand,
  reconcileOmpHistory,
} from "./ompSessionHistory.ts";
import { createOmpSteering } from "./ompSteering.ts";

const NativePage = Schema.Struct({
  sessions: Schema.Array(OmpSavedSession),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const ForkResult = Schema.Struct({ sessionId: Schema.String });
const NativeHistory = Schema.Struct({
  sessionId: Schema.String,
  messages: Schema.Array(OmpHistoryMessage),
  model: Schema.optional(Schema.String),
});
const HistoryCheckpoint = Schema.Struct({
  nativeHead: Schema.NullOr(Schema.String),
  d3Head: Schema.NullOr(Schema.String),
  d3Count: Schema.Number,
});
const decodeSettings = Schema.decodeUnknownEffect(OmpSettings);
const decodePage = Schema.decodeUnknownEffect(NativePage);
const decodeFork = Schema.decodeUnknownEffect(ForkResult);
const decodeHistory = Schema.decodeUnknownEffect(NativeHistory);
const decodeLoadedSession = Schema.decodeUnknownEffect(AcpSchema.LoadSessionResponse);
const isSessionError = Schema.is(OmpSessionsError);
const isHistoryCheckpoint = Schema.is(HistoryCheckpoint);
const fail = (message: string) => new OmpSessionsError({ message });

export const makeOmpSessions = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const providers = yield* ProviderService;
  const engine = yield* OrchestrationEngineService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const operations = yield* Semaphore.make(1);

  const context = Effect.fn("OmpSessions.context")(function* (input: OmpSessionsReadInput) {
    const settings = yield* settingsService.getSettings;
    const instance = settings.providerInstances[input.instanceId];
    if (
      instance
        ? instance.driver !== "omp" || instance.enabled === false
        : input.instanceId !== "omp"
    ) {
      return yield* fail("Choose an enabled Oh My Pi provider instance.");
    }
    const config = yield* decodeSettings(instance?.config ?? settings.providers.omp);
    if (!config.enabled) return yield* fail("Enable Oh My Pi in Settings first.");
    const project = yield* snapshots.getProjectShellById(input.projectId);
    if (Option.isNone(project)) return yield* fail("This project is no longer available.");
    const bindings = yield* directory.listBindings();
    const bindingFor = (id: string) =>
      bindings.find(
        (entry) =>
          entry.provider === "omp" &&
          entry.providerInstanceId === input.instanceId &&
          parseOmpResume(entry.resumeCursor)?.sessionId === id,
      );
    let cwd = project.value.workspaceRoot;
    if (input.threadId) {
      const thread = yield* snapshots.getThreadDetailById(input.threadId);
      if (Option.isNone(thread) || thread.value.projectId !== input.projectId)
        return yield* fail("This thread is no longer available in this project.");
      cwd = thread.value.worktreePath ?? cwd;
    }
    const canonicalCwd = yield* fs.realPath(cwd);
    const environment = withOmpSearchPath(
      mergeProviderInstanceEnvironment(instance?.environment),
      platform,
    );
    const commandFor = (sessionId: string, sessionCwd = cwd) =>
      ompResumeCommand({
        cwd: sessionCwd,
        binaryPath: expandHomePath(config.binaryPath || "omp"),
        launchArgs: config.launchArgs,
        environment,
        sessionId,
      });
    const bridge = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createOmpSteering(platform)),
      (bridge) => Effect.promise(() => bridge.close()),
    );
    const runtime = yield* makeOmpAcpRuntime({
      cwd,
      ompSettings: { ...config, binaryPath: expandHomePath(config.binaryPath) },
      environment,
      childProcessSpawner: spawner,
      clientInfo: { name: "d3-code-sessions", version: "1" },
      steeringExtensionPath: bridge.extensionPath,
    }).pipe(Effect.provideService(Crypto.Crypto, crypto));
    const initialized = yield* runtime.initialize();
    const capabilities = initialized.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.list)
      return yield* fail(
        "This OMP version does not support session browsing. Update OMP in Settings.",
      );
    const list = (cursor?: string) =>
      runtime
        .request("session/list", { cwd, ...(cursor ? { cursor } : {}) })
        .pipe(Effect.flatMap(decodePage));
    const find = Effect.fn("OmpSessions.find")(function* (sessionId: string) {
      let cursor: string | undefined;
      const visited = new Set<string>();
      for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const page = yield* runtime
          .request("session/list", { ...(cursor ? { cursor } : {}) })
          .pipe(Effect.flatMap(decodePage));
        const found = page.sessions.find((entry) => entry.sessionId === sessionId);
        if (found) {
          yield* fs.realPath(found.cwd);
          return found;
        }
        if (!page.nextCursor || visited.has(page.nextCursor)) break;
        visited.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return yield* fail(
        "This OMP session was not found in this provider profile. Check the session ID and the selected OMP profile.",
      );
    });
    const history = (sessionId: string, sessionCwd: string) =>
      runtime.request("session/load", { sessionId, cwd: sessionCwd, mcpServers: [] }).pipe(
        Effect.flatMap(decodeLoadedSession),
        Effect.flatMap((response) =>
          Effect.tryPromise((signal) => bridge.readHistory(sessionId, signal)).pipe(
            Effect.flatMap(decodeHistory),
            Effect.flatMap((history) =>
              history.sessionId === sessionId
                ? Effect.succeed({
                    messages: history.messages,
                    model: getOmpAcpCurrentModel(response.configOptions ?? []) ?? history.model,
                  })
                : Effect.fail(fail("OMP returned history for a different session.")),
            ),
          ),
        ),
      );
    return {
      runtime,
      list,
      find,
      history,
      cwd,
      commandFor,
      bindingFor,
      supportsFork: capabilities.fork !== undefined,
      projectRoot: project.value.workspaceRoot,
      canonicalCwd,
    };
  });

  const readableError = (error: unknown) =>
    isSessionError(error)
      ? error
      : fail(
          error instanceof Error
            ? error.message
            : "OMP session operation failed. Check the provider and try again.",
        );

  const read = (input: OmpSessionsReadInput) =>
    Effect.gen(function* () {
      const ctx = yield* context(input);
      if (input.sessionId) {
        const session = yield* ctx.find(input.sessionId);
        const binding = ctx.bindingFor(input.sessionId);
        // Return attached identity without loading a second native writer, even during a turn.
        if (binding)
          return {
            sessions: [{ ...session, threadId: binding.threadId }],
            messages: [],
            supportsFork: ctx.supportsFork,
          } satisfies OmpSessionsReadResult;
        const history = yield* ctx.history(input.sessionId, session.cwd);
        return {
          sessions: [session],
          messages: history.messages,
          resumeCommand: ctx.commandFor(input.sessionId, session.cwd),
          supportsFork: ctx.supportsFork,
        } satisfies OmpSessionsReadResult;
      }
      const page = yield* ctx.list(input.cursor);
      return {
        sessions: page.sessions.map((session) => {
          const binding = ctx.bindingFor(session.sessionId);
          return { ...session, ...(binding ? { threadId: binding.threadId } : {}) };
        }),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        messages: [],
        supportsFork: ctx.supportsFork,
      } satisfies OmpSessionsReadResult;
    }).pipe(Effect.scoped, Effect.timeout("45 seconds"), Effect.mapError(readableError));

  const action = (input: OmpSessionsActionInput) =>
    operations.withPermit(
      Effect.gen(function* () {
        const ctx = yield* context(input);
        const native = yield* ctx.find(input.sessionId);
        const binding = ctx.bindingFor(input.sessionId);
        let sessionId = input.sessionId;
        let threadId =
          binding?.threadId ?? ThreadId.make(`import:${input.instanceId}:${sessionId}`);
        const now = DateTime.formatIso(yield* DateTime.now);
        const result = (importedMessages: number) => ({
          threadId,
          sessionId,
          importedMessages,
          resumeCommand: ctx.commandFor(sessionId, native.cwd),
          completedAt: now,
        });
        if (binding) {
          const existing = yield* snapshots.getThreadDetailById(binding.threadId);
          if (Option.isNone(existing))
            return yield* fail("The linked D3 thread is no longer available.");
          if (existing.value.archivedAt || existing.value.deletedAt)
            return yield* fail("Restore the existing D3 thread before opening this session.");
          if (input.action === "open") return result(0);
          // Reopening the handoff instructions must preserve the original history boundary.
          if (input.action === "handoff" && hasOmpTerminalHandoff(binding.runtimePayload))
            return result(0);
          if (
            existing.value.session?.status === "running" ||
            existing.value.session?.status === "starting"
          )
            return yield* fail("Wait for the current turn to finish before managing this session.");
          yield* providers.stopSession({ threadId: binding.threadId });
        }
        if (input.action === "handoff" && !binding)
          return yield* fail("Open this session in D3 first.");
        if (input.action === "fork") {
          if (!ctx.supportsFork)
            return yield* fail(
              "This OMP version does not support session forks. Update OMP in Settings.",
            );
          const forked = yield* ctx.runtime
            .request("session/fork", { sessionId, cwd: native.cwd, mcpServers: [] })
            .pipe(Effect.flatMap(decodeFork));
          sessionId = forked.sessionId;
          threadId = ThreadId.make(`import:${input.instanceId}:${sessionId}`);
        }
        const nativeHistory = yield* ctx.history(sessionId, native.cwd);
        const history = nativeHistory.messages;
        const existing = yield* snapshots.getThreadDetailById(threadId);
        if (Option.isSome(existing) && (existing.value.deletedAt || existing.value.archivedAt))
          return yield* fail("Restore the existing D3 thread before opening this session.");
        if (Option.isNone(existing)) {
          if (!nativeHistory.model)
            return yield* fail("Select a model in OMP before importing this session.");
          const inCurrentWorkspace = (yield* fs.realPath(native.cwd)) === ctx.canonicalCwd;
          let projectId = input.projectId;
          if (!inCurrentWorkspace) {
            const nativeProject = yield* snapshots.getActiveProjectByWorkspaceRoot(native.cwd);
            if (Option.isSome(nativeProject)) projectId = nativeProject.value.id;
            else {
              projectId = ProjectId.make(yield* crypto.randomUUIDv4);
              yield* engine.dispatch({
                type: "project.create",
                commandId: CommandId.make(yield* crypto.randomUUIDv4),
                projectId,
                title:
                  native.cwd.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ??
                  "OMP sessions",
                workspaceRoot: native.cwd,
                defaultModelSelection: { instanceId: input.instanceId, model: nativeHistory.model },
                createdAt: now,
              });
            }
          }
          yield* directory.upsert(
            {
              threadId,
              provider: ProviderDriverKind.make("omp"),
              providerInstanceId: input.instanceId,
              status: "stopped",
              runtimeMode: DEFAULT_RUNTIME_MODE,
              resumeCursor: { schemaVersion: OMP_RESUME_VERSION, sessionId },
              runtimePayload: { cwd: native.cwd },
            },
            { onConflict: "ignore" },
          );
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            projectId,
            title:
              input.action === "fork"
                ? `${native.title || "OMP session"} (fork)`
                : native.title || "OMP session",
            modelSelection: { instanceId: input.instanceId, model: nativeHistory.model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: inCurrentWorkspace && ctx.cwd !== ctx.projectRoot ? ctx.cwd : null,
            createdAt: now,
            historyImport: true,
          });
        }
        const previous = Option.isSome(existing) ? existing.value.messages : [];
        const saveCheckpoint = (ids: ReadonlyArray<string>) =>
          directory.upsert({
            threadId,
            provider: ProviderDriverKind.make("omp"),
            providerInstanceId: input.instanceId,
            runtimePayload: {
              ompTerminalHandoff: input.action === "handoff",
              ompHistoryCheckpoint: {
                nativeHead: history.at(-1)?.nativeId ?? null,
                d3Head: ids.at(-1) ?? null,
                d3Count: ids.length,
              },
            },
          });
        if (input.action === "handoff") {
          yield* saveCheckpoint(previous.map((message) => message.id));
          return result(0);
        }
        const runtimePayload = binding?.runtimePayload;
        const checkpointValue =
          Predicate.isObject(runtimePayload) && "ompHistoryCheckpoint" in runtimePayload
            ? runtimePayload.ompHistoryCheckpoint
            : undefined;
        const checkpoint = isHistoryCheckpoint(checkpointValue) ? checkpointValue : undefined;
        const suffix = yield* Effect.try({
          try: () => {
            if (
              checkpoint &&
              input.action !== "fork" &&
              checkpoint.d3Head === (previous.at(-1)?.id ?? null) &&
              checkpoint.d3Count === previous.length
            ) {
              const headIndex =
                checkpoint.nativeHead === null
                  ? -1
                  : history.findIndex((message) => message.nativeId === checkpoint.nativeHead);
              if (checkpoint.nativeHead !== null && headIndex === -1)
                throw new Error(
                  "OMP's active branch changed since handoff. Fork it to open that history separately.",
                );
              return history.slice(headIndex + 1);
            }
            return reconcileOmpHistory(
              previous
                .filter((message) => message.role === "user" || message.role === "assistant")
                .map((message) => ({
                  role: message.role as "user" | "assistant",
                  text: message.text,
                })),
              history,
            );
          },
          catch: readableError,
        });
        const imported = suffix.map((message, index) => ({
          messageId: MessageId.make(
            `${threadId}:omp:${String(previous.length + index).padStart(8, "0")}:${message.nativeId ?? "message"}`,
          ),
          role: message.role,
          text: message.text,
          createdAt: message.createdAt ?? now,
        }));
        if (suffix.length) {
          yield* engine.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            ...(Option.isSome(existing)
              ? {
                  expectedMessageIds: previous.map((message) => message.id),
                  expectedUpdatedAt: existing.value.updatedAt,
                }
              : {}),
            messages: imported,
          });
        }
        if (
          Option.isSome(existing) &&
          nativeHistory.model &&
          existing.value.modelSelection.model !== nativeHistory.model
        ) {
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            modelSelection: {
              instanceId: input.instanceId,
              model: nativeHistory.model,
            },
          });
        }
        yield* saveCheckpoint([
          ...previous.map((message) => message.id),
          ...imported.map((message) => message.messageId),
        ]);
        return result(suffix.length);
      }).pipe(Effect.scoped, Effect.timeout("90 seconds"), Effect.mapError(readableError)),
    );

  return { read, action };
});
