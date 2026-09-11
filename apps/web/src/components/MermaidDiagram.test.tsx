import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MermaidDiagram } from "./MermaidDiagram";
import { renderMermaidDiagram } from "./mermaidRenderer";

vi.mock("./mermaidRenderer", () => ({ renderMermaidDiagram: vi.fn() }));

const renderDiagram = vi.mocked(renderMermaidDiagram);
let renderer: ReactTestRenderer | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renderDiagram.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("MermaidDiagram", () => {
  it("keeps streaming source readable and renders only when streaming finishes", async () => {
    renderDiagram.mockResolvedValue("data:image/svg+xml,complete");
    await act(async () => {
      renderer = create(<MermaidDiagram code={"flowchart LR\nA -->"} theme="light" isStreaming />);
    });
    await act(async () => {
      renderer!.update(<MermaidDiagram code={"flowchart LR\nA --> B"} theme="light" isStreaming />);
    });
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("code").children.join("")).toBe("flowchart LR\nA --> B");
    await act(async () => {
      renderer!.update(
        <MermaidDiagram code={"flowchart LR\nA --> B"} theme="light" isStreaming={false} />,
      );
    });
    expect(renderer!.root.findByType("img").props.src).toBe("data:image/svg+xml,complete");
    expect(renderer!.root.findByType("code").children.join("")).toBe("flowchart LR\nA --> B");
    expect(renderDiagram).toHaveBeenCalledTimes(1);
  });

  it("ignores old source and theme completions, including when streaming resumes", async () => {
    const oldSource = deferred<string>();
    const oldTheme = deferred<string>();
    const current = deferred<string>();
    renderDiagram
      .mockReturnValueOnce(oldSource.promise)
      .mockReturnValueOnce(oldTheme.promise)
      .mockReturnValueOnce(current.promise);
    await act(async () => {
      renderer = create(
        <MermaidDiagram code={"flowchart LR\nA --> B"} theme="light" isStreaming={false} />,
      );
    });
    await act(async () => {
      renderer!.update(
        <MermaidDiagram code={"flowchart LR\nA --> C"} theme="light" isStreaming={false} />,
      );
    });
    await act(async () => {
      renderer!.update(
        <MermaidDiagram code={"flowchart LR\nA --> C"} theme="dark" isStreaming={false} />,
      );
    });
    await act(async () => current.resolve("data:image/svg+xml,current-dark"));
    await act(async () => {
      oldSource.resolve("data:image/svg+xml,old-source");
      oldTheme.reject(new Error("Old light theme failed"));
    });
    expect(renderer!.root.findByType("img").props.src).toBe("data:image/svg+xml,current-dark");
    expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
    await act(async () => {
      renderer!.update(<MermaidDiagram code={"flowchart LR\nA --> C"} theme="dark" isStreaming />);
    });
    expect(renderer!.root.findAllByType("img")).toHaveLength(0);
    expect(renderer!.root.findByType("code").children.join("")).toBe("flowchart LR\nA --> C");
  });

  it("shows parser errors with source and recovers when the source is corrected", async () => {
    renderDiagram.mockRejectedValueOnce(new Error("Expected a closing bracket"));
    renderDiagram.mockResolvedValueOnce("data:image/svg+xml,recovered");
    await act(async () => {
      renderer = create(
        <MermaidDiagram code={"flowchart LR\nA["} theme="dark" isStreaming={false} />,
      );
    });
    expect(renderer!.root.findByType("code").children.join("")).toBe("flowchart LR\nA[");
    expect(
      renderer!.root
        .findAllByType("pre")
        .some((pre) => pre.children.includes("Expected a closing bracket")),
    ).toBe(true);
    await act(async () => {
      renderer!.update(
        <MermaidDiagram code={"flowchart LR\nA[Fixed]"} theme="dark" isStreaming={false} />,
      );
    });
    expect(renderer!.root.findByType("img").props.src).toBe("data:image/svg+xml,recovered");
    expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
  });
});
