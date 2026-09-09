import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

it.effect("unsigned D3 stays disabled without a release feed", () => {
  const harness = makeHarness({ env: { T3CODE_DESKTOP_MOCK_UPDATES: "false" } });
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      const state = yield* updates.getState;
      assert.equal(state.enabled, false);
      assert.equal(state.status, "disabled");
      assert.include(Option.getOrThrow(yield* updates.disabledReason), "no update feed");
      assert.equal(harness.checkCount(), 0);
      assert.deepEqual(harness.feedUrls(), []);
    }),
  ).pipe(Effect.provide(harness.layer));
});

it("accepts only the D3 release feed", () => {
  assert.equal(
    DesktopUpdates.isD3UpdateFeed({ provider: "github", owner: "Deniskurs", repo: "d3code" }),
    true,
  );
  assert.equal(
    DesktopUpdates.isD3UpdateFeed({ provider: "github", owner: "pingdotgg", repo: "t3code" }),
    false,
  );
  assert.equal(
    DesktopUpdates.isD3UpdateFeed({ provider: "generic", url: "https://example.com" }),
    false,
  );
});
