// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ReasoningHistoryPage } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import { ReasoningHistory } from "./ReasoningHistory";

const { loadPage } = vi.hoisted(() => ({ loadPage: vi.fn() }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/reasoning-history", () => ({
  createReasoningHistoryCommand: () => ({}),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => loadPage }));

let container: HTMLDivElement;
let root: Root;
const baseProps: ComponentProps<typeof ReasoningHistory> = {
  threadRef: { environmentId: EnvironmentId.make("env-a"), threadId: ThreadId.make("thread-a") },
  itemId: "omp-thinking:turn-a:0",
  preview: "Bounded live tail",
};

async function render(props = baseProps) {
  await act(() => root.render(<ReasoningHistory {...props} />));
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((el) => el.textContent === label);
  if (!button) throw new Error(`Missing action: ${label}`);
  await act(() => button.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  loadPage.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps the preview cheap until the explicit action, pages once, and releases history on return", async () => {
  loadPage
    .mockResolvedValueOnce(AsyncResult.success({ text: "Older <thought> ", nextCursor: 31 }))
    .mockResolvedValueOnce(AsyncResult.success({ text: "newer thought", nextCursor: null }));
  await render();
  await render({ ...baseProps, preview: "Updated bounded tail" });
  expect(loadPage).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Updated bounded tail");
  await click("View full thinking history");
  expect(container.querySelector("pre")?.textContent).toBe("Older <thought> ");
  expect(container.querySelector("thought")).toBeNull();
  expect(container.textContent).not.toContain("Updated bounded tail");
  expect(loadPage).toHaveBeenCalledTimes(1);
  await click("Load more");
  expect(container.querySelector("pre")?.textContent).toBe("Older <thought> newer thought");
  expect(loadPage.mock.calls[1]?.[0].input.cursor).toBe(31);
  expect(container.textContent).not.toContain("Load more");
  await click("Back to preview");
  expect(container.textContent).toContain("Updated bounded tail");
  expect(container.textContent).not.toContain("Older <thought>");
});

it("offers retry on a page error without losing or repeating earlier text", async () => {
  loadPage
    .mockResolvedValueOnce(AsyncResult.success({ text: "Saved first page", nextCursor: 41 }))
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValueOnce(AsyncResult.success({ text: " and next page", nextCursor: null }));
  await render();
  await click("View full thinking history");
  await click("Load more");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(container.querySelector("pre")?.textContent).toBe("Saved first page");
  await click("Retry");
  expect(container.querySelector("pre")?.textContent).toBe("Saved first page and next page");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps saved text accessible and identifies a storage-limited history", async () => {
  loadPage.mockResolvedValueOnce(
    AsyncResult.success({
      text: "Retained earlier thinking",
      nextCursor: null,
      truncated: true,
    }),
  );
  await render();
  await click("View full thinking history");
  expect(container.querySelector("pre")?.textContent).toBe("Retained earlier thinking");
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  await click("Back to preview");
  expect(container.textContent).toContain("Bounded live tail");
});

describe("reader identity", () => {
  it.each([
    {
      name: "environment",
      props: {
        ...baseProps,
        threadRef: { ...baseProps.threadRef, environmentId: EnvironmentId.make("env-b") },
      },
    },
    {
      name: "thread",
      props: {
        ...baseProps,
        threadRef: { ...baseProps.threadRef, threadId: ThreadId.make("thread-b") },
      },
    },
    { name: "item", props: { ...baseProps, itemId: "omp-thinking:turn-b:0" } },
  ])(
    "ignores the previous $name response and requires a new explicit action",
    async ({ props }) => {
      let resolveOldPage!: (page: AsyncResult.Success<ReasoningHistoryPage>) => void;
      const oldPage = new Promise<AsyncResult.Success<ReasoningHistoryPage>>((resolve) => {
        resolveOldPage = resolve;
      });
      loadPage
        .mockReturnValueOnce(oldPage)
        .mockResolvedValueOnce(
          AsyncResult.success({ text: "Current identity's thoughts", nextCursor: null }),
        );
      await render();
      await click("View full thinking history");
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      await render(props);
      await act(() =>
        resolveOldPage(
          AsyncResult.success({ text: "Other identity's thoughts", nextCursor: null }),
        ),
      );
      expect(loadPage).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain("Other identity's thoughts");
      expect(container.textContent).toContain("View full thinking history");
      await click("View full thinking history");
      expect(container.querySelector("pre")?.textContent).toBe("Current identity's thoughts");
    },
  );
});
