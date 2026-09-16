import type { ReasoningHistoryInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ReasoningHistoryLoader } from "./reasoningHistoryHttp.ts";
import { createEnvironmentCommand } from "./runtime.ts";

export { reasoningHistoryLoaderLayer } from "./reasoningHistoryHttp.ts";

export class ReasoningHistoryConnectionNotReadyError extends Schema.TaggedError<ReasoningHistoryConnectionNotReadyError>()(
  "ReasoningHistoryConnectionNotReadyError",
  { message: Schema.String },
) {}

/** Each page is an explicit command, not a subscribed or refreshing query. */
export function createReasoningHistoryCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ReasoningHistoryLoader | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:reasoning-history",
    execute: Effect.fn("clientRuntime.state.loadReasoningHistory")(function* (
      input: ReasoningHistoryInput,
    ) {
      const supervisor = yield* EnvironmentSupervisor;
      const loader = yield* ReasoningHistoryLoader;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) {
        return yield* new ReasoningHistoryConnectionNotReadyError({
          message: "The environment HTTP connection is not ready. Reconnect and retry.",
        });
      }
      return yield* loader.load(prepared.value, input);
    }),
  });
}
