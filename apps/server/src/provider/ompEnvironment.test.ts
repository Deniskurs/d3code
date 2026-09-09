import { describe, expect, it } from "vite-plus/test";
import { withOmpSearchPath } from "./ompEnvironment.ts";

describe("OMP executable discovery", () => {
  it("preserves an existing installation's PATH priority and adds native install locations", () => {
    const env = { PATH: "/custom/bin:/usr/bin", OMP_PROFILE: "work" };
    const result = withOmpSearchPath(env, "darwin", "/Users/alice");
    expect(result.PATH?.split(":")).toEqual([
      "/custom/bin",
      "/usr/bin",
      "/Users/alice/.local/bin",
      "/Users/alice/.bun/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
    expect(result.OMP_PROFILE).toBe("work");
    expect(env.PATH).toBe("/custom/bin:/usr/bin");
  });
  it("finds a Windows native install without creating competing PATH variables", () => {
    const result = withOmpSearchPath(
      { Path: "C:\\Windows", LOCALAPPDATA: "D:\\Local" },
      "win32",
      "C:\\Users\\alice",
    );
    expect(result.Path).toBe("C:\\Windows;D:\\Local\\omp;C:\\Users\\alice\\.bun\\bin");
    expect(result.PATH).toBeUndefined();
  });
});
