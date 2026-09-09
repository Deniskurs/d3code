import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { createOmpSteering, type OmpSteeringContent } from "./ompSteering.ts";

describe("OMP steering extension", () => {
  it.effect(
    "reads the complete active branch without compaction loss and checks session identity",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        yield* Effect.promise(async () => {
          const bridge = await createOmpSteering(platform);
          const handlers = new Map<string, (event?: unknown, ctx?: unknown) => void>();
          const module = await import(
            /* @vite-ignore */ NodeURL.pathToFileURL(bridge.extensionPath).href
          );
          const server: NodeHttp.Server = module.default({
            on: (name: string, handler: (event?: unknown, ctx?: unknown) => void) =>
              handlers.set(name, handler),
          });
          let idle = true;
          const createdAt = "2026-09-09T12:00:00.000Z";
          handlers.get("session_start")?.(
            {},
            {
              isIdle: () => idle,
              sessionManager: {
                getSessionId: () => "native-session",
                getBranch: () => [
                  {
                    type: "message",
                    id: "before",
                    timestamp: createdAt,
                    message: { role: "user", content: "Before compaction" },
                  },
                  { type: "compaction", summary: "Condensed context" },
                  {
                    type: "message",
                    id: "after",
                    timestamp: createdAt,
                    message: {
                      role: "assistant",
                      content: [
                        { type: "thinking", thinking: "private" },
                        { type: "text", text: "After compaction" },
                      ],
                    },
                  },
                ],
              },
            },
          );
          try {
            expect(await bridge.readHistory("native-session")).toEqual({
              sessionId: "native-session",
              messages: [
                { nativeId: "before", role: "user", text: "Before compaction", createdAt },
                { nativeId: "after", role: "assistant", text: "After compaction", createdAt },
              ],
            });
            await expect(bridge.readHistory("wrong-session")).rejects.toThrow("could not read");
            idle = false;
            await expect(bridge.readHistory("native-session")).rejects.toThrow("could not read");
          } finally {
            const closed = new Promise<void>((resolve) => server.once("close", resolve));
            handlers.get("session_shutdown")?.();
            await closed;
            await bridge.close();
          }
        });
      }),
  );
  it.effect("delivers text and images to the busy native session and rejects idle delivery", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const bridge = await createOmpSteering(platform);
        const handlers = new Map<string, (event?: unknown, ctx?: unknown) => void>();
        const delivered: { content: OmpSteeringContent[]; options: unknown }[] = [];
        let idle = true;
        const module = await import(
          /* @vite-ignore */ NodeURL.pathToFileURL(bridge.extensionPath).href
        );
        const server: NodeHttp.Server = module.default({
          on: (name: string, handler: (event?: unknown, ctx?: unknown) => void) =>
            handlers.set(name, handler),
          sendUserMessage: (content: OmpSteeringContent[], options: unknown) =>
            delivered.push({ content, options }),
        });
        try {
          if (!server.listening)
            await new Promise<void>((resolve, reject) => {
              server.once("listening", resolve);
              server.once("error", reject);
            });
          const content: OmpSteeringContent[] = [
            { type: "text", text: "Use this design instead" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ];
          expect(await bridge.send(content, "turn-1")).toBe(false);
          handlers.get("session_start")?.({}, { isIdle: () => idle });
          expect(await bridge.send(content, "turn-1")).toBe(false);
          expect(delivered).toEqual([]);
          expect(await bridge.beginTurn("turn-1")).toBe(true);
          idle = false;
          expect(await bridge.send(content, "turn-1")).toBe(true);
          expect(delivered).toEqual([{ content, options: { deliverAs: "steer" } }]);
          expect(await bridge.beginTurn("turn-2")).toBe(true);
          expect(await bridge.send(content, "turn-1")).toBe(false);
          idle = true;
          expect(await bridge.send(content, "turn-1")).toBe(false);
          expect(delivered).toHaveLength(1);
        } finally {
          const closed = new Promise<void>((resolve) => server.once("close", resolve));
          handlers.get("session_shutdown")?.();
          await closed;
          await bridge.close();
        }
      });
    }),
  );

  it.effect("falls back to the ACP queue when the installed runtime does not load extensions", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const bridge = await createOmpSteering(platform);
        try {
          expect(await bridge.send([{ type: "text", text: "next task" }], "turn-1")).toBe(false);
        } finally {
          await bridge.close();
        }
      });
    }),
  );
});
