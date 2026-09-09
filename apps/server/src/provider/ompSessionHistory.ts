import type { OmpHistoryMessage } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export function hasOmpTerminalHandoff(payload: unknown): boolean {
  return (
    Predicate.isObject(payload) &&
    "ompTerminalHandoff" in payload &&
    payload.ompTerminalHandoff === true
  );
}

/** These built-ins open native terminal UI and are not advertised over ACP. */
export function ompTerminalOnlyCommand(input: string | undefined): string | undefined {
  const name = /^\/([a-z-]+)(?:\s|$)/i.exec(input?.trim() ?? "")?.[1]?.toLowerCase();
  return name &&
    [
      "tree",
      "branch",
      "rewind",
      "fork",
      "resume",
      "new",
      "login",
      "logout",
      "settings",
      "setup",
      "agents",
      "hub",
      "extensions",
      "status",
      "git",
      "quit",
      "exit",
    ].includes(name)
    ? name
    : undefined;
}

/** Only append a verified suffix. A changed native branch must never overwrite a D3 chat. */
export function reconcileOmpHistory(
  current: ReadonlyArray<OmpHistoryMessage>,
  native: ReadonlyArray<OmpHistoryMessage>,
): ReadonlyArray<OmpHistoryMessage> {
  if (
    current.length > native.length ||
    current.some((message, index) => {
      const other = native[index];
      return (
        !other ||
        message.role !== other.role ||
        message.text.replaceAll("\r\n", "\n").trim() !== other.text.replaceAll("\r\n", "\n").trim()
      );
    })
  ) {
    throw new Error(
      "The native history differs from this D3 conversation. No messages were changed. Open a fork to view that history separately.",
    );
  }
  return native.slice(current.length);
}

export function quoteOmpShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function ompResumeCommand(input: {
  cwd: string;
  binaryPath: string;
  launchArgs: string;
  environment: Readonly<Record<string, string | undefined>>;
  sessionId: string;
}): string {
  const assignments = ["PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PI_PROFILE"].flatMap((name) =>
    input.environment[name] ? [`${name}=${quoteOmpShellArgument(input.environment[name])}`] : [],
  );
  const args = tokenizeCliArgs(input.launchArgs);
  const sessionArgs: string[] = [];
  // Preserve session discovery and extensions without copying credentials into the UI.
  const selectors = new Set(["--profile", "--session-dir", "--config", "--extension", "-e"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const name = arg.split("=", 1)[0]!;
    if (!selectors.has(name)) continue;
    if (arg.includes("=")) sessionArgs.push(arg);
    else if (args[index + 1] && !args[index + 1]!.startsWith("-")) {
      sessionArgs.push(arg, args[++index]!);
    }
  }
  const command = [input.binaryPath, ...sessionArgs, "--resume", input.sessionId].map(
    quoteOmpShellArgument,
  );
  return `cd ${quoteOmpShellArgument(input.cwd)} && ${[...assignments, ...command].join(" ")}`;
}
