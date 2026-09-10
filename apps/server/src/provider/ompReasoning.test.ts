import { describe, expect, it } from "vite-plus/test";
import { OmpReasoning } from "./ompReasoning.ts";

describe("OMP thinking snapshots", () => {
  it("streams a first preview, coalesces rapid tokens, and flushes the complete segment", () => {
    const reasoning = new OmpReasoning();
    expect(reasoning.append("First", 0)?.text).toBe("First");
    expect(reasoning.append(" second", 50)).toBeUndefined();
    expect(reasoning.append(" third", 200)?.text).toBe("First second third");
    expect(reasoning.append(" last", 201)).toBeUndefined();
    expect(reasoning.finish()).toEqual({
      segment: 0,
      text: "First second third last",
      completed: true,
    });
    expect(reasoning.finish()).toBeUndefined();
    expect(reasoning.append("Next", 202)).toEqual({ segment: 1, text: "Next", completed: false });
  });

  it("bounds snapshots and keeps the most recent text", () => {
    const reasoning = new OmpReasoning();
    reasoning.append("old".repeat(4_000), 0);
    reasoning.append(" newest", 1);
    const snapshot = reasoning.finish();
    expect(snapshot?.text.length).toBe(8_000);
    expect(snapshot?.text.endsWith(" newest")).toBe(true);
  });
});
