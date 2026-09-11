// @vitest-environment jsdom
// Mermaid's DOMPurify sanitizer supports jsdom, not the suite's usual Happy DOM.

import mermaid from "mermaid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderMermaidDiagram } from "./mermaidRenderer";

function svgDocument(image: string): Document {
  expect(image.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  const markup = decodeURIComponent(image.slice(image.indexOf(",") + 1));
  expect(markup).toMatch(/^<svg\b/);
  return new DOMParser().parseFromString(markup, "image/svg+xml");
}

beforeEach(() => {
  // jsdom has no text/SVG layout. Keep the real sanitizer, parser, graph layout and SVG
  // serialization; these measurements are not proof of browser typography or geometry.
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: function (this: SVGElement) {
      return { x: 0, y: 0, width: Math.max(20, (this.textContent?.length ?? 0) * 8), height: 20 };
    },
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value: function (this: SVGElement) {
      return (this.textContent?.length ?? 0) * 8;
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  Reflect.deleteProperty(SVGElement.prototype, "getComputedTextLength");
  vi.restoreAllMocks();
});

describe("Mermaid renderer", () => {
  it("parses a real flowchart and produces an inert SVG image with both nodes and an edge", async () => {
    const code = "flowchart LR\nStart[Ready] --> Finish[Complete]";
    expect(await mermaid.parse(code)).toMatchObject({ diagramType: "flowchart-v2" });
    const svg = svgDocument(
      await renderMermaidDiagram(code, "light", new AbortController().signal),
    );
    expect(svg.documentElement.localName).toBe("svg");
    expect(svg.querySelectorAll(".node")).toHaveLength(2);
    expect(svg.querySelectorAll(".flowchart-link")).toHaveLength(1);
    expect(svg.documentElement.textContent).toContain("Ready");
    expect(svg.documentElement.textContent).toContain("Complete");
    expect(svg.querySelector("foreignObject, script")).toBeNull();
    expect(document.body.querySelector("svg")).toBeNull();
  });

  it("cleans up invalid input and still renders the next diagram", async () => {
    await expect(
      renderMermaidDiagram("flowchart LR\nA[", "dark", new AbortController().signal),
    ).rejects.toBeDefined();
    expect(document.body.querySelector("svg")).toBeNull();
    const svg = svgDocument(
      await renderMermaidDiagram(
        "flowchart LR\nA[Recovered]",
        "dark",
        new AbortController().signal,
      ),
    );
    expect(svg.querySelectorAll(".node")).toHaveLength(1);
    expect(svg.documentElement.textContent).toContain("Recovered");
    expect(document.body.querySelector("svg")).toBeNull();
  });

  it("skips canceled queued work without preventing the next render", async () => {
    const controller = new AbortController();
    const canceled = renderMermaidDiagram("flowchart LR\nA[Canceled]", "light", controller.signal);
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    const svg = svgDocument(
      await renderMermaidDiagram("flowchart LR\nB[Current]", "light", new AbortController().signal),
    );
    expect(svg.documentElement.textContent).toContain("Current");
    expect(svg.documentElement.textContent).not.toContain("Canceled");
  });
});
