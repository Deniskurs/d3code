import { describe, expect, it } from "@effect/vitest";
import {
  hasOmpTerminalHandoff,
  ompTerminalOnlyCommand,
  ompResumeCommand,
  quoteOmpShellArgument,
  reconcileOmpHistory,
} from "./ompSessionHistory.ts";
import { nativeCommands } from "./acp/nativeCommands.ts";

describe("OMP session reconciliation", () => {
  const first = { role: "user" as const, text: "Remember this conversation" };
  const answer = { role: "assistant" as const, text: "Remembered" };
  it("imports only the new suffix and makes repeated refreshes idempotent", () => {
    const native = [first, answer, first];
    expect(reconcileOmpHistory([first, answer], native)).toEqual([first]);
    expect(reconcileOmpHistory(native, native)).toEqual([]);
  });
  it("rejects changed branches, missing history, and role changes", () => {
    expect(() => reconcileOmpHistory([first, answer], [first])).toThrow("differs");
    expect(() => reconcileOmpHistory([first], [{ ...first, text: "Different branch" }])).toThrow(
      "differs",
    );
    expect(() => reconcileOmpHistory([first], [{ ...first, role: "assistant" }])).toThrow(
      "differs",
    );
  });
  it("quotes terminal arguments without interpolating shell syntax", () => {
    expect(quoteOmpShellArgument("a'b $(echo nope) `echo nope`")).toBe(
      "'a'\\''b $(echo nope) `echo nope`'",
    );
  });
  it("preserves custom session locations and profiles without exposing credential arguments", () => {
    const command = ompResumeCommand({
      cwd: "/my project",
      binaryPath: "/custom/omp",
      launchArgs:
        '--profile work --session-dir "/saved sessions" --config=config.json --extension ./tools.ts --api-key private-value',
      environment: { PI_CODING_AGENT_DIR: "/custom profile", API_KEY: "private-value" },
      sessionId: "native-id",
    });
    expect(command).toContain("cd '/my project' && PI_CODING_AGENT_DIR='/custom profile'");
    expect(command).toContain("'/custom/omp' '--profile' 'work' '--session-dir' '/saved sessions'");
    expect(command).toContain(
      "'--config=config.json' '--extension' './tools.ts' '--resume' 'native-id'",
    );
    expect(command).not.toContain("private-value");
  });
  it("replaces only the dedicated terminal shell and preserves its profile", () => {
    const command = ompResumeCommand({
      cwd: "/my project",
      binaryPath: "/custom/omp",
      launchArgs: "--profile work",
      environment: { PI_CODING_AGENT_DIR: "/my profile" },
      sessionId: "native-id",
      replaceShell: true,
    });
    expect(command).toBe(
      "cd '/my project' && exec env PI_CODING_AGENT_DIR='/my profile' '/custom/omp' '--profile' 'work' '--resume' 'native-id'",
    );
  });
  it("keeps native descriptions and argument hints while removing duplicates", () => {
    expect(
      nativeCommands([
        { name: "model", description: " Choose model ", input: { hint: "[name]" } },
        { name: "model", description: "duplicate" },
        { name: " ", description: "empty" },
      ]),
    ).toEqual([{ name: "model", description: "Choose model", input: { hint: "[name]" } }]);
  });
  it("recognizes terminal handoff and keeps terminal-only commands out of model prompts", () => {
    expect(hasOmpTerminalHandoff({ ompTerminalHandoff: true })).toBe(true);
    expect(hasOmpTerminalHandoff(null)).toBe(false);
    expect(hasOmpTerminalHandoff({ ompTerminalHandoff: "true" })).toBe(false);
    expect(ompTerminalOnlyCommand("/tree")).toBe("tree");
    expect(ompTerminalOnlyCommand("/login openai")).toBe("login");
    expect(ompTerminalOnlyCommand("/model openai/gpt-5.4")).toBeUndefined();
    expect(ompTerminalOnlyCommand("/Users/denis/project")).toBeUndefined();
  });
});
