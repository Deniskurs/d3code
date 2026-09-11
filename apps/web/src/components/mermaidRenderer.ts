let renderQueue: Promise<void> = Promise.resolve();
let nextDiagramId = 0;

/** Mermaid has global configuration; serialize initialization with rendering so themes cannot race. */
export function renderMermaidDiagram(
  code: string,
  theme: "light" | "dark",
  signal: AbortSignal,
): Promise<string> {
  const result = renderQueue.then(async () => {
    // Mermaid is a large optional renderer: static loading would penalize every Markdown message.
    signal.throwIfAborted();
    const { default: mermaid } = await import("mermaid");
    signal.throwIfAborted();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
      htmlLabels: false,
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "htmlLabels",
        "dompurifyConfig",
        "theme",
      ],
    });
    // Keep measurement in the document (display:none breaks SVG geometry), but never display
    // Mermaid's temporary DOM or bind its interaction callbacks into the application.
    const container = document.createElement("div");
    container.setAttribute("aria-hidden", "true");
    container.style.cssText =
      "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`markdown-mermaid-${++nextDiagramId}`, code, container);
      signal.throwIfAborted();
      // An SVG image is inert: scripts, links, and embedded document interaction stay disabled.
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } finally {
      container.remove();
    }
  });
  // A malformed diagram must not poison the next queued render.
  renderQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}
