import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createComposerActionMotion } from "./ComposerPrimaryActions.motion";

class TestAnimation extends EventTarget {
  progress = 0;
  playState: AnimationPlayState = "running";
  effect = { getComputedTiming: () => ({ progress: this.progress }) };
  readonly frames: Keyframe[];
  constructor(frames: Keyframe[]) {
    super();
    this.frames = frames;
  }
  cancel = vi.fn(() => {
    this.playState = "idle";
    this.dispatchEvent(new Event("cancel"));
  });
  finish() {
    this.playState = "finished";
    this.dispatchEvent(new Event("finish"));
  }
}

class TestControl {
  x = 0;
  y = 0;
  width = 32;
  height = 32;
  inert = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: { name: string; value: string }[] = [];
  children: TestControl[] = [];
  animations: TestAnimation[] = [];
  remove = vi.fn();
  constructor(key: string) {
    this.setAttribute("data-composer-action", key);
  }
  getAttribute(name: string) {
    return this.attributes.find((attribute) => attribute.name === name)?.value ?? null;
  }
  setAttribute(name: string, value: string) {
    this.removeAttribute(name);
    this.attributes.push({ name, value });
    if (name.startsWith("data-")) this.dataset[this.dataKey(name)] = value;
  }
  removeAttribute(name: string) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
    if (name.startsWith("data-")) delete this.dataset[this.dataKey(name)];
  }
  private dataKey(name: string) {
    return name.slice(5).replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
  }
  querySelectorAll(_selector: string): TestControl[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
  }
  isEqualNode(other: TestControl): boolean {
    return (
      JSON.stringify(this.attributes) === JSON.stringify(other.attributes) &&
      this.children.length === other.children.length &&
      this.children.every((child, index) => child.isEqualNode(other.children[index]!))
    );
  }
  cloneNode(_deep: boolean): TestControl {
    const clone = new TestControl(this.dataset.composerAction ?? "");
    clone.attributes = this.attributes.map((attribute) => ({ ...attribute }));
    clone.dataset = { ...this.dataset };
    clone.children = this.children.map((child) => child.cloneNode(true));
    return clone;
  }
  getBoundingClientRect() {
    const motion = this.animations.findLast((animation) => animation.playState === "running");
    const offset = motion ? translation(motion) : [0, 0];
    const remaining = motion ? 1 - motion.progress : 0;
    return {
      left: this.x + offset[0]! * remaining,
      top: this.y + offset[1]! * remaining,
      width: this.width,
      height: this.height,
    };
  }
  animate(frames: Keyframe[]) {
    const animation = new TestAnimation(frames);
    this.animations.push(animation);
    return animation;
  }
}

function translation(animation: TestAnimation) {
  return (
    String(animation.frames[0]?.transform)
      .match(/-?\d+(?:\.\d+)?/g)
      ?.map(Number) ?? [0, 0]
  );
}

