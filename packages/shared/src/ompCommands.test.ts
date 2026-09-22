import { describe, expect, it } from "vite-plus/test";
import { isOmpCommandInput } from "./ompCommands.ts";

describe("OMP command input routing", () => {
  it("keeps builtin and extension command syntax on the native dispatcher", () => {
    for (const text of [
      "/plan",
      "  /model provider/model",
      "/skill:review check this",
      "/_review",
      "/计划",
    ])
      expect(isOmpCommandInput(text)).toBe(true);
  });

  it("does not delay ordinary prose, file paths, or a bare slash as native commands", () => {
    for (const text of [
      undefined,
      "",
      "/",
      "// comment",
      "/Users/denis/project",
      "explain /plan",
      "please continue",
    ])
      expect(isOmpCommandInput(text)).toBe(false);
  });
});
