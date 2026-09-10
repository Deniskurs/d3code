import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { findOmpSession } from "./ompSessionDiscovery.ts";

describe("OMP session discovery", () => {
  it.effect("finds an exact ID on older pages in a different project", () =>
    Effect.gen(function* () {
      const cursors: Array<string | undefined> = [];
      const wanted = { sessionId: "native-id", cwd: "/another/project", title: "Ambiguous title" };
      const result = yield* findOmpSession("native-id", (cursor) => {
        cursors.push(cursor);
        return Effect.succeed(
          cursor === "older"
            ? { sessions: [wanted] }
            : { sessions: [{ ...wanted, sessionId: "native-id-other" }], nextCursor: "older" },
        );
      });
      expect(result).toEqual(wanted);
      expect(cursors).toEqual([undefined, "older"]);
    }),
  );
  it.effect("stops when OMP repeats a pagination cursor", () =>
    Effect.gen(function* () {
      let calls = 0;
      const failure = yield* Effect.flip(
        findOmpSession("missing", () => {
          calls++;
          return Effect.succeed({ sessions: [], nextCursor: "repeated" });
        }),
      );
      expect(calls).toBe(2);
      expect(failure.message).toContain("selected OMP profile");
    }),
  );
  it.effect("reports a missing session without selecting a similarly named one", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        findOmpSession("exact-id", () =>
          Effect.succeed({
            sessions: [{ sessionId: "other-id", cwd: "/project", title: "exact-id" }],
          }),
        ),
      );
      expect(failure.message).toContain("not found");
    }),
  );
});
