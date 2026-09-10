import { describe, expect, it } from "vite-plus/test";
import { ompSessionIdFromInput } from "./ompSessionLookup";

const id = "01a06cde-947c-733f-86cc-b2002528bbb4";
describe("OMP session lookup input", () => {
  it("accepts a session ID and native resume commands", () => {
    for (const input of [
      id,
      ` ${id.toUpperCase()} `,
      `omp --resume ${id}`,
      `omp --resume="${id}"`,
      `"/my tools/omp" --profile work --resume ${id}`,
    ]) {
      expect(ompSessionIdFromInput(input)).toBe(id);
    }
  });
  it("leaves titles and partial hashes as ordinary searches", () => {
    for (const input of [
      "Fix onboarding",
      "01a06cde",
      "omp --resume missing",
      `echo --resume ${id}`,
      `omp --resume ${id} --resume ${id}`,
    ]) {
      expect(ompSessionIdFromInput(input)).toBeUndefined();
    }
  });
});
