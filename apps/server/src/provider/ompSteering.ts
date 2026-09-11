// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { AdvisorFindingNote } from "@t3tools/contracts";

const OmpTurnOutcome = Schema.Struct({
  turnId: Schema.String,
  stopReason: Schema.String,
  errorMessage: Schema.optional(Schema.String),
});
export type OmpTurnOutcome = typeof OmpTurnOutcome.Type;
const decodeOmpTurnOutcome = Schema.decodeUnknownSync(Schema.NullOr(OmpTurnOutcome));

const OmpAdvisorFindings = Schema.Struct({
  bridgeId: Schema.NonEmptyString,
  sequence: Schema.Int,
  sessionId: Schema.NonEmptyString,
  timestamp: Schema.Number,
  notes: Schema.Array(AdvisorFindingNote),
});
export type OmpAdvisorFindings = typeof OmpAdvisorFindings.Type;
const decodeOmpAdvisorFindings = Schema.decodeUnknownSync(OmpAdvisorFindings);
const ADVISOR_FRAME_BYTES = 64 * 1024;
const ADVISOR_BACKLOG_BYTES = 256 * 1024;

export type OmpSteeringContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

// Preserve OMP features ACP omits through one session-local public-API extension.
// ACP remains responsible for prompts, approvals, tool events and cancellation.
export function ompSteeringExtension(socketPath: string, token: string): string {
  return `import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
export default function(pi) {
  let context;
  let activeTurnId;
  let turnStart;
  const bridgeId = randomUUID();
  let sequence = 0;
  let advisory;
  let advisoryFailure;
  let advisoryBlocked = false;
  let pending = [];
  let pendingBytes = 0;
  const clearPending = () => { pending = []; pendingBytes = 0; };
  const failAdvisories = () => {
    advisoryFailure = "OMP advisor findings exceeded the delivery buffer limit.";
    clearPending();
    if (advisory && !advisory.destroyed) advisory.end(JSON.stringify({ error: advisoryFailure }) + "\\n");
  };
  const flushAdvisories = () => {
    while (advisory && !advisory.destroyed && !advisory.writableEnded && !advisoryBlocked && pending.length) {
      const frame = pending.shift();
      pendingBytes -= frame.length;
      advisoryBlocked = !advisory.write(frame);
    }
  };
  const server = createServer(async (req, res) => {
    const reply = (status) => { res.writeHead(status); res.end(); };
    if (req.method !== "POST" || !["/steer", "/turn", "/history", "/outcome", "/advisories"].includes(req.url) || req.headers.authorization !== ${JSON.stringify(token)}) {
      reply(403); return;
    }
    if (req.url === "/advisories") {
      req.resume();
      if (advisoryFailure) { reply(503); return; }
      if (advisory && !advisory.destroyed && !advisory.writableEnded) { reply(409); return; }
      advisory = res;
      advisoryBlocked = false;
      res.on("error", () => {});
      // A replaced response can still emit close/drain; it no longer owns the stream.
      res.on("close", () => { if (advisory === res) { advisory = undefined; advisoryBlocked = false; } });
      res.on("drain", () => { if (advisory === res) { advisoryBlocked = false; flushAdvisories(); } });
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      res.flushHeaders();
      res.write("\\n");
      flushAdvisories();
      return;
    }
    req.setEncoding("utf8");
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 128 * 1024 * 1024) { reply(413); return; }
      }
      const { content, turnId, sessionId } = JSON.parse(body);
      if (req.url === "/history") {
        if (!context || !context.isIdle() || context.sessionManager.getSessionId() !== sessionId) { reply(409); return; }
        const branch = context.sessionManager.getBranch();
        const messages = branch.flatMap(entry => {
          if (entry.type !== "message" || !["user", "assistant"].includes(entry.message.role)) return [];
          const content = entry.message.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap(part => part.type === "text" ? [part.text] : part.type === "image" ? ["[Image attachment]"] : []).join("") : "";
          return text.trim() ? [{ nativeId: entry.id, role: entry.message.role, text, createdAt: entry.timestamp }] : [];
        });
        const previousModel = [...branch].reverse().find(entry => entry.type === "model_change" || entry.type === "message" && entry.message.role === "assistant" && entry.message.provider && entry.message.model);
        const model = context.model ? context.model.provider + "/" + context.model.id : previousModel?.type === "model_change" ? previousModel.provider + "/" + previousModel.modelId : previousModel?.message ? previousModel.message.provider + "/" + previousModel.message.model : undefined;
        const payload = JSON.stringify({ sessionId, messages, ...(model ? { model } : {}) });
        if (payload.length > 8_000_000) { reply(413); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(payload); return;
      }
      if (typeof turnId !== "string" || !turnId) { reply(400); return; }
      if (req.url === "/turn") {
        if (!context?.sessionManager) { reply(409); return; }
        activeTurnId = turnId;
        turnStart = { sessionId: context.sessionManager.getSessionId(), leafId: context.sessionManager.getLeafId() };
        reply(204); return;
      }
      if (req.url === "/outcome") {
        if (turnId !== activeTurnId || !turnStart || !context?.isIdle() || context.sessionManager.getSessionId() !== turnStart.sessionId) { reply(409); return; }
        const manager = context.sessionManager;
        let entryId = manager.getLeafId();
        let message;
        // ACP settles after native persistence, but agent_end extension callbacks can still lag.
        // Stay within this prompt's ancestry so retries use the final message and old errors cannot leak.
        while (entryId !== turnStart.leafId) {
          if (entryId === null) { reply(409); return; }
          const entry = manager.getEntry(entryId);
          if (!entry) { reply(409); return; }
          if (!message && entry.type === "message" && entry.message.role === "assistant") message = entry.message;
          entryId = entry.parentId;
        }
        const outcome = message ? { turnId, stopReason: message.stopReason, ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}) } : null;
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(outcome)); return;
      }
      if (!Array.isArray(content) || !content.length || !content.every(part =>
        part && (part.type === "text" && typeof part.text === "string" ||
          part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"))) {
        reply(400); return;
      }
      if (turnId !== activeTurnId || !context || context.isIdle()) { reply(409); return; }
      pi.sendUserMessage(content, { deliverAs: "steer" });
      reply(204);
    } catch { reply(500); }
  });
  server.on("error", () => {});
  server.listen(${JSON.stringify(socketPath)});
  server.unref();
  pi.on("session_start", (_event, ctx) => { context = ctx; activeTurnId = undefined; turnStart = undefined; });
  // message_end precedes persistence: only the public displayed notes and emission-time session
  // identity are available here. Never inspect entry IDs or the advisor's private conversation.
  pi.on("message_end", (event, ctx) => {
    const message = event?.message;
    if (advisoryFailure || message?.role !== "custom" || message.customType !== "advisor" || message.display !== true || !Array.isArray(message.details?.notes)) return;
    const sessionId = (ctx ?? context)?.sessionManager?.getSessionId();
    if (typeof sessionId !== "string" || !sessionId || !Number.isFinite(message.timestamp) || Math.abs(message.timestamp) > 8.64e15) return;
    const notes = [];
    let bytes = 0;
    for (const item of message.details.notes) {
      if (!item || typeof item.note !== "string" || !item.note) continue;
      bytes += Buffer.byteLength(item.note) + (typeof item.advisor === "string" ? Buffer.byteLength(item.advisor) : 0);
      if (bytes > ${ADVISOR_FRAME_BYTES} || notes.length >= 256) { failAdvisories(); return; }
      notes.push({
        note: item.note,
        ...(["nit", "concern", "blocker"].includes(item.severity) ? { severity: item.severity } : {}),
        ...(typeof item.advisor === "string" ? { advisor: item.advisor } : {}),
      });
    }
    if (!notes.length) return;
    const frame = Buffer.from(JSON.stringify({ bridgeId, sequence: ++sequence, sessionId, timestamp: message.timestamp, notes }) + "\\n");
    // Keep unsent findings across disconnects, bounded like the pre-subscription backlog.
    // Written bytes have no acknowledgement/replay; overflow disables only this observer.
    if (frame.length > ${ADVISOR_FRAME_BYTES} || pendingBytes + frame.length > ${ADVISOR_BACKLOG_BYTES}) { failAdvisories(); return; }
    pending.push(frame);
    pendingBytes += frame.length;
    flushAdvisories();
  });
  pi.on("session_shutdown", () => { context = undefined; clearPending(); advisory?.end(); server.close(); });
  return server;
}
`;
}

