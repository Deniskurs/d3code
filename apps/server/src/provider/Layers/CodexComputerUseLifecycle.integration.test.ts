// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import wire from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import { nativeComputerUseNotifyExecutable } from "./CodexComputerUseLifecycle.ts";

const root = wire.rootThreadId;
const peer = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);
const call = (threadId: string, turnId: string, server = "cua_repl") => ({
  method: "item/completed",
  params: {
    threadId,
    turnId,
    completedAtMs: 1,
    item: {
      type: "mcpToolCall",
      id: `${threadId}:${turnId}`,
      server,
      tool: "js",
      arguments: {},
      status: "completed",
      durationMs: 1,
      error: null,
      result: { content: [], _meta: { "codex/toolSurface": { kind: "computerUse" } } },
    },
  },
});
const ended = (threadId: string, turnId: string, status = "completed") => ({
  method: "turn/completed",
  params: { threadId, turn: { id: turnId, status, items: [] } },
});

const harness = (options: {
  notifications: unknown[];
  holdTurnOpen?: boolean;
  failHook?: boolean;
  omitHook?: boolean;
  notify?: string[];
}) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d3-cua-lifecycle-"))),
      (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    const scriptPath = NodePath.join(dir, "script.json");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        scriptPath,
        JSON.stringify({
          rootThreadId: root,
          turnIds: ["root-turn"],
          ...options,
          computerUseCleanup: {
            servers: ["cua_repl", "node_repl", "unused-server"],
            failHook: options.failHook,
            omitHook: options.omitHook,
            notify: options.notify,
          },
        }),
      ),
    );
    const runtimeScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("d3-thread"),
      binaryPath: peer,
      cwd: dir,
      runtimeMode: "full-access",
      environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
    }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
    yield* runtime.start();
    const readCalls = Effect.promise(async () => {
      const text = await NodeFSP.readFile(`${scriptPath}.cleanup`, "utf8").catch(() => "");
      return text.trim()
        ? text
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  threadId: string;
                  server: string;
                  tool: string;
                  arguments: Record<string, string>;
                },
            )
        : [];
    });
    return { runtime, readCalls };
  });

