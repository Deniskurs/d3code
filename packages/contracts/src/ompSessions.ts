import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const OmpSavedSession = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  title: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  threadId: Schema.optional(ThreadId),
  terminalHandoff: Schema.optional(Schema.Boolean),
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
  scope: Schema.optional(Schema.Literals(["project", "all"])),
});
export type OmpSessionsReadInput = typeof OmpSessionsReadInput.Type;
export const OmpSessionsReadResult = Schema.Struct({
  sessions: Schema.Array(OmpSavedSession),
  nextCursor: Schema.optional(Schema.String),
  messages: Schema.Array(OmpHistoryMessage),
  resumeCommand: Schema.optional(Schema.String),
  supportsFork: Schema.Boolean,
  supportsTerminal: Schema.optional(Schema.Boolean),
  currentSession: Schema.optional(OmpSavedSession),
});
export type OmpSessionsReadResult = typeof OmpSessionsReadResult.Type;
export const OmpSessionsActionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  sessionId: TrimmedNonEmptyString,
  action: Schema.Literals(["open", "fork", "refresh", "handoff", "terminal"]),
  terminalId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type OmpSessionsActionInput = typeof OmpSessionsActionInput.Type;
export const OmpSessionsActionResult = Schema.Struct({
  threadId: ThreadId,
  sessionId: TrimmedNonEmptyString,
  resumeCommand: Schema.String,
  importedMessages: Schema.Number,
  completedAt: IsoDateTime,
  terminalId: Schema.optional(Schema.String),
});
export class OmpSessionsError extends Schema.TaggedError<OmpSessionsError>()("OmpSessionsError", {
  message: Schema.String,
}) {}
