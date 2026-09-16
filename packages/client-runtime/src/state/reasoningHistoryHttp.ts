import type { ReasoningHistoryInput, ReasoningHistoryPage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export const fetchEnvironmentReasoningHistory = Effect.fn(
  "clientRuntime.state.fetchEnvironmentReasoningHistory",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly history: ReasoningHistoryInput;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}) {
  const { threadId, itemId, cursor } = input.history;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(
        httpBaseUrl,
        `/api/orchestration/threads/${encodeURIComponent(threadId)}/reasoning/${encodeURIComponent(itemId)}`,
      ),
    timeoutMs: 30_000,
    request: ({ client, headers }) =>
      client.reasoningHistory({
        params: { threadId, itemId },
        payload: cursor === undefined ? {} : { cursor },
        headers,
      }),
  });
});

export class ReasoningHistoryLoader extends Context.Service<
  ReasoningHistoryLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      input: ReasoningHistoryInput,
    ) => Effect.Effect<ReasoningHistoryPage, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/reasoningHistoryHttp/ReasoningHistoryLoader") {}

export const reasoningHistoryLoaderLayer: Layer.Layer<
  ReasoningHistoryLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ReasoningHistoryLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return ReasoningHistoryLoader.of({
      load: (prepared, history) =>
        fetchEnvironmentReasoningHistory({ prepared, history, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