it.layer(NodeServices.layer)("Codex computer-use cleanup", (it) => {
  it.effect(
    "ends each native turn once, including delegated agents, without releasing unused servers",
    () =>
      Effect.gen(function* () {
        const child = "computer-child";
        const h = yield* harness({
          notifications: [
            call(child, "child-turn", "node_repl"),
            ended(child, "child-turn"),
            ended(child, "child-turn"),
            call(root, "root-turn"),
          ],
        });
        const done = yield* h.runtime.events.pipe(
          Stream.filter((event) => event.method === "turn/completed"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* h.runtime.sendTurn({ input: "Inspect the desktop" });
        yield* Fiber.join(done);
        expect(yield* h.readCalls).toEqual([
          {
            threadId: child,
            server: "node_repl",
            tool: "turn_ended",
            arguments: {
              hook_event_name: "SubagentStop",
              session_id: child,
              turn_id: "child-turn",
            },
          },
          {
            threadId: root,
            server: "cua_repl",
            tool: "turn_ended",
            arguments: { hook_event_name: "Stop", session_id: root, turn_id: "root-turn" },
          },
        ]);
      }),
  );

  it.effect("releases capture when a native turn is interrupted", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        notifications: [call(root, "root-turn"), ended(root, "root-turn", "interrupted")],
        holdTurnOpen: true,
      });
      const done = yield* h.runtime.events.pipe(
        Stream.filter((event) => event.method === "turn/completed"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* h.runtime.sendTurn({ input: "Inspect the desktop" });
      yield* Fiber.join(done);
      expect((yield* h.readCalls)[0]?.arguments.hook_event_name).toBe("Interrupt");
    }),
  );

  it.effect("releases outstanding computer use before closing the runtime", () =>
    Effect.gen(function* () {
      const h = yield* harness({ notifications: [call(root, "root-turn")], holdTurnOpen: true });
      const seen = yield* h.runtime.events.pipe(
        Stream.filter((event) => event.method === "item/completed"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* h.runtime.sendTurn({ input: "Inspect the desktop" });
      yield* Fiber.join(seen);
      yield* h.runtime.close;
      expect((yield* h.readCalls)[0]?.arguments).toMatchObject({
        hook_event_name: "Interrupt",
        session_id: root,
      });
    }),
  );

  it.effect("reports cleanup failure without losing the completed turn", () =>
    Effect.gen(function* () {
      const h = yield* harness({ notifications: [call(root, "root-turn")], failHook: true });
      const events = yield* h.runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* h.runtime.sendTurn({ input: "Inspect the desktop" });
      const received = yield* Fiber.join(events);
      expect(received.some((event) => event.method === "computerUse/cleanupFailed")).toBe(true);
      expect(received.at(-1)?.method).toBe("turn/completed");
    }),
  );

  it.effect("a late completion releases only its own turn while a newer turn remains active", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        notifications: [
          call(root, "old-turn"),
          call(root, "new-turn"),
          ended(root, "old-turn"),
          ended(root, "old-turn"),
        ],
      });
      const done = yield* h.runtime.events.pipe(
        Stream.filter((event) => event.method === "turn/completed" && event.turnId === "root-turn"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* h.runtime.sendTurn({ input: "Inspect the desktop" });
      yield* Fiber.join(done);
      expect((yield* h.readCalls).map((call) => call.arguments.turn_id)).toEqual(["old-turn"]);
      yield* h.runtime.close;
      expect((yield* h.readCalls).map((call) => call.arguments.turn_id)).toEqual([
        "old-turn",
        "new-turn",
      ]);
    }),
  );

  if (HostProcessPlatform.defaultValue() !== "win32")
    it.effect("uses the configured native helper when the MCP cleanup hook is unavailable", () =>
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d3-native-cleanup-")),
          ),
          (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
        );
        const executable = NodePath.join(dir, "SkyComputerUseClient");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(executable, '#!/bin/sh\nprintf \'%s\' "$2" > "$0.payload"\n', {
            mode: 0o755,
          }),
        );
        const h = yield* harness({
          notifications: [call(root, "root-turn", "computer-use")],
          omitHook: true,
          notify: [executable, "turn-ended", "--previous-notify", "ignored"],
        });
        const done = yield* h.runtime.events.pipe(
          Stream.takeUntil((event) => event.method === "turn/completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* h.runtime.sendTurn({ input: "Inspect the desktop" });
        const events = yield* Fiber.join(done);
        expect(events.some((event) => event.method === "computerUse/cleanupFailed")).toBe(false);
        const payload = yield* Effect.promise(() =>
          NodeFSP.readFile(`${executable}.payload`, "utf8"),
        );
        expect(JSON.parse(payload)).toEqual({
          type: "agent-turn-complete",
          "thread-id": root,
          "turn-id": "root-turn",
        });
        expect(yield* h.readCalls).toEqual([]);
      }),
    );

  it.effect("does not invoke cleanup for text-only turns", () =>
    Effect.gen(function* () {
      const h = yield* harness({ notifications: [] });
      const done = yield* h.runtime.events.pipe(
        Stream.filter((event) => event.method === "turn/completed"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* h.runtime.sendTurn({ input: "Hello" });
      yield* Fiber.join(done);
      expect(yield* h.readCalls).toEqual([]);
    }),
  );
});

it("only accepts the native helper's notify command", () => {
  expect(
    nativeComputerUseNotifyExecutable([
      "/Applications/Computer Use.app/Contents/MacOS/SkyComputerUseClient",
      "turn-ended",
    ]),
  ).toBe("/Applications/Computer Use.app/Contents/MacOS/SkyComputerUseClient");
  expect(nativeComputerUseNotifyExecutable(["/usr/bin/curl", "turn-ended"])).toBeUndefined();
  expect(
    nativeComputerUseNotifyExecutable([
      "/Applications/Computer Use.app/Contents/MacOS/SkyComputerUseClient",
      "mcp",
    ]),
  ).toBeUndefined();
});
