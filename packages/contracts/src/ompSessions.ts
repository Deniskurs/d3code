import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const OmpSavedSession = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  title: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  threadId: Schema.optional(ThreadId),
});
export const OmpHistoryMessage = Schema.Struct({
  nativeId: Schema.optional(Schema.String),
  createdAt: Schema.optional(IsoDateTime),
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});
export type OmpHistoryMessage = typeof OmpHistoryMessage.Type;
export const OmpSessionsReadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  sessionId: Schema.optional(TrimmedNonEmptyString),
  cursor: Schema.optional(Schema.String),
});
export type OmpSessionsReadInput = typeof OmpSessionsReadInput.Type;
export const OmpSessionsReadResult = Schema.Struct({
  sessions: Schema.Array(OmpSavedSession),
  nextCursor: Schema.optional(Schema.String),
  messages: Schema.Array(OmpHistoryMessage),
  resumeCommand: Schema.optional(Schema.String),
  supportsFork: Schema.Boolean,
});
export type OmpSessionsReadResult = typeof OmpSessionsReadResult.Type;
export const OmpSessionsActionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  sessionId: TrimmedNonEmptyString,
  action: Schema.Literals(["open", "fork", "refresh", "handoff"]),
});
export type OmpSessionsActionInput = typeof OmpSessionsActionInput.Type;
export const OmpSessionsActionResult = Schema.Struct({
  threadId: ThreadId,
  sessionId: TrimmedNonEmptyString,
  resumeCommand: Schema.String,
  importedMessages: Schema.Number,
  completedAt: IsoDateTime,
});
export class OmpSessionsError extends Schema.TaggedError<OmpSessionsError>()("OmpSessionsError", {
  message: Schema.String,
}) {}
