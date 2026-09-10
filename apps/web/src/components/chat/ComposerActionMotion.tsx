import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ComponentProps,
} from "react";
import {
  createComposerActionMotion,
  type ComposerActionMotionController,
} from "./ComposerPrimaryActions.motion";

const MotionContext = createContext<(() => void) | null>(null);

/** Nested primary actions join the footer's motion scope, including attachment. */
export function ComposerActionMotion({ children, ...props }: ComponentProps<"div">) {
  const parentUpdate = useContext(MotionContext);
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<ComposerActionMotionController | null>(null);
  const update = useCallback(() => controller.current?.update(), []);

  useLayoutEffect(() => {
    if (parentUpdate || !host.current) return;
    const motion = createComposerActionMotion(host.current);
    controller.current = motion;
    motion.update();
    return () => {
      motion.dispose();
      controller.current = null;
    };
  }, [parentUpdate]);
  useLayoutEffect(() => {
    (parentUpdate ?? update)();
  });

  if (parentUpdate) return children;
  return (
    <MotionContext value={update}>
      <div {...props} ref={host} style={{ ...props.style, position: "relative" }}>
        {children}
      </div>
    </MotionContext>
  );
}