function fixture(...nodes: TestControl[]) {
  const media = Object.assign(new EventTarget(), { matches: false });
  const view = Object.assign(new EventTarget(), { matchMedia: () => media });
  const document = Object.assign(new EventTarget(), { defaultView: view, hidden: false });
  const copies: TestControl[] = [];
  const parent = {
    ownerDocument: document,
    clientWidth: 100,
    animate() {},
    getBoundingClientRect: () => ({ right: 100, top: 0 }),
    querySelectorAll: () => nodes,
    append(copy: TestControl) {
      copies.push(copy);
      copy.remove.mockImplementation(() => {
        const index = copies.indexOf(copy);
        if (index !== -1) copies.splice(index, 1);
      });
    },
  };
  const motion = createComposerActionMotion(parent as unknown as HTMLDivElement);
  return {
    motion,
    media,
    document,
    view,
    copies,
    layout: (...next: TestControl[]) => {
      nodes = next;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("HTMLElement", TestControl);
  vi.stubGlobal("SVGElement", TestControl);
});
afterEach(() => vi.unstubAllGlobals());

describe("composer action motion", () => {
  it("settles initial layout and retargets attachment from its interrupted visual position", () => {
    const attachment = new TestControl("attachment");
    attachment.x = 40;
    const { motion } = fixture(attachment);
    motion.update();
    expect(attachment.animations).toHaveLength(0);
    attachment.x = 0;
    motion.update();
    const first = attachment.animations[0]!;
    first.progress = 0.5;
    expect(attachment.getBoundingClientRect().left).toBe(20);
    attachment.x = 10;
    motion.update();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(attachment.getBoundingClientRect().left).toBe(20);
    const second = attachment.animations[1]!;
    motion.update();
    expect(second.cancel).not.toHaveBeenCalled();
    first.finish();
    motion.dispose();
    expect(second.cancel).toHaveBeenCalledOnce();
  });

  it("keeps expanding send labels anchored inside the right edge", () => {
    const send = new TestControl("send");
    send.x = 68;
    const { motion } = fixture(send);
    motion.update();
    send.width = 80;
    send.x = 20;
    send.setAttribute("data-composer-action-version", "steer");
    motion.update();
    const rect = send.getBoundingClientRect();
    expect(rect.left + rect.width).toBe(100);
    motion.dispose();
  });

  it("retires replaced content without duplicate IDs, live hit targets or surviving copies", () => {
    const send = new TestControl("send");
    send.setAttribute("id", "send-button");
    send.setAttribute("data-composer-action-version", "steer");
    const paint = new TestControl("");
    paint.setAttribute("id", "paint");
    const icon = new TestControl("");
    icon.setAttribute("fill", "url(#paint)");
    send.children = [paint, icon];
    const { motion, copies } = fixture(send);
    motion.update();
    send.setAttribute("data-composer-action-version", "queue");
    motion.update();
    const copy = copies[0]!;
    expect(copy.inert).toBe(true);
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    expect(copy.getAttribute("id")).not.toBe("send-button");
    expect(copy.children[0]!.getAttribute("id")).not.toBe("paint");
    expect(copy.children[1]!.getAttribute("fill")).toBe(
      `url(#${copy.children[0]!.getAttribute("id")})`,
    );
    expect([copy, ...copy.children].every((node) => node.style.pointerEvents === "none")).toBe(
      true,
    );
    copy.animations[0]!.finish();
    expect(copies).toHaveLength(0);
    motion.dispose();
  });

  it("discards interrupted label copies and cancels the remaining work on unmount", () => {
    const send = new TestControl("send");
    send.setAttribute("data-composer-action-version", "steer");
    const { motion, copies } = fixture(send);
    motion.update();
    send.setAttribute("data-composer-action-version", "queue");
    motion.update();
    const oldCopy = copies[0]!;
    send.setAttribute("data-composer-action-version", "busy");
    motion.update();
    expect(oldCopy.remove).toHaveBeenCalled();
    expect(oldCopy.animations[0]!.cancel).toHaveBeenCalledOnce();
    const latestCopy = copies[0]!;
    oldCopy.animations[0]!.finish();
    expect(copies).toEqual([latestCopy]);
    motion.dispose();
    expect(copies).toHaveLength(0);
    expect(latestCopy.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(send.animations.every((animation) => animation.playState === "idle")).toBe(true);
  });

  it("cancels exits and entrances immediately when motion is reduced or the document hides", () => {
    const stop = new TestControl("stop");
    const send = new TestControl("send");
    const { motion, layout, media, document, copies } = fixture(stop);
    motion.update();
    layout(send);
    motion.update();
    const entering = send.animations[0]!;
    const exiting = copies[0]!.animations[0]!;
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(entering.cancel).toHaveBeenCalledOnce();
    expect(exiting.cancel).toHaveBeenCalledOnce();
    expect(copies).toHaveLength(0);
    layout(stop);
    motion.update();
    expect(stop.animations).toHaveLength(0);
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    layout(send);
    motion.update();
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(copies).toHaveLength(0);
    expect(send.animations.every((animation) => animation.playState === "idle")).toBe(true);
    motion.dispose();
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    layout(stop);
    motion.update();
    expect(stop.animations).toHaveLength(0);
  });
});
