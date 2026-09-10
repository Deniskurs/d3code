const settleTiming = { duration: 180, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
const fadeTiming = { duration: 140, easing: settleTiming.easing };

type Position = { x: number; y: number; width: number; height: number };
type Control = Position & {
  node: HTMLElement;
  version: string;
  copy: HTMLElement;
};
type Motion = { animation: Animation; x: number; y: number; opacity: number };
type VisualOffset = { x: number; y: number; opacity: number };

export interface ComposerActionMotionController {
  update: () => void;
  dispose: () => void;
}

function progress(animation: Animation) {
  return animation.playState === "finished"
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0);
}

// SVG artwork uses local paint-server references. Rename IDs and their references
// together rather than leaving duplicate IDs or breaking gradients in retired art.
let retiredId = 0;
function retireCopy(copy: HTMLElement) {
  const elements = [copy, ...copy.querySelectorAll("*")];
  const ids = new Map<string, string>();
  for (const element of elements) {
    const id = element.getAttribute("id");
    if (id) ids.set(id, `composer-retired-${++retiredId}`);
  }
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === "id") {
        element.setAttribute("id", ids.get(attribute.value)!);
      } else if (
        attribute.name.startsWith("aria-") ||
        attribute.name.startsWith("data-") ||
        attribute.name.startsWith("on") ||
        attribute.name === "name" ||
        attribute.name === "for"
      ) {
        element.removeAttribute(attribute.name);
      } else {
        let value = attribute.value.replace(
          /url\(["']?#([^\s)"']+)["']?\)/g,
          (match, id: string) => (ids.has(id) ? `url(#${ids.get(id)})` : match),
        );
        if (
          (attribute.name === "href" || attribute.name === "xlink:href") &&
          value.startsWith("#")
        ) {
          const replacement = ids.get(value.slice(1));
          if (replacement) value = `#${replacement}`;
        }
        if (value !== attribute.value) element.setAttribute(attribute.name, value);
      }
    }
    // Descendants can explicitly enable pointer events (including coarse-pointer
    // hit-area pseudo elements); the entire retired subtree must remain inert.
    if (element instanceof HTMLElement || element instanceof SVGElement) {
      element.style.pointerEvents = "none";
      element.style.animation = "none";
      element.style.transition = "none";
    }
  }
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
}

