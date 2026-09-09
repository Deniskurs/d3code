import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { resolveGitHubPublishConfig } from "./build-desktop-artifact.ts";

it.effect("D3 artifacts never acquire the official update feed from CI environment variables", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveGitHubPublishConfig("nightly"), undefined);
    assert.equal(yield* resolveGitHubPublishConfig("latest"), undefined);
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            GITHUB_REPOSITORY: "pingdotgg/t3code",
            T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
          },
        }),
      ),
    ),
  ),
);
