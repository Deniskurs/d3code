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
    if (req.method !== "POST" || (req.url !== "/steer" && req.url !== "/turn") || req.headers.authorization !== ${JSON.stringify(token)}) {
      reply(403); return;
    }
    req.setEncoding("utf8");
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 128 * 1024 * 1024) { reply(413); return; }
      }
      const { content, turnId } = JSON.parse(body);
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
    send: (content: ReadonlyArray<OmpSteeringContent>, turnId: string, signal?: AbortSignal) =>
      sendRequest("/steer", { content, turnId }, signal),
  };
}
