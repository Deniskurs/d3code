import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

it.effect(
  "repairs a saved Nightly selection and discovers Devis updates on the published feed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const resourcesPath = yield* fs.makeTempDirectoryScoped({ prefix: "d3-update-feed-" });
        yield* fs.writeFileString(
          `${resourcesPath}/app-update.yml`,
          "provider: github\nowner: Deniskurs\nrepo: d3code\n",
        );
        const harness = makeHarness({
          resourcesPath,
          env: { T3CODE_DESKTOP_MOCK_UPDATES: "false" },
        });
        yield* Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* settings.setUpdateChannel("nightly");
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.equal((yield* settings.get).updateChannel, "latest");
          assert.equal((yield* updates.getState).channel, "latest");
          assert.deepEqual(harness.channels(), ["latest"]);
          assert.equal(harness.fullChangelog(), true);
          assert.equal((yield* updates.setChannel("nightly")).channel, "latest");
          assert.equal((yield* settings.get).updateChannel, "latest");
          const result = yield* updates.check("manual");
          assert.equal(result.checked, true);
          assert.equal(harness.checkCount(), 1);
          harness.emit("update-available", {
            version: "1.2.4",
            releaseNotes: [
              {
                version: "1.2.4",
                note: "## Changes\n- New Devis theme\n- Shared steering controls",
              },
            ],
          });
          yield* flushCallbacks;
          const state = yield* updates.getState;
          assert.equal(state.status, "available");
          assert.equal(state.availableVersion, "1.2.4");
          assert.deepEqual(state.releaseNotes, [
            {
              version: "1.2.4",
              items: ["Shared steering controls", "New Devis theme"],
              totalItems: 2,
            },
          ]);
          assert.deepEqual(harness.sentStates.at(-1)?.releaseNotes, state.releaseNotes);
        }).pipe(Effect.provide(harness.layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

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
