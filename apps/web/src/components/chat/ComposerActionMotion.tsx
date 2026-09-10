import { createContext, useContext, useLayoutEffect, useRef, type ComponentProps } from "react";
import { createComposerActionMotion } from "./ComposerPrimaryActions.motion";

const MotionContext = createContext(false);

/** Nested primary actions join the footer's motion scope, including attachment. */
export function ComposerActionMotion({ children, ...props }: ComponentProps<"div">) {
  const hasParentMotion = useContext(MotionContext);
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (hasParentMotion || !host.current) return;
    const motion = createComposerActionMotion(host.current);
    motion.update();
    return () => motion.dispose();
  }, [hasParentMotion]);

  if (hasParentMotion) return children;
  return (
    <MotionContext value>
      <div {...props} ref={host} style={{ ...props.style, position: "relative" }}>
        {children}
      </div>
    </MotionContext>
  );
}
