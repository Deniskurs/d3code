import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ReasoningHistoryPage } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import {
  makeReasoningHistory,
  MAX_REASONING_HISTORY_BYTES,
  MAX_THREAD_REASONING_HISTORY_BYTES,
  REASONING_HISTORY_PAGE_BYTES,
} from "./reasoningHistory.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "reasoning-history-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reads exact unicode history across bounded record-aligned pages after reopening", () =>
  Effect.gen(function* () {
    const writer = yield* makeReasoningHistory;
    const original = "a".repeat(7_999) + "😀\n\u0000".repeat(30_000) + " final tail";
    yield* writer.append("thread", "item", original);
    const fs = yield* FileSystem.FileSystem;
    let bytesRead = 0;
    const boundedFs = FileSystem.FileSystem.of({
      ...fs,
      readFile: () => Effect.die("History pages must not read entire files"),
      readFileString: () => Effect.die("History pages must not read entire files"),
      open: (filePath, options) =>
        fs.open(filePath, options).pipe(
          Effect.map(
            (file) =>
              new Proxy(file, {
                get(target, key) {
                  if (key === "read") {
                    return (buffer: Uint8Array) =>
                      target.read(buffer).pipe(
                        Effect.tap((size) =>
                          Effect.sync(() => {
                            bytesRead += Number(size);
                          }),
                        ),
                      );
                  }
                  const value: unknown = Reflect.get(target, key, target);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              }),
          ),
        ),
    });
    // A fresh reader retains no writer-side memory or open descriptors.
    const reader = yield* makeReasoningHistory.pipe(
      Effect.provideService(FileSystem.FileSystem, boundedFs),
    );
    let cursor: number | null = 0;
    let recovered = "";
    let pages = 0;
    while (cursor !== null) {
      bytesRead = 0;
      const page: ReasoningHistoryPage = yield* reader.readPage("thread", "item", cursor);
      expect(bytesRead).toBeLessThanOrEqual(REASONING_HISTORY_PAGE_BYTES);
      expect(page.text.isWellFormed()).toBe(true);
      if (page.nextCursor !== null) expect(page.nextCursor).toBeGreaterThan(cursor);
      recovered += page.text;
      cursor = page.nextCursor;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(recovered).toBe(original);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects missing histories and invalid byte cursors without inventing text", () =>
  Effect.gen(function* () {
    const history = yield* makeReasoningHistory;
    expect(yield* history.readPage("old-thread", "old-item").pipe(Effect.flip)).toMatchObject({
      reason: "missing",
    });
    yield* history.append("thread", "item", "😀\nfirst");
    for (const cursor of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 1, 2, 1000]) {
      expect(yield* history.readPage("thread", "item", cursor).pipe(Effect.flip)).toMatchObject({
        reason: "invalid_cursor",
      });
    }
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))("😀\nfirst");
    const end = Buffer.byteLength(`${encoded}\n`);
    expect(yield* history.readPage("thread", "item", end)).toEqual({ text: "", nextCursor: null });
    yield* history.append("thread", "item", "second");
    expect(yield* history.readPage("thread", "item", end)).toEqual({
      text: "second",
      nextCursor: null,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("contains path-shaped identities and deletes only the selected thread", () =>
  Effect.gen(function* () {
    const history = yield* makeReasoningHistory;
    yield* history.append("../thread/../../outside", "../../item", "private thought");
    yield* history.append("other", "../../item", "other thought");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const entries = yield* fs.readDirectory(path.join(config.stateDir, "reasoning-history"));
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry).toMatch(/^[a-f0-9]{64}$/);
    expect(yield* history.readPage("../thread/../../outside", "../../item")).toEqual({
      text: "private thought",
      nextCursor: null,
    });
    yield* history.removeThread("../thread/../../outside");
    expect(
      yield* history.readPage("../thread/../../outside", "../../item").pipe(Effect.flip),
    ).toMatchObject({ reason: "missing" });
    expect(yield* history.readPage("other", "../../item")).toEqual({
      text: "other thought",
      nextCursor: null,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("bounds each stored history and rejects further writes at capacity", () =>
  Effect.gen(function* () {
    const history = yield* makeReasoningHistory;
    yield* history.append("thread", "item", "initial thought");
    expect(
      yield* history
        .append("thread", "item", "x".repeat(MAX_REASONING_HISTORY_BYTES))
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "capacity" });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const root = path.join(config.stateDir, "reasoning-history");
    const [threadDirectory] = yield* fs.readDirectory(root);
    const directory = path.join(root, threadDirectory!);
    const entry = (yield* fs.readDirectory(directory)).find((name) => name.endsWith(".jsonl"));
    const file = path.join(directory, entry!);
    const before = (yield* fs.stat(file)).size;
    expect(Number(before)).toBeLessThanOrEqual(MAX_REASONING_HISTORY_BYTES);
    expect(
      yield* history.append("thread", "item", "y".repeat(8_000)).pipe(Effect.flip),
    ).toMatchObject({ reason: "capacity" });
    expect((yield* fs.stat(file)).size).toBe(before);
    const page = yield* history.readPage("thread", "item");
    expect(page.truncated).toBe(true);
    expect(page.text.startsWith("initial thought")).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "enforces the thread budget after reopening without consuming another thread's budget",
  () =>
    Effect.gen(function* () {
      const writer = yield* makeReasoningHistory;
      yield* writer.append("thread", "existing", "saved");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const root = path.join(config.stateDir, "reasoning-history");
      const [threadDirectory] = yield* fs.readDirectory(root);
      const directory = path.join(root, threadDirectory!);
      const [entry] = yield* fs.readDirectory(directory);
      // Sparse existing storage exercises quota accounting without allocating 64 MiB.
      yield* fs.truncate(path.join(directory, entry!), MAX_THREAD_REASONING_HISTORY_BYTES);
      const reader = yield* makeReasoningHistory;
      expect(
        yield* reader.append("thread", "new", "must not grow").pipe(Effect.flip),
      ).toMatchObject({ reason: "capacity" });
      yield* reader.append("other", "new", "other thread");
      expect(yield* reader.readPage("other", "new")).toEqual({
        text: "other thread",
        nextCursor: null,
      });
    }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a torn JSONL tail instead of claiming complete history", () =>
  Effect.gen(function* () {
    const history = yield* makeReasoningHistory;
    yield* history.append("thread", "item", "complete prefix");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const root = path.join(config.stateDir, "reasoning-history");
    const [threadDirectory] = yield* fs.readDirectory(root);
    const directory = path.join(root, threadDirectory!);
    const [entry] = yield* fs.readDirectory(directory);
    yield* fs.writeFileString(path.join(directory, entry!), '"interrupted', { flag: "a" });
    expect(yield* history.readPage("thread", "item").pipe(Effect.flip)).toMatchObject({
      reason: "unavailable",
    });
  }).pipe(Effect.provide(testLayer)),
);
