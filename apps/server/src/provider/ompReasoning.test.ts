import { describe, expect, it } from "vite-plus/test";
import { OmpReasoning } from "./ompReasoning.ts";
import { splitReasoningDelta } from "./reasoningHistory.ts";

describe("OMP thinking snapshots", () => {
  it("coalesces history deltas and flushes the final tail exactly once", () => {
    const reasoning = new OmpReasoning();
    const snapshots = [reasoning.append("First", 0)];
    expect(reasoning.append(" second", 50)).toBeUndefined();
    snapshots.push(reasoning.append(" third", 200));
    expect(reasoning.append(" last", 201)).toBeUndefined();
    snapshots.push(reasoning.finish());
    expect(snapshots.map((snapshot) => snapshot?.historyDelta).join("")).toBe(
      "First second third last",
    );
    expect(snapshots.at(-1)).toMatchObject({
      segment: 0,
      text: "First second third last",
      completed: true,
    });
    expect(reasoning.finish()).toBeUndefined();
    expect(reasoning.append("Next", 202)).toMatchObject({
      segment: 1,
      text: "Next",
      historyDelta: "Next",
      completed: false,
    });
  });

  it("bounds live previews while retaining every emitted character under burst backpressure", () => {
    const reasoning = new OmpReasoning();
    const original = "old".repeat(40_000) + " newest";
    const snapshots = [];
    let now = 0;
    for (const delta of splitReasoningDelta(original)) {
      const snapshot = reasoning.append(delta, now);
      if (snapshot) {
        snapshots.push(snapshot);
        now += snapshot.delayMs;
      }
    }
    snapshots.push(reasoning.finish()!);
    expect(snapshots.map((snapshot) => snapshot.historyDelta).join("")).toBe(original);
    expect(snapshots.at(-1)?.text).toBe(original.slice(-8_000));
    for (const snapshot of snapshots) {
      expect(snapshot.text.length).toBeLessThanOrEqual(8_000);
      expect(snapshot.historyDelta.length).toBeLessThan(40_000);
    }
    expect(snapshots.filter((snapshot) => snapshot.delayMs > 0).length).toBeGreaterThan(0);
  });

  it("does not split unicode pairs at record or preview boundaries", () => {
    const text = "a".repeat(7_999) + "😀" + "b".repeat(7_999);
    const reasoning = new OmpReasoning();
    const chunks = Array.from(splitReasoningDelta(text));
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.isWellFormed()).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(8_000);
      const snapshot = reasoning.append(chunk, 0);
      if (snapshot) expect(snapshot.text.isWellFormed()).toBe(true);
    }
    expect(reasoning.finish()?.text.isWellFormed()).toBe(true);
  });
});
