import * as NodeCrypto from "node:crypto";
import type { ReasoningHistoryPage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ServerConfig } from "../config.ts";

export const REASONING_HISTORY_PAGE_BYTES = 64 * 1024;
export const MAX_REASONING_HISTORY_BYTES = 8 * 1024 * 1024;
export const MAX_THREAD_REASONING_HISTORY_BYTES = 64 * 1024 * 1024;
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** JSON escaping expands each UTF-16 code unit to at most six bytes. */
export function* splitReasoningDelta(text: string) {
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 8_000, text.length);
    const last = text.charCodeAt(end - 1);
    if (
      end < text.length &&
      last >= 0xd800 &&
      last <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 &&
      text.charCodeAt(end) <= 0xdfff
    )
      end--;
    yield text.slice(start, end);
    start = end;
  }
}

export class ReasoningHistoryError extends Schema.TaggedError<ReasoningHistoryError>()(
  "ReasoningHistoryError",
  {
    reason: Schema.Literals(["missing", "invalid_cursor", "unavailable", "capacity"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const makeReasoningHistory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const directory = path.join(config.stateDir, "reasoning-history");
  const threadDirectory = (threadId: string) =>
    path.join(directory, NodeCrypto.createHash("sha256").update(threadId).digest("hex"));
  const filename = (threadId: string, itemId: string) =>
    path.join(
      threadDirectory(threadId),
      `${NodeCrypto.createHash("sha256").update(itemId).digest("hex")}.jsonl`,
    );
  const threadBytes = new Map<string, number>();

  const append = Effect.fn("ReasoningHistory.append")(function* (
    threadId: string,
    itemId: string,
    delta: string,
  ) {
    if (!delta) return;
    yield* fs.makeDirectory(threadDirectory(threadId), { recursive: true });
    if (yield* fs.exists(`${filename(threadId, itemId)}.truncated`)) {
      return yield* new ReasoningHistoryError({ reason: "capacity" });
    }
    let total = threadBytes.get(threadId);
    if (total === undefined) {
      total = 0;
      for (const entry of yield* fs.readDirectory(threadDirectory(threadId))) {
        if (entry.endsWith(".jsonl")) {
          total += Number((yield* fs.stat(path.join(threadDirectory(threadId), entry))).size);
        }
      }
      threadBytes.set(threadId, total);
    }
    const file = yield* fs.open(filename(threadId, itemId), { flag: "a", mode: 0o600 });
    let size = Number((yield* file.stat).size);
    for (const record of splitReasoningDelta(delta)) {
      const bytes = Buffer.from(`${encodeRecord(record)}\n`, "utf8");
      if (
        size + bytes.byteLength > MAX_REASONING_HISTORY_BYTES ||
        total + bytes.byteLength > MAX_THREAD_REASONING_HISTORY_BYTES
      ) {
        yield* fs.writeFileString(`${filename(threadId, itemId)}.truncated`, "", { mode: 0o600 });
        return yield* new ReasoningHistoryError({ reason: "capacity" });
      }
      yield* file.writeAll(bytes);
      size += bytes.byteLength;
      total += bytes.byteLength;
      threadBytes.set(threadId, total);
    }
  }, Effect.scoped);

  const remove = Effect.fn("ReasoningHistory.remove")(function* (threadId: string, itemId: string) {
    yield* fs.remove(filename(threadId, itemId), { force: true });
    yield* fs.remove(`${filename(threadId, itemId)}.truncated`, { force: true });
    threadBytes.delete(threadId);
  });

  const removeThread = Effect.fn("ReasoningHistory.removeThread")(function* (threadId: string) {
    yield* fs.remove(threadDirectory(threadId), { force: true, recursive: true });
    threadBytes.delete(threadId);
  });

  const readPage = Effect.fn("ReasoningHistory.readPage")(function* (
    threadId: string,
    itemId: string,
    cursor = 0,
  ): Effect.fn.Return<ReasoningHistoryPage, ReasoningHistoryError, Scope.Scope> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return yield* new ReasoningHistoryError({ reason: "invalid_cursor" });
    }
    const file = yield* fs.open(filename(threadId, itemId)).pipe(
      Effect.mapError(
        (cause) =>
          new ReasoningHistoryError({
            reason: cause.reason._tag === "NotFound" ? "missing" : "unavailable",
            cause,
          }),
      ),
    );
    const info = yield* file.stat.pipe(
      Effect.mapError((cause) => new ReasoningHistoryError({ reason: "unavailable", cause })),
    );
    const size = Number(info.size);
    if (!Number.isSafeInteger(size))
      return yield* new ReasoningHistoryError({ reason: "unavailable" });
    if (cursor > size) return yield* new ReasoningHistoryError({ reason: "invalid_cursor" });
    // Include the preceding newline in the same bounded read to validate record alignment.
    const start = cursor === 0 ? 0 : cursor - 1;
    yield* file.seek(start, "start");
    const bytes = new Uint8Array(Math.min(REASONING_HISTORY_PAGE_BYTES, size - start));
    let count = 0;
    while (count < bytes.length) {
      const n = Number(
        yield* file
          .read(bytes.subarray(count))
          .pipe(
            Effect.mapError((cause) => new ReasoningHistoryError({ reason: "unavailable", cause })),
          ),
      );
      if (n === 0) break;
      count += n;
    }
    const offset = cursor === 0 ? 0 : 1;
    if (offset && bytes[0] !== 10)
      return yield* new ReasoningHistoryError({ reason: "invalid_cursor" });
    const available = bytes.subarray(offset, count);
    const lastNewline = available.lastIndexOf(10);
    if (lastNewline < 0) {
      if (cursor === size && cursor > 0) return { text: "", nextCursor: null };
      return yield* new ReasoningHistoryError({ reason: "unavailable" });
    }
    const text = yield* Effect.try({
      try: () =>
        Buffer.from(available.subarray(0, lastNewline))
          .toString("utf8")
          .split("\n")
          .map((record) => decodeRecord(record))
          .join(""),
      catch: (cause) => new ReasoningHistoryError({ reason: "unavailable", cause }),
    });
    const next = cursor + lastNewline + 1;
    // An incomplete tail is not published as a complete history page.
    if (count === bytes.length && start + count === size && next !== size) {
      return yield* new ReasoningHistoryError({ reason: "unavailable" });
    }
    const truncated = yield* fs
      .exists(`${filename(threadId, itemId)}.truncated`)
      .pipe(
        Effect.mapError((cause) => new ReasoningHistoryError({ reason: "unavailable", cause })),
      );
    return {
      text,
      nextCursor: next < size ? next : null,
      ...(truncated ? { truncated: true } : {}),
    };
  }, Effect.scoped);

  return { append, remove, removeThread, readPage };
});
