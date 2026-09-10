import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import type { CodexAppServerClient } from "effect-codex-app-server/client";

export class CodexComputerUseCleanupError extends Schema.TaggedError<CodexComputerUseCleanupError>()(
  "CodexComputerUseCleanupError",
  { message: Schema.String },
) {}
const encodeNativePayload = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("agent-turn-complete"),
      "thread-id": Schema.String,
      "turn-id": Schema.String,
    }),
  ),
);
export const nativeComputerUseTurnEndedPayload = (turn: { threadId: string; turnId: string }) =>
  encodeNativePayload({
    type: "agent-turn-complete",
    "thread-id": turn.threadId,
    "turn-id": turn.turnId,
  });

type UsedTurn = { threadId: string; turnId: string; servers: Set<string> };
const record = (value: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(value) && !Array.isArray(value) ? value : undefined;

/** Only invoke the native cleanup executable, never another configured notify command. */
export function nativeComputerUseNotifyExecutable(notify: unknown): string | undefined {
  if (!Array.isArray(notify) || notify[1] !== "turn-ended") return;
  const executable = notify[0];
  if (typeof executable !== "string" || !executable.startsWith("/")) return;
  if (executable.split("/").at(-1) === "SkyComputerUseClient") return executable;
}

/** Match cleanup to native turn IDs so a late completion cannot release another turn. */
export function makeCodexComputerUseLifecycle(input: {
  client: Pick<CodexAppServerClient["Service"], "request">;
  runNativeCleanup: (
    executable: string,
    turn: { threadId: string; turnId: string },
  ) => Effect.Effect<void, CodexComputerUseCleanupError>;
  onWarning: (turn: { threadId: string; turnId: string }) => Effect.Effect<void>;
}) {
  const turns = new Map<string, UsedTurn>();
  const key = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);

  const cleanup = (turn: UsedTurn, interrupted: boolean, child: boolean) =>
    Effect.gen(function* () {
      const pending = new Set(turn.servers);
      // Only call cleanup on MCP servers used by this native turn.
      yield* Effect.gen(function* () {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = yield* input.client.request("mcpServerStatus/list", {
            threadId: turn.threadId,
            ...(cursor ? { cursor } : {}),
          });
          for (const server of page.data) {
            if (!turn.servers.has(server.name) || !server.tools.turn_ended) continue;
            const result = yield* input.client.request("mcpServer/tool/call", {
              threadId: turn.threadId,
              server: server.name,
              tool: "turn_ended",
              arguments: {
                hook_event_name: interrupted ? "Interrupt" : child ? "SubagentStop" : "Stop",
                session_id: turn.threadId,
                turn_id: turn.turnId,
              },
            });
            if (!result.isError) pending.delete(server.name);
          }
          cursor = page.nextCursor ?? undefined;
          if (cursor && seen.has(cursor)) break;
          if (cursor) seen.add(cursor);
        } while (cursor);
      }).pipe(Effect.timeout("3 seconds"), Effect.ignore);

      // The legacy Mac helper has a CLI notification endpoint rather than an MCP cleanup tool.
      if (pending.size > 0)
        yield* Effect.gen(function* () {
          const { config } = yield* input.client.request("config/read", { includeLayers: false });
          const executable = nativeComputerUseNotifyExecutable(config.notify);
          if (!executable) return;
          yield* input.runNativeCleanup(executable, turn);
          pending.clear();
        }).pipe(Effect.timeout("3 seconds"), Effect.ignore);
      if (pending.size > 0) yield* input.onWarning(turn);
    });

  const end = (threadId: string, turnId: string, interrupted: boolean, child: boolean) =>
    Effect.suspend(() => {
      const id = key(threadId, turnId);
      const turn = turns.get(id);
      if (!turn) return Effect.void;
      turns.delete(id);
      return cleanup(turn, interrupted, child);
    });

  const observe = (method: string, value: unknown, rootThreadId: string | undefined) =>
    Effect.gen(function* () {
      const params = record(value);
      const threadId = params?.threadId;
      if (typeof threadId !== "string") return;
      if (method === "item/started" || method === "item/completed") {
        const item = record(params?.item);
        const turnId = params?.turnId;
        if (
          item?.type !== "mcpToolCall" ||
          typeof item.server !== "string" ||
          typeof turnId !== "string" ||
          item.tool === "turn_ended"
        )
          return;
        const surface = record(record(record(item.result)?._meta)?.["codex/toolSurface"]);
        const computerUse =
          item.server === "computer-use" ||
          item.server === "cua_repl" ||
          item.server === "node_repl" ||
          item.server === "browser" ||
          surface?.kind === "computerUse" ||
          surface?.kind === "browserUse";
        if (!computerUse) return;
        const id = key(threadId, turnId);
        const turn = turns.get(id) ?? { threadId, turnId, servers: new Set<string>() };
        turn.servers.add(item.server);
        turns.set(id, turn);
      } else if (method === "turn/completed") {
        const turn = record(params?.turn);
        if (typeof turn?.id === "string")
          yield* end(threadId, turn.id, turn.status === "interrupted", threadId !== rootThreadId);
      } else if (method === "thread/closed") {
        for (const turn of turns.values()) {
          if (turn.threadId === threadId)
            yield* end(threadId, turn.turnId, true, threadId !== rootThreadId);
        }
      }
    });

  const close = Effect.suspend(() =>
    Effect.forEach([...turns.values()], (turn) => end(turn.threadId, turn.turnId, true, false), {
      concurrency: 4,
      discard: true,
    }),
  );
  return { observe, close };
}
