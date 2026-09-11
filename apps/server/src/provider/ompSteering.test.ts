import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { createOmpSteering } from "./ompSteering.ts";
import type { OmpAdvisorFindings, OmpSteeringContent } from "./ompSteering.ts";

async function advisorFixture(platform: NodeJS.Platform) {
  const bridge = await createOmpSteering(platform);
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => void>();
  // The extension path is generated per bridge, so this loading boundary must be dynamic.
  const module = await import(/* @vite-ignore */ NodeURL.pathToFileURL(bridge.extensionPath).href);
  const server: NodeHttp.Server = module.default({
    on: (name: string, handler: (event?: unknown, ctx?: unknown) => void) =>
      handlers.set(name, handler),
  });
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }
  let sessionId = "native-session";
  const context = {
    isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId, getLeafId: () => null },
  };
  handlers.get("session_start")?.({}, context);
  return {
    bridge,
    server,
    setSessionId: (value: string) => {
      sessionId = value;
    },
    emit: (message: unknown) => handlers.get("message_end")?.({ message }, context),
    close: async () => {
      const closed = new Promise<void>((resolve) => server.once("close", resolve));
      handlers.get("session_shutdown")?.();
      await closed;
      await bridge.close();
    },
  };
}

describe("OMP steering extension", () => {
  it.effect("streams only displayed advisor notes in emission order across idle sessions", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const fixture = await advisorFixture(platform);
        const controller = new AbortController();
        const received: OmpAdvisorFindings[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let firstReceived!: () => void;
        const first = new Promise<void>((resolve) => {
          firstReceived = resolve;
        });
        let allReceived!: () => void;
        const all = new Promise<void>((resolve) => {
          allReceived = resolve;
        });
        const displayed = {
          role: "custom",
          customType: "advisor",
          display: true,
          timestamp: 1_789_120_000_000,
          content: "<advisor>Not a findings source</advisor>",
          details: {
            privateReasoning: "Not public feedback",
            notes: [
              {
                note: "Check the refund boundary",
                severity: "blocker",
                advisor: "Payments",
                private: "omit",
              },
            ],
          },
        };
        fixture.emit({
          role: "assistant",
          content: "Ordinary answer",
          timestamp: displayed.timestamp,
        });
        fixture.emit({ ...displayed, customType: "unrelated" });
        fixture.emit({ ...displayed, display: false });
        fixture.emit({ ...displayed, details: { notes: [] } });
        fixture.emit(displayed);
        fixture.setSessionId("next-native-session");
        fixture.emit({
          ...displayed,
          details: { notes: [{ note: "Add context", severity: "nit", advisor: "Clarity" }] },
        });
        const watching = fixture.bridge.watchAdvisorFindings(async (frame) => {
          received.push(frame);
          if (received.length === 1) {
            firstReceived();
            await firstGate;
          }
          if (received.length === 3) allReceived();
        }, controller.signal);
        try {
          await first;
          fixture.emit({
            ...displayed,
            details: {
              notes: [
                { note: "Confirm cancellation", severity: "concern" },
                { note: "Keep this note" },
              ],
            },
          });
          // The primary bridge remains responsive while the first consumer callback is paused.
          expect(await fixture.bridge.beginTurn("primary-turn")).toBe(true);
          expect(received.map((frame) => frame.sequence)).toEqual([1]);
          releaseFirst();
          await all;
          const bridgeId = received[0]!.bridgeId;
          expect(received).toEqual([
            {
              bridgeId,
              sequence: 1,
              sessionId: "native-session",
              timestamp: displayed.timestamp,
              notes: [
                { note: "Check the refund boundary", severity: "blocker", advisor: "Payments" },
              ],
            },
            {
              bridgeId,
              sequence: 2,
              sessionId: "next-native-session",
              timestamp: displayed.timestamp,
              notes: [{ note: "Add context", severity: "nit", advisor: "Clarity" }],
            },
            {
              bridgeId,
              sequence: 3,
              sessionId: "next-native-session",
              timestamp: displayed.timestamp,
              notes: [
                { note: "Confirm cancellation", severity: "concern" },
                { note: "Keep this note" },
              ],
            },
          ]);
        } finally {
          releaseFirst();
          controller.abort();
          await watching;
          await fixture.close();
        }
      });
    }),
  );

  it.effect(
    "authenticates the stream and cancels an idle reader without waiting for findings",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        yield* Effect.promise(async () => {
          const fixture = await advisorFixture(platform);
          const controller = new AbortController();
          try {
            const socketPath = fixture.server.address();
            if (typeof socketPath !== "string") throw new Error("Expected a local bridge socket.");
            const status = await new Promise<number | undefined>((resolve, reject) => {
              const req = NodeHttp.request(
                {
                  socketPath,
                  path: "/advisories",
                  method: "POST",
                  headers: { authorization: "wrong-token" },
                },
                (res) => {
                  res.resume();
                  resolve(res.statusCode);
                },
              );
              req.on("error", reject);
              req.end("{}");
            });
            expect(status).toBe(403);
            const subscribed = new Promise<NodeHttp.ServerResponse>((resolve) =>
              fixture.server.once("request", (_req, res) => resolve(res)),
            );
            const received: OmpAdvisorFindings[] = [];
            const watching = fixture.bridge.watchAdvisorFindings(async (frame) => {
              received.push(frame);
            }, controller.signal);
            const response = await subscribed;
            const disconnected = new Promise<void>((resolve) => response.once("close", resolve));
            controller.abort();
            await watching;
            await disconnected;
            fixture.emit({
              role: "custom",
              customType: "advisor",
              display: true,
              timestamp: 1,
              details: { notes: [{ note: "After cancellation" }] },
            });
            expect(received).toEqual([]);
          } finally {
            controller.abort();
            await fixture.close();
          }
        });
      }),
  );

  it.effect("resubscribes once and delivers queued and future notes without replay", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const fixture = await advisorFixture(platform);
        const controller = new AbortController();
        const received: OmpAdvisorFindings[] = [];
        const requests: string[] = [];
        fixture.server.on("request", (req) => requests.push(req.url!));
        const subscribed = new Promise<NodeHttp.ServerResponse>((resolve) =>
          fixture.server.once("request", (_req, res) => resolve(res)),
        );
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let firstReceived!: () => void;
        const first = new Promise<void>((resolve) => {
          firstReceived = resolve;
        });
        let allReceived!: () => void;
        const all = new Promise<void>((resolve) => {
          allReceived = resolve;
        });
        const message = {
          role: "custom",
          customType: "advisor",
          display: true,
          timestamp: 1,
          details: { notes: [{ note: "Delivered before disconnect" }] },
        };
        fixture.emit(message);
        const watching = fixture.bridge.watchAdvisorFindings(async (frame) => {
          received.push(frame);
          if (received.length === 1) {
            firstReceived();
            await firstGate;
          }
          if (received.length === 3) allReceived();
        }, controller.signal);
        try {
          const oldResponse = await subscribed;
          await first;
          const replacement = new Promise<NodeHttp.ServerResponse>((resolve) =>
            fixture.server.once("request", (_req, res) => resolve(res)),
          );
          const disconnected = new Promise<void>((resolve) => oldResponse.once("close", resolve));
          oldResponse.destroy();
          await disconnected;
          fixture.emit({ ...message, details: { notes: [{ note: "Queued while disconnected" }] } });
          releaseFirst();
          await replacement;
          // Late events from the old response must not clear or unblock its replacement.
          oldResponse.emit("close");
          oldResponse.emit("drain");
          expect(requests).toEqual(["/advisories", "/advisories"]);
          await expect(
            fixture.bridge.watchAdvisorFindings(async () => {}, new AbortController().signal),
          ).rejects.toThrow("409");
          fixture.emit({ ...message, details: { notes: [{ note: "Delivered after reconnect" }] } });
          await all;
          expect(received.map((frame) => frame.sequence)).toEqual([1, 2, 3]);
          expect(received.map((frame) => frame.notes[0]!.note)).toEqual([
            "Delivered before disconnect",
            "Queued while disconnected",
            "Delivered after reconnect",
          ]);
          expect(new Set(received.map((frame) => frame.bridgeId)).size).toBe(1);
          expect(await fixture.bridge.beginTurn("still-operational")).toBe(true);
        } finally {
          releaseFirst();
          controller.abort();
          await watching;
          await fixture.close();
        }
      });
    }),
  );

  it.effect("lets abort win a transport disconnect without resubscribing", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const fixture = await advisorFixture(platform);
        const controller = new AbortController();
        let requests = 0;
        fixture.server.on("request", () => {
          requests++;
        });
        const subscribed = new Promise<NodeHttp.ServerResponse>((resolve) =>
          fixture.server.once("request", (_req, res) => resolve(res)),
        );
        let delivered!: () => void;
        const first = new Promise<void>((resolve) => {
          delivered = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        fixture.emit({
          role: "custom",
          customType: "advisor",
          display: true,
          timestamp: 1,
          details: { notes: [{ note: "Delivered" }] },
        });
        const watching = fixture.bridge.watchAdvisorFindings(async () => {
          delivered();
          await gate;
        }, controller.signal);
        try {
          const response = await subscribed;
          await first;
          const disconnected = new Promise<void>((resolve) => response.once("close", resolve));
          response.destroy();
          await disconnected;
          controller.abort();
          release();
          await watching;
          expect(requests).toBe(1);
        } finally {
          release();
          controller.abort();
          await watching;
          await fixture.close();
        }
      });
    }),
  );

  it.effect("exhausts its one reconnect without retrying primary work", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const fixture = await advisorFixture(platform);
        const controller = new AbortController();
        const requests: string[] = [];
        fixture.server.on("request", (req) => requests.push(req.url!));
        const subscribed = new Promise<NodeHttp.ServerResponse>((resolve) =>
          fixture.server.once("request", (_req, res) => resolve(res)),
        );
        let firstReceived!: () => void;
        const first = new Promise<void>((resolve) => {
          firstReceived = resolve;
        });
        let secondReceived!: () => void;
        const second = new Promise<void>((resolve) => {
          secondReceived = resolve;
        });
        const message = {
          role: "custom",
          customType: "advisor",
          display: true,
          timestamp: 1,
          details: { notes: [{ note: "First connection" }] },
        };
        fixture.emit(message);
        const received: number[] = [];
        const watching = fixture.bridge.watchAdvisorFindings(async (frame) => {
          received.push(frame.sequence);
          if (received.length === 1) firstReceived();
          if (received.length === 2) secondReceived();
        }, controller.signal);
        const rejected = expect(watching).rejects.toThrow();
        try {
          const response = await subscribed;
          await first;
          const replacement = new Promise<NodeHttp.ServerResponse>((resolve) =>
            fixture.server.once("request", (_req, res) => resolve(res)),
          );
          response.destroy();
          const nextResponse = await replacement;
          fixture.emit({ ...message, details: { notes: [{ note: "Second connection" }] } });
          await second;
          nextResponse.destroy();
          await rejected;
          expect(requests).toEqual(["/advisories", "/advisories"]);
          expect(received).toEqual([1, 2]);
          expect(await fixture.bridge.beginTurn("still-operational")).toBe(true);
        } finally {
          controller.abort();
          await watching.catch(() => {});
          await fixture.close();
        }
      });
    }),
  );

  it.effect("does not reconnect when a findings callback throws a transport-shaped error", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const fixture = await advisorFixture(platform);
        let requests = 0;
        fixture.server.on("request", () => {
          requests++;
        });
        const failure = Object.assign(new Error("Consumer failed"), { code: "ECONNRESET" });
        fixture.emit({
          role: "custom",
          customType: "advisor",
          display: true,
          timestamp: 1,
          details: { notes: [{ note: "Public finding" }] },
        });
        try {
          await expect(
            fixture.bridge.watchAdvisorFindings(async () => {
              throw failure;
            }, new AbortController().signal),
          ).rejects.toBe(failure);
          expect(requests).toBe(1);
        } finally {
          await fixture.close();
        }
      });
    }),
  );

  it.effect("bounds the pre-subscriber backlog without failing the primary bridge", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const fixture = await advisorFixture(platform);
        const received: OmpAdvisorFindings[] = [];
        try {
          for (let index = 0; index < 6; index++) {
            fixture.emit({
              role: "custom",
              customType: "advisor",
              display: true,
              timestamp: index,
              details: { notes: [{ note: "x".repeat(50 * 1024) }] },
            });
          }
          await expect(
            fixture.bridge.watchAdvisorFindings(async (frame) => {
              received.push(frame);
            }, new AbortController().signal),
          ).rejects.toThrow("503");
          expect(received).toEqual([]);
          expect(await fixture.bridge.beginTurn("still-operational")).toBe(true);
        } finally {
          await fixture.close();
        }
      });
    }),
  );

  it.effect("bounds findings queued after a subscriber disconnects", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const fixture = await advisorFixture(platform);
        const controller = new AbortController();
        const subscribed = new Promise<NodeHttp.ServerResponse>((resolve) =>
          fixture.server.once("request", (_req, res) => resolve(res)),
        );
        const watching = fixture.bridge.watchAdvisorFindings(async () => {}, controller.signal);
        try {
          const response = await subscribed;
          const disconnected = new Promise<void>((resolve) => response.once("close", resolve));
          controller.abort();
          await watching;
          await disconnected;
          for (let index = 0; index < 6; index++) {
            fixture.emit({
              role: "custom",
              customType: "advisor",
              display: true,
              timestamp: index,
              details: { notes: [{ note: "x".repeat(50 * 1024) }] },
            });
          }
          await expect(
            fixture.bridge.watchAdvisorFindings(async () => {}, new AbortController().signal),
          ).rejects.toThrow("503");
          expect(await fixture.bridge.beginTurn("still-operational")).toBe(true);
        } finally {
          controller.abort();
          await watching;
          await fixture.close();
        }
      });
    }),
  );

  it.effect("bounds a stalled reader while keeping native delivery synchronous", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const fixture = await advisorFixture(platform);
        const controller = new AbortController();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let firstReceived!: () => void;
        const first = new Promise<void>((resolve) => {
          firstReceived = resolve;
        });
        const emit = (note: string) =>
          fixture.emit({
            role: "custom",
            customType: "advisor",
            display: true,
            timestamp: 1,
            details: { notes: [{ note }] },
          });
        emit("First finding");
        const watching = fixture.bridge.watchAdvisorFindings(async () => {
          firstReceived();
          await gate;
        }, controller.signal);
        const rejected = expect(watching).rejects.toThrow("invalid advisor findings");
        try {
          await first;
          for (let index = 0; index < 20; index++) {
            emit("x".repeat(50 * 1024));
          }
          expect(await fixture.bridge.beginTurn("still-operational")).toBe(true);
          release();
          await rejected;
        } finally {
          release();
          controller.abort();
          await watching.catch(() => {});
          await fixture.close();
        }
      });
    }),
  );

  it.effect("ends the scope stream cleanly on native shutdown without reconnecting", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const fixture = await advisorFixture(platform);
        const controller = new AbortController();
        let requests = 0;
        fixture.server.on("request", () => {
          requests++;
        });
        const subscribed = new Promise<void>((resolve) =>
          fixture.server.once("request", () => resolve()),
        );
        const received: OmpAdvisorFindings[] = [];
        const watching = fixture.bridge.watchAdvisorFindings(async (frame) => {
          received.push(frame);
        }, controller.signal);
        try {
          await subscribed;
          await fixture.close();
          await watching;
          expect(received).toEqual([]);
          expect(requests).toBe(1);
        } finally {
          controller.abort();
          await watching;
        }
      });
    }),
  );

  for (const [name, wire, diagnostic] of [
    ["malformed", '{"notes":"not structured findings"}\n', "invalid advisor findings"],
    ["oversized", "x".repeat(64 * 1024 + 1), "exceeds the delivery limit"],
    ["truncated", '{"bridgeId":', "incomplete advisor findings frame"],
  ] as const) {
    it.effect(`rejects ${name} frames instead of manufacturing findings`, () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        yield* Effect.promise(async () => {
          const fixture = await advisorFixture(platform);
          const received: OmpAdvisorFindings[] = [];
          let requests = 0;
          fixture.server.on("request", () => {
            requests++;
          });
          try {
            fixture.server.once("request", (_req, res) => res.end(wire));
            await expect(
              fixture.bridge.watchAdvisorFindings(async (frame) => {
                received.push(frame);
              }, new AbortController().signal),
            ).rejects.toThrow(diagnostic);
            expect(received).toEqual([]);
            expect(requests).toBe(1);
          } finally {
            await fixture.close();
          }
        });
      }),
    );
  }

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
          handlers.get("session_start")?.(
            {},
            {
              isIdle: () => idle,
              sessionManager: { getSessionId: () => "session-1", getLeafId: () => null },
            },
          );
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

  it.effect(
    "reads only this prompt's native outcome across retries and rejects stale ancestry",
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
          const entries = new Map<
            string,
            {
              id: string;
              parentId: string | null;
              type: "message";
              message: { role: string; stopReason: string; errorMessage?: string };
            }
          >();
          let leafId: string | null = null;
          let sessionId = "native-session";
          const append = (id: string, stopReason: string, errorMessage?: string) => {
            entries.set(id, {
              id,
              parentId: leafId,
              type: "message",
              message: { role: "assistant", stopReason, ...(errorMessage ? { errorMessage } : {}) },
            });
            leafId = id;
          };
          handlers.get("session_start")?.(
            {},
            {
              isIdle: () => true,
              sessionManager: {
                getSessionId: () => sessionId,
                getLeafId: () => leafId,
                getEntry: (id: string) => entries.get(id),
              },
            },
          );
          try {
            if (!server.listening)
              await new Promise<void>((resolve, reject) => {
                server.once("listening", resolve);
                server.once("error", reject);
              });
            append("old-error", "error", "An earlier turn failed");
            expect(await bridge.beginTurn("turn-1")).toBe(true);
            expect(await bridge.readOutcome("turn-1")).toBeNull();
            append("retry-error", "error", "Transient failure");
            append("recovered", "stop");
            expect(await bridge.readOutcome("turn-1")).toEqual({
              turnId: "turn-1",
              stopReason: "stop",
            });

            expect(await bridge.beginTurn("turn-2")).toBe(true);
            append("terminal-error", "error", "The operation was aborted");
            expect(await bridge.readOutcome("turn-2")).toEqual({
              turnId: "turn-2",
              stopReason: "error",
              errorMessage: "The operation was aborted",
            });
            await expect(bridge.readOutcome("turn-1")).rejects.toThrow();
            expect(await bridge.beginTurn("command-without-model")).toBe(true);
            expect(await bridge.readOutcome("command-without-model")).toBeNull();
            leafId = "old-error";
            await expect(bridge.readOutcome("command-without-model")).rejects.toThrow();
            sessionId = "another-native-session";
            await expect(bridge.readOutcome("command-without-model")).rejects.toThrow();
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
          await expect(
            bridge.watchAdvisorFindings(async () => {
              throw new Error("An absent extension cannot deliver advisor notes.");
            }, new AbortController().signal),
          ).resolves.toBeUndefined();
        } finally {
          await bridge.close();
        }
      });
    }),
  );
});
