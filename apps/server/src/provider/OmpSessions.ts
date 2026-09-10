import {
  CommandId,
  EventId,
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
  type TerminalEvent,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
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
import { findOmpSession } from "./ompSessionDiscovery.ts";
import { TerminalManager } from "../terminal/Manager.ts";

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
  const terminals = yield* TerminalManager;
  const managedTerminals = new Map<string, OmpSessionsActionInput>();
  const knownTerminals = new Set<string>();
  const terminalKey = (threadId: string, terminalId: string) =>
    JSON.stringify([threadId, terminalId]);
  yield* Effect.acquireRelease(
    terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          for (const terminal of event.terminals)
            knownTerminals.add(terminalKey(terminal.threadId, terminal.terminalId));
        } else if (event.type === "upsert")
          knownTerminals.add(terminalKey(event.terminal.threadId, event.terminal.terminalId));
        else knownTerminals.delete(terminalKey(event.threadId, event.terminalId));
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

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
    const commandFor = (sessionId: string, sessionCwd = cwd, replaceShell = false) =>
      ompResumeCommand({
        cwd: sessionCwd,
        binaryPath: expandHomePath(config.binaryPath || "omp"),
        launchArgs: config.launchArgs,
        environment,
        sessionId,
        replaceShell,
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
        .request("session/list", {
          ...(input.scope === "all" ? {} : { cwd }),
          ...(cursor ? { cursor } : {}),
        })
        .pipe(Effect.flatMap(decodePage));
    const find = (sessionId: string) =>
      findOmpSession(sessionId, (cursor) =>
        runtime.request("session/list", cursor ? { cursor } : {}).pipe(Effect.flatMap(decodePage)),
      ).pipe(Effect.tap((session) => fs.realPath(session.cwd)));
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
      currentBinding: input.threadId
        ? bindings.find(
            (entry) =>
              entry.threadId === input.threadId &&
              entry.provider === "omp" &&
              entry.providerInstanceId === input.instanceId,
          )
        : undefined,
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
            sessions: [
              {
                ...session,
                threadId: binding.threadId,
                terminalHandoff: hasOmpTerminalHandoff(binding.runtimePayload),
              },
            ],
            messages: [],
            supportsFork: ctx.supportsFork,
            supportsTerminal: platform !== "win32",
          } satisfies OmpSessionsReadResult;
        const history = yield* ctx.history(input.sessionId, session.cwd);
        return {
          sessions: [session],
          messages: history.messages,
          resumeCommand: ctx.commandFor(input.sessionId, session.cwd),
          supportsFork: ctx.supportsFork,
          supportsTerminal: platform !== "win32",
        } satisfies OmpSessionsReadResult;
      }
      const page = yield* ctx.list(input.cursor);
      const currentId = parseOmpResume(ctx.currentBinding?.resumeCursor)?.sessionId;
      return {
        sessions: page.sessions.map((session) => {
          const binding = ctx.bindingFor(session.sessionId);
          return {
            ...session,
            ...(binding
              ? {
                  threadId: binding.threadId,
                  terminalHandoff: hasOmpTerminalHandoff(binding.runtimePayload),
                }
              : {}),
          };
        }),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        messages: [],
        supportsFork: ctx.supportsFork,
        supportsTerminal: platform !== "win32",
        ...(currentId && ctx.currentBinding
          ? {
              currentSession: {
                sessionId: currentId,
                cwd: ctx.cwd,
                threadId: ctx.currentBinding.threadId,
                terminalHandoff: hasOmpTerminalHandoff(ctx.currentBinding.runtimePayload),
              },
            }
          : {}),
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
        const managed = [...managedTerminals.values()].find(
          (entry) => entry.instanceId === input.instanceId && entry.sessionId === input.sessionId,
        );
        if (managed && input.action !== "open")
          return yield* fail(
            "This session is open in D3's OMP terminal. Exit OMP there to return to chat automatically.",
          );
        if (input.action === "terminal") {
          if (hasOmpTerminalHandoff(binding?.runtimePayload))
            return yield* fail(
              "Exit OMP in the external terminal and choose Return to D3 before opening another terminal.",
            );
          if (!input.terminalId) return yield* fail("Choose a new terminal for this session.");
          if (platform === "win32")
            return yield* fail(
              "Automatic terminal return is currently supported on macOS and Linux.",
            );
          if (knownTerminals.has(terminalKey(threadId, input.terminalId)))
            return yield* fail("That terminal already exists. Open a new terminal for OMP.");
        }
        if (binding) {
          const existing = yield* snapshots.getThreadDetailById(binding.threadId);
          if (Option.isNone(existing))
            return yield* fail("The linked D3 thread is no longer available.");
          if (existing.value.archivedAt || existing.value.deletedAt)
            return yield* fail("Restore the existing D3 thread before opening this session.");
          const checkpoint =
            Predicate.isObject(binding.runtimePayload) &&
            "ompHistoryCheckpoint" in binding.runtimePayload
              ? binding.runtimePayload.ompHistoryCheckpoint
              : undefined;
          const canRefreshOnOpen =
            isHistoryCheckpoint(checkpoint) &&
            checkpoint.d3Count === existing.value.messages.length &&
            checkpoint.d3Head === (existing.value.messages.at(-1)?.id ?? null);
          if (
            input.action === "open" &&
            (!canRefreshOnOpen ||
              hasOmpTerminalHandoff(binding.runtimePayload) ||
              existing.value.session?.status === "running" ||
              existing.value.session?.status === "starting")
          )
            return result(0);
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
        if ((input.action === "handoff" || input.action === "terminal") && !binding)
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
                  native.cwd.replaceAll("\\", "/").split("/").findLast(Boolean) ?? "OMP sessions",
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
              ompTerminalHandoff: input.action === "handoff" || input.action === "terminal",
              ompHistoryCheckpoint: {
                nativeHead: history.at(-1)?.nativeId ?? null,
                d3Head: ids.at(-1) ?? null,
                d3Count: ids.length,
              },
            },
          });
        if (input.action === "handoff" || input.action === "terminal") {
          yield* saveCheckpoint(previous.map((message) => message.id));
          if (input.action === "terminal" && input.terminalId) {
            const terminalId = input.terminalId;
            const key = terminalKey(threadId, terminalId);
            managedTerminals.set(key, {
              ...input,
              ...(Option.isSome(existing) ? { projectId: existing.value.projectId } : {}),
              threadId,
              action: "refresh",
            });
            let opened = false;
            yield* terminals
              .open({
                threadId,
                terminalId,
                cwd: native.cwd,
                cols: 120,
                rows: 36,
                providerInstanceId: input.instanceId,
              })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    opened = true;
                  }),
                ),
                Effect.andThen(
                  terminals.write({
                    threadId,
                    terminalId,
                    data: `${ctx.commandFor(sessionId, native.cwd, true)}\r`,
                  }),
                ),
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.void
                    : Effect.gen(function* () {
                        managedTerminals.delete(key);
                        if (opened)
                          yield* terminals.close({ threadId, terminalId }).pipe(Effect.ignore);
                      }),
                ),
              );
            return { ...result(0), terminalId };
          }
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

  const terminalEvents = yield* Effect.acquireRelease(
    Queue.unbounded<TerminalEvent>(),
    Queue.shutdown,
  );
  yield* Effect.acquireRelease(
    terminals.subscribe((event) =>
      (event.type === "exited" || event.type === "closed") &&
      managedTerminals.has(terminalKey(event.threadId, event.terminalId))
        ? Queue.offer(terminalEvents, event).pipe(Effect.asVoid)
        : Effect.void,
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  yield* Stream.fromQueue(terminalEvents).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const key = terminalKey(event.threadId, event.terminalId);
        const input = managedTerminals.get(key);
        if (!input) return;
        managedTerminals.delete(key);
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* action(input).pipe(
          Effect.catch((error) =>
            engine
              .dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(
                  `omp-terminal-sync:${event.threadId}:${event.terminalId}`,
                ),
                threadId: ThreadId.make(event.threadId),
                createdAt: now,
                activity: {
                  id: EventId.make(`omp-terminal-sync:${event.threadId}:${event.terminalId}`),
                  kind: "omp.session.sync.failed",
                  tone: "error",
                  summary: "OMP history needs attention",
                  payload: { detail: error.message },
                  turnId: null,
                  createdAt: now,
                },
              })
              .pipe(Effect.asVoid),
          ),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("OMP terminal history refresh failed", { cause }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  return { read, action };
});
