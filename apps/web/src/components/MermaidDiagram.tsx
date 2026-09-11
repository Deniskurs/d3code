import { useEffect, useState } from "react";

import { renderMermaidDiagram } from "./mermaidRenderer";

interface MermaidDiagramProps {
  code: string;
  theme: "light" | "dark";
  isStreaming: boolean;
}

type DiagramResult = {
  code: string;
  theme: "light" | "dark";
} & ({ image: string; error?: never } | { image?: never; error: string });

export function MermaidDiagram({ code, theme, isStreaming }: MermaidDiagramProps) {
  const [result, setResult] = useState<DiagramResult | null>(null);

  useEffect(() => {
    // A streaming fence can be syntactically valid before it is finished. Wait for the turn,
    // not a debounce or a parser success, so token updates never repeatedly lay out a graph.
    if (isStreaming) return;
    const controller = new AbortController();
    void renderMermaidDiagram(code, theme, controller.signal).then(
      (image) => {
        if (!controller.signal.aborted) setResult({ code, theme, image });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setResult({
            code,
            theme,
            error: cause instanceof Error ? cause.message : "Unable to render this diagram.",
          });
        }
      },
    );
    return () => controller.abort();
  }, [code, theme, isStreaming]);

  const current = !isStreaming && result?.code === code && result.theme === theme ? result : null;
  const source = (
    <pre>
      <code className="language-mermaid">{code}</code>
    </pre>
  );

  return (
    <div className="chat-markdown-mermaid">
      {current?.image ? (
        <>
          <div className="overflow-auto p-3">
            <img
              src={current.image}
              alt="Mermaid diagram"
              className="mx-auto block! h-auto w-full"
            />
          </div>
          <details>
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
              Diagram source
            </summary>
            {source}
          </details>
        </>
      ) : (
        <>
          {!isStreaming && (
            <p role="status" className="px-3 pt-2 text-xs text-muted-foreground">
              {current?.error
                ? "Unable to render diagram. Source is shown below."
                : "Rendering diagram…"}
            </p>
          )}
          {current?.error && (
            <details>
              <summary className="cursor-pointer px-3 text-xs text-muted-foreground">
                Diagram error
              </summary>
              <pre className="text-xs">{current.error}</pre>
            </details>
          )}
          {source}
        </>
      )}
    </div>
  );
}
