// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type OmpSteeringContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

// ACP has no steering method. This session-local extension uses OMP's public
// extension API, while ACP continues to own approvals, events and cancellation.
export function ompSteeringExtension(socketPath: string, token: string): string {
  return `import { createServer } from "node:http";
export default function(pi) {
  let context;
  let activeTurnId;
  const server = createServer(async (req, res) => {
    const reply = (status) => { res.writeHead(status); res.end(); };
    if (req.method !== "POST" || !["/steer", "/turn", "/history"].includes(req.url) || req.headers.authorization !== ${JSON.stringify(token)}) {
      reply(403); return;
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
      if (req.url === "/turn") { activeTurnId = turnId; reply(204); return; }
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
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", () => { context = undefined; server.close(); });
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
    beginTurn: (turnId: string, signal?: AbortSignal) => sendRequest("/turn", { turnId }, signal),
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