/** Event-driven FLIP for the small, right-anchored composer action cluster. */
export function createComposerActionMotion(parent: HTMLDivElement) {
  const document = parent.ownerDocument;
  const view = document.defaultView;
  const reducedMotion = view?.matchMedia?.("(prefers-reduced-motion: reduce)");
  let controls: Map<string, Control> | null = null;
  let disposed = false;
  const moving = new Map<HTMLElement, Motion>();
  const retired = new Map<HTMLElement, Animation>();

  const remaining = (node: HTMLElement) => {
    const motion = moving.get(node);
    const rest = motion ? 1 - progress(motion.animation) : 0;
    return {
      x: (motion?.x ?? 0) * rest,
      y: (motion?.y ?? 0) * rest,
      opacity: motion ? 1 - (1 - motion.opacity) * rest : 1,
    };
  };
  const cancel = (node: HTMLElement) => {
    moving.get(node)?.animation.cancel();
    moving.delete(node);
  };
  const clearRetired = () => {
    for (const [copy, animation] of retired) {
      animation.cancel();
      copy.remove();
    }
    retired.clear();
  };
  const settle = () => {
    for (const node of moving.keys()) cancel(node);
    clearRetired();
  };
  const fadeOut = (control: Control, offset: VisualOffset) => {
    const copy = control.copy;
    retireCopy(copy);
    Object.assign(copy.style, {
      position: "absolute",
      left: `${parent.clientWidth + control.x + offset.x}px`,
      top: `${control.y + offset.y}px`,
      width: `${control.width}px`,
      height: `${control.height}px`,
      margin: "0",
      boxSizing: "border-box",
      transform: "none",
      scale: "none",
      filter: `opacity(${offset.opacity})`,
    });
    parent.append(copy);
    const animation = copy.animate(
      [
        { filter: `opacity(${offset.opacity})`, transform: "none" },
        { filter: "opacity(0)", transform: "translateY(4px)" },
      ],
      fadeTiming,
    );
    retired.set(copy, animation);
    const remove = () => {
      if (retired.get(copy) !== animation) return;
      retired.delete(copy);
      copy.remove();
    };
    animation.addEventListener("finish", remove, { once: true });
    animation.addEventListener("cancel", remove, { once: true });
  };

  const update = () => {
    if (disposed) return;
    const origin = parent.getBoundingClientRect();
    const next = new Map<string, Control>();
    const canAnimate =
      controls !== null &&
      !reducedMotion?.matches &&
      !document.hidden &&
      typeof parent.animate === "function";
    for (const node of parent.querySelectorAll<HTMLElement>("[data-composer-action]")) {
      const key = node.dataset.composerAction!;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const offset = remaining(node);
      const previous = controls?.get(key);
      const version = node.dataset.composerActionVersion ?? "";
      next.set(key, {
        node,
        x: rect.left - origin.right - offset.x,
        y: rect.top - origin.top - offset.y,
        width: rect.width,
        height: rect.height,
        version,
        copy:
          previous?.node === node && previous.copy.isEqualNode(node)
            ? previous.copy
            : (node.cloneNode(true) as HTMLElement),
      });
    }
    if (!canAnimate) {
      settle();
      controls = next;
      return;
    }
    const changed =
      [...controls!].some(([key, old]) => {
        const current = next.get(key);
        return (
          !current ||
          current.node !== old.node ||
          current.version !== old.version ||
          Math.abs(current.x - old.x) >= 0.5 ||
          Math.abs(current.y - old.y) >= 0.5 ||
          Math.abs(current.width - old.width) >= 0.5 ||
          Math.abs(current.height - old.height) >= 0.5
        );
      }) || [...next.keys()].some((key) => !controls!.has(key));
    if (!changed) {
      controls = next;
      return;
    }
    clearRetired();
    for (const [key, old] of controls!) {
      const current = next.get(key);
      if (!current || current.version !== old.version) fadeOut(old, remaining(old.node));
    }
    for (const [key, current] of next) {
      const previous = controls!.get(key);
      const offset = previous ? remaining(previous.node) : { x: 0, y: 0, opacity: 0 };
      const changedContent = previous !== undefined && previous.version !== current.version;
      // Keep changing pill widths anchored to the rail's right edge, rather
      // than briefly pushing a longer label outside the composer.
      const x = previous ? previous.x + previous.width + offset.x - current.x - current.width : 0;
      const y = previous
        ? previous.y + previous.height / 2 + offset.y - current.y - current.height / 2
        : 4;
      const opacity = changedContent ? 0 : offset.opacity;
      cancel(current.node);
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5 && opacity === 1) continue;
      const animation = current.node.animate(
        [
          { transform: `translate(${x}px, ${y}px)`, filter: `opacity(${opacity})` },
          { transform: "none", filter: "opacity(1)" },
        ],
        previous && !changedContent ? settleTiming : fadeTiming,
      );
      moving.set(current.node, { animation, x, y, opacity });
      const remove = () => {
        if (moving.get(current.node)?.animation === animation) moving.delete(current.node);
      };
      animation.addEventListener("finish", remove, { once: true });
      animation.addEventListener("cancel", remove, { once: true });
    }
    for (const [key, old] of controls!) {
      if (next.get(key)?.node !== old.node) cancel(old.node);
    }
    controls = next;
  };
  const reset = () => {
    settle();
    controls = null;
    update();
  };
  const onVisibilityChange = () => {
    reset();
  };
  reducedMotion?.addEventListener("change", reset);
  document.addEventListener("visibilitychange", onVisibilityChange);
  view?.addEventListener("resize", reset);
  return {
    update,
    dispose() {
      disposed = true;
      settle();
      controls = null;
      reducedMotion?.removeEventListener("change", reset);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      view?.removeEventListener("resize", reset);
    },
  };
}
