import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { usePanelAnimationSettings } from "~/panelAnimations";
import { settleWorkspaceLayout } from "../workspaceLayoutMotion";

export function PanelAnimationsPreview({ durationMs }: { durationMs: number }) {
  const [panelsOpen, setPanelsOpen] = useState(true);
  const { active } = usePanelAnimationSettings();
  const cancelMotionRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!active || durationMs === 0) cancelMotionRef.current?.();
    return () => cancelMotionRef.current?.();
  }, [active, durationMs]);

  return (
    <button
      type="button"
      aria-label="Replay panel animation preview"
      className="flex h-10 w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-background p-1 shadow-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      onClick={(event) => {
        setPanelsOpen((open) => !open);
        cancelMotionRef.current?.();
        cancelMotionRef.current = active
          ? settleWorkspaceLayout(event.currentTarget, durationMs)
          : undefined;
      }}
    >
      <span
        aria-hidden
        className={cn(
          "h-full shrink-0 overflow-hidden rounded-md bg-sidebar",
          panelsOpen ? "w-4" : "w-0",
        )}
      />
      <span aria-hidden className="flex min-w-0 flex-1 flex-col px-1">
        <span className="flex min-h-0 flex-1 flex-col gap-1 pt-1">
          <span className="h-0.5 w-full rounded-full bg-muted-foreground/25" />
          <span className="h-0.5 w-4/5 rounded-full bg-muted-foreground/20" />
          <span className="h-0.5 w-3/5 rounded-full bg-muted-foreground/15" />
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center overflow-hidden bg-foreground/5 px-2",
            panelsOpen ? "h-2 border-t border-border/70" : "h-0 border-t-0",
          )}
        >
          <span className="h-px w-2/3 rounded-full bg-muted-foreground/25" />
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          "h-full shrink-0 overflow-hidden rounded-md bg-muted",
          panelsOpen ? "w-5" : "w-0",
        )}
      />
    </button>
  );
}
