import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

it.effect("D3 refuses automatic updates even with an official feed configured", () => {
  const harness = makeHarness();
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      const state = yield* updates.getState;
      assert.equal(state.enabled, false);
      assert.equal(state.status, "disabled");
      assert.include(Option.getOrThrow(yield* updates.disabledReason), "D3 Code");
      assert.equal(harness.checkCount(), 0);
      assert.deepEqual(harness.feedUrls(), []);
    }),
  ).pipe(Effect.provide(harness.layer));
});
