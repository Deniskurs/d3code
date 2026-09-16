import { describe, expect, it, vi } from "vite-plus/test";
import type { ReasoningHistoryPage } from "@t3tools/contracts";

import { createReasoningHistoryReader } from "./reasoningHistory.ts";

function deferredPage() {
  return Promise.withResolvers<ReasoningHistoryPage>();
}

it("loads nothing until requested, advances one page per action, and stops at the saved end", async () => {
  const fetchPage = vi
    .fn<(cursor?: number) => Promise<ReasoningHistoryPage>>()
    .mockResolvedValueOnce({ text: "Earlier ", nextCursor: 19 })
    .mockResolvedValueOnce({ text: "thinking", nextCursor: null });
  const reader = createReasoningHistoryReader(fetchPage);
  const unsubscribe = reader.subscribe(() => {});
  expect(reader.getSnapshot().opened).toBe(false);
  expect(fetchPage).not.toHaveBeenCalled();

  await reader.load();
  expect(reader.getSnapshot().pages.join("")).toBe("Earlier ");
  expect(fetchPage).toHaveBeenCalledTimes(1);
  await reader.load();
  expect(fetchPage).toHaveBeenLastCalledWith(19);
  expect(reader.getSnapshot().pages.join("")).toBe("Earlier thinking");
  await reader.load();
  expect(fetchPage).toHaveBeenCalledTimes(2);
  unsubscribe();
});

it("retains loaded text after an error and retries only the failed page", async () => {
  const fetchPage = vi
    .fn<(cursor?: number) => Promise<ReasoningHistoryPage>>()
    .mockResolvedValueOnce({ text: "First", nextCursor: 12 })
    .mockRejectedValueOnce(new Error("Environment disconnected"))
    .mockResolvedValueOnce({ text: " second", nextCursor: null });
  const reader = createReasoningHistoryReader(fetchPage);
  await reader.load();
  await reader.load();
  expect(reader.getSnapshot()).toMatchObject({
    pages: ["First"],
    error: "Environment disconnected",
    loading: false,
    nextCursor: 12,
  });
  await reader.load();
  expect(fetchPage.mock.calls).toEqual([[undefined], [12], [12]]);
  expect(reader.getSnapshot()).toMatchObject({ pages: ["First", " second"], error: null });
});

it("does not duplicate a page when the reader is clicked while a request is pending", async () => {
  const page = deferredPage();
  const fetchPage = vi.fn(() => page.promise);
  const reader = createReasoningHistoryReader(fetchPage);
  const first = reader.load();
  await reader.load();
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(reader.getSnapshot().loading).toBe(true);
  page.resolve({ text: "Once", nextCursor: null });
  await first;
  expect(reader.getSnapshot().pages).toEqual(["Once"]);
});

describe("closed readers", () => {
  it("releases text and ignores an older pending response after reopening", async () => {
    const oldPage = deferredPage();
    const fetchPage = vi
      .fn<(cursor?: number) => Promise<ReasoningHistoryPage>>()
      .mockImplementationOnce(() => oldPage.promise)
      .mockResolvedValueOnce({ text: "Current history", nextCursor: null });
    const reader = createReasoningHistoryReader(fetchPage);
    const oldRequest = reader.load();
    reader.close();
    expect(reader.getSnapshot()).toMatchObject({ opened: false, pages: [], loading: false });
    await reader.load();
    oldPage.resolve({ text: "Stale text", nextCursor: 99 });
    await oldRequest;
    expect(reader.getSnapshot()).toMatchObject({ pages: ["Current history"], nextCursor: null });
    reader.close();
    expect(reader.getSnapshot().pages).toEqual([]);
  });

  it("does not surface errors from a request completed after collapse", async () => {
    const { promise, reject } = Promise.withResolvers<ReasoningHistoryPage>();
    const reader = createReasoningHistoryReader(() => promise);
    const pending = reader.load();
    reader.close();
    reject(new Error("Obsolete request"));
    await pending;
    expect(reader.getSnapshot()).toMatchObject({ opened: false, error: null, loading: false });
  });
});
