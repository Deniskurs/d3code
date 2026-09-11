"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { PANEL_MOTION_EASING, usePanelAnimationSettings } from "~/panelAnimations";

const PopoverCreateHandle = PopoverPrimitive.createHandle;

const Popover = PopoverPrimitive.Root;

function PopoverTrigger({ className, children, ...props }: PopoverPrimitive.Trigger.Props) {
  return (
    <PopoverPrimitive.Trigger className={className} data-slot="popover-trigger" {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  );
}

function PopoverPopup({
  children,
  className,
  viewportClassName,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  tooltipStyle = false,
  anchor,
  style,
  ...props
}: PopoverPrimitive.Popup.Props & {
  viewportClassName?: string;
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  tooltipStyle?: boolean;
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
}) {
  const { active, durationMs } = usePanelAnimationSettings();
  const contentDurationMs = active ? durationMs : 0;
  const motionStyle = {
    "--popup-motion-duration": `${contentDurationMs}ms`,
    "--popup-motion-exit-duration": `${contentDurationMs}ms`,
    "--popup-motion-easing": PANEL_MOTION_EASING,
  } as CSSProperties;

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className={cn(
          "z-[130] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-transform duration-(--popup-motion-duration) ease-(--popup-motion-easing) data-instant:transition-none",
          !active && "transition-none!",
        )}
        data-slot="popover-positioner"
        side={side}
        sideOffset={sideOffset}
        style={motionStyle}
      >
        <PopoverPrimitive.Popup
          className={(state) =>
            cn(
              "dropdown-glass relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[scale,opacity] duration-(--popup-motion-duration) ease-(--popup-motion-easing) before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-[calc(var(--radius-xl)-1px)] data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0 data-ending-style:duration-(--popup-motion-exit-duration) dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
              !active &&
                "transition-none! data-starting-style:scale-100! data-starting-style:opacity-100! data-ending-style:scale-100! data-ending-style:opacity-100!",
              tooltipStyle &&
                "w-fit text-balance rounded-md text-xs shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]",
              !tooltipStyle &&
                "shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
              typeof className === "function" ? className(state) : className,
            )
          }
          data-slot="popover-popup"
          style={(state) => ({
            ...motionStyle,
            ...(typeof style === "function" ? style(state) : style),
          })}
          {...props}
        >
          <PopoverPrimitive.Viewport
            className={cn(
              "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) py-4 [--viewport-inline-padding:--spacing(4)] has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
              "**:data-current:duration-(--popup-motion-duration) **:data-previous:duration-(--popup-motion-duration) **:data-current:ease-(--popup-motion-easing) **:data-previous:ease-(--popup-motion-easing)",
              !active && "**:data-current:transition-none! **:data-previous:transition-none!",
              tooltipStyle
                ? "py-1 [--viewport-inline-padding:--spacing(2)]"
                : "not-data-transitioning:overflow-y-auto",
              viewportClassName,
            )}
            data-slot="popover-viewport"
          >
            {children}
          </PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn("font-semibold text-lg leading-none", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="popover-description"
      {...props}
    />
  );
}

export {
  PopoverCreateHandle,
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverPopup as PopoverContent,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
};