export async function createOmpSteering(platform: NodeJS.Platform) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d3-omp-"));
  const token = NodeCrypto.randomUUID();
  const socketPath =
    platform === "win32" ? `\\\\.\\pipe\\d3-omp-${token}` : NodePath.join(directory, "steer.sock");
  const extensionPath = NodePath.join(directory, "steering.mjs");
  try {
    await NodeFSP.writeFile(extensionPath, ompSteeringExtension(socketPath, token), {
      mode: 0o600,
    });
  } catch (error) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw error;
  }
  const sendRequest = (path: string, payload: unknown, signal?: AbortSignal) =>
    new Promise<boolean>((resolve, reject) => {
      const req = NodeHttp.request(
        {
          socketPath,
          path,
          method: "POST",
          signal,
          headers: { authorization: token, "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          if (res.statusCode === 204) resolve(true);
          else if (res.statusCode === 409) resolve(false);
          else reject(new Error("OMP could not accept the steering message."));
        },
      );
      req.setTimeout(5000, () => req.destroy(new Error("OMP steering did not respond.")));
      req.on("error", (error: NodeJS.ErrnoException) => {
        // Older OMP installations may not load the extension. Preserve the
        // existing serialized ACP queue in that case, without cancelling work.
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
        else reject(error);
      });
      req.end(JSON.stringify(payload));
    });
  return {
    extensionPath,
    close: () => NodeFSP.rm(directory, { recursive: true, force: true }),
    watchAdvisorFindings: async (
      onFindings: (frame: OmpAdvisorFindings) => Promise<void>,
      signal: AbortSignal,
    ): Promise<void> => {
      const watch = async (mayReconnect: boolean): Promise<boolean> => {
        if (signal.aborted) return false;
        let response: NodeHttp.IncomingMessage | undefined;
        let callbackFailed = false;
        let pending = Buffer.alloc(0);
        const req = NodeHttp.request({
          socketPath,
          path: "/advisories",
          method: "POST",
          headers: { authorization: token, "content-type": "application/json" },
        });
        const abort = () => {
          response?.destroy();
          req.destroy(new Error("OMP advisor findings stream was cancelled."));
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          response = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
            req.once("response", resolve);
            req.once("error", reject);
            req.setTimeout(5000, () =>
              req.destroy(new Error("OMP advisor findings stream did not respond.")),
            );
            req.end("{}");
          });
          req.setTimeout(0);
          if (response.statusCode !== 200) {
            throw new Error(`OMP advisor findings stream was rejected (${response.statusCode}).`);
          }
          for await (const chunk of response) {
            if (signal.aborted) return false;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            let offset = 0;
            while (offset < bytes.length) {
              const newline = bytes.indexOf(10, offset);
              const end = newline === -1 ? bytes.length : newline;
              const part = bytes.subarray(offset, end);
              if (pending.length + part.length > ADVISOR_FRAME_BYTES) {
                throw new Error("OMP advisor findings frame exceeds the delivery limit.");
              }
              const frame = pending.length ? Buffer.concat([pending, part]) : part;
              if (newline === -1) {
                pending = Buffer.from(frame);
                break;
              }
              pending = Buffer.alloc(0);
              offset = newline + 1;
              if (!frame.length) continue; // The handshake is an empty NDJSON line.
              let findings: OmpAdvisorFindings;
              try {
                findings = decodeOmpAdvisorFindings(JSON.parse(frame.toString("utf8")));
                if (
                  findings.sequence < 1 ||
                  !Number.isFinite(findings.timestamp) ||
                  Math.abs(findings.timestamp) > 8.64e15 ||
                  !findings.notes.length
                ) {
                  throw new Error("Invalid advisor findings.");
                }
              } catch {
                throw new Error("OMP returned invalid advisor findings.");
              }
              if (signal.aborted) return false;
              try {
                await onFindings(findings);
              } catch (error) {
                callbackFailed = true;
                throw error;
              }
            }
          }
          if (pending.length) throw new Error("OMP returned an incomplete advisor findings frame.");
          // Native shutdown ends the HTTP response normally. Only transport failure reconnects.
          return false;
        } catch (error) {
          if (signal.aborted) return false;
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (!response && (code === "ENOENT" || code === "ECONNREFUSED")) return false;
          if (
            mayReconnect &&
            response?.statusCode === 200 &&
            !callbackFailed &&
            !pending.length &&
            (code === "ECONNRESET" ||
              code === "EPIPE" ||
              code === "ETIMEDOUT" ||
              code === "ERR_STREAM_PREMATURE_CLOSE")
          ) {
            return true;
          }
          throw error;
        } finally {
          signal.removeEventListener("abort", abort);
          response?.destroy();
          req.destroy();
        }
      };
      // One replacement observer only: never retry primary OMP work or poll for availability.
      if (await watch(true)) await watch(false);
    },
    beginTurn: (turnId: string, signal?: AbortSignal) => sendRequest("/turn", { turnId }, signal),
    readOutcome: (turnId: string, signal?: AbortSignal) =>
      new Promise<OmpTurnOutcome | null>((resolve, reject) => {
        const failure = () =>
          new Error("OMP could not verify the turn outcome. Check the output before retrying.");
        const req = NodeHttp.request(
          {
            socketPath,
            path: "/outcome",
            method: "POST",
            signal,
            headers: { authorization: token, "content-type": "application/json" },
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(failure());
              return;
            }
            res.setEncoding("utf8");
            let body = "";
            res.on("data", (chunk: string) => {
              body += chunk;
              if (body.length > 8_000_000) req.destroy(failure());
            });
            res.on("error", reject);
            res.on("end", () => {
              try {
                const outcome = decodeOmpTurnOutcome(JSON.parse(body));
                if (outcome !== null && outcome.turnId !== turnId) throw failure();
                resolve(outcome);
              } catch {
                reject(failure());
              }
            });
          },
        );
        req.setTimeout(5000, () => req.destroy(failure()));
        req.on("error", reject);
        req.end(JSON.stringify({ turnId }));
      }),
    readHistory: (sessionId: string, signal?: AbortSignal) =>
      new Promise<unknown>((resolve, reject) => {
        const req = NodeHttp.request(
          {
            socketPath,
            path: "/history",
            method: "POST",
            signal,
            headers: { authorization: token, "content-type": "application/json" },
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(
                new Error(
                  "OMP could not read this session's history. Close any other OMP process using it and try again.",
                ),
              );
              return;
            }
            res.setEncoding("utf8");
            let body = "";
            res.on("data", (chunk: string) => {
              body += chunk;
              if (body.length > 8_000_000)
                req.destroy(new Error("OMP history exceeds the import limit."));
            });
            res.on("error", reject);
            res.on("end", () => {
              try {
                resolve(JSON.parse(body));
              } catch {
                reject(new Error("OMP returned invalid session history."));
              }
            });
          },
        );
        req.setTimeout(10_000, () => req.destroy(new Error("OMP history did not respond.")));
        req.on("error", reject);
        req.end(JSON.stringify({ sessionId }));
      }),
    send: (content: ReadonlyArray<OmpSteeringContent>, turnId: string, signal?: AbortSignal) =>
      sendRequest("/steer", { content, turnId }, signal),
  };
}
