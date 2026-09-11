import { describe, expect, it, vi } from "vite-plus/test";

import { createRightPanelTabMotion } from "./RightPanelTabs.motion";

class TestAnimation extends EventTarget {
  cancel = vi.fn(() => this.dispatchEvent(new Event("cancel")));
  constructor(
    readonly frames: Keyframe[],
    readonly timing: KeyframeAnimationOptions,
  ) {
    super();
  }
  finish() {
    this.dispatchEvent(new Event("finish"));
  }
}

function fixture() {
  const media = Object.assign(new EventTarget(), { matches: false });
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    defaultView: { matchMedia: () => media, getComputedStyle: () => ({ opacity: "0.93" }) },
  });
  let selected: {
    offsetLeft: number;
    offsetTop: number;
    offsetWidth: number;
    offsetHeight: number;
  } | null = null;
  const row = {
    ownerDocument: document,
    querySelector: vi.fn(() => selected),
    getBoundingClientRect: () => ({ left: -30, top: 0 }),
  };
  const indicatorAnimations: TestAnimation[] = [];
  const contentAnimations: TestAnimation[] = [];
  const indicator = {
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ left: 10, top: 0, width: 80, height: 24 }),
    animate(frames: Keyframe[], timing: KeyframeAnimationOptions) {
      const animation = new TestAnimation(frames, timing);
      indicatorAnimations.push(animation);
      return animation;
    },
  };
  const content = {
    animate(frames: Keyframe[], timing: KeyframeAnimationOptions) {
      const animation = new TestAnimation(frames, timing);
      contentAnimations.push(animation);
      return animation;
    },
  };
  const motion = createRightPanelTabMotion(
    row as unknown as HTMLElement,
    indicator as unknown as HTMLElement,
    content as unknown as HTMLElement,
  );
  return {
    motion,
    document,
    media,
    row,
    indicator,
    indicatorAnimations,
    contentAnimations,
    select(id: string | null, x = 0, width = 80, duration = 250, native = false) {
      selected =
        id === null ? null : { offsetLeft: x, offsetTop: 0, offsetWidth: width, offsetHeight: 24 };
      motion.update(id, duration, native);
    },
    resize(x: number, width: number) {
      selected = { offsetLeft: x, offsetTop: 0, offsetWidth: width, offsetHeight: 24 };
      motion.measure();
    },
  };
}

describe("right panel tab motion", () => {
  it("uses the selected duration for both indicator and content after preference changes", () => {
    const f = fixture();
    f.select("a");
    f.select("b", 100);
    expect(f.indicatorAnimations[0]?.timing.duration).toBe(250);
    expect(f.contentAnimations[0]?.timing.duration).toBe(250);
    f.select("c", 200, 80, 400);
    expect(f.indicatorAnimations[1]?.timing.duration).toBe(400);
    expect(f.contentAnimations[1]?.timing.duration).toBe(400);
    f.motion.dispose();
  });

  it("retargets rapid selection from the visible background and releases superseded effects", () => {
    const f = fixture();
    f.select("a");
    f.select("b", 100, 100);
    const first = f.indicatorAnimations[0]!;
    const firstFade = f.contentAnimations[0]!;
    f.select("c", 220, 120);
    const second = f.indicatorAnimations[1]!;
    const secondFade = f.contentAnimations[1]!;
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(firstFade.cancel).toHaveBeenCalledOnce();
    // The row is scrolled 30px: the visible background starts 40px into it.
    expect(second.frames[0]?.transform).toBe("translate(40px, 0px) scale(0.6666666666666666, 1)");
    expect(secondFade.frames[0]?.opacity).toBe("0.93");
    first.finish();
    expect(second.cancel).not.toHaveBeenCalled();
    second.finish();
    secondFade.finish();
    expect(second.cancel).toHaveBeenCalledOnce();
    f.motion.dispose();
    expect(second.cancel).toHaveBeenCalledOnce();
    expect(secondFade.cancel).toHaveBeenCalledOnce();
  });

  it("keeps native content unchanged, then fades only an actual DOM surface change", () => {
    const f = fixture();
    f.select("a");
    expect(f.indicatorAnimations).toHaveLength(0);
    expect(f.contentAnimations).toHaveLength(0);
    f.select("browser", 100, 80, 250, true);
    expect(f.indicatorAnimations).toHaveLength(1);
    expect(f.contentAnimations).toHaveLength(0);
    f.select("diff", 200);
    const fade = f.contentAnimations[0]!;
    f.select("diff", 200);
    f.resize(180, 90);
    expect(f.contentAnimations).toHaveLength(1);
    expect(fade.cancel).not.toHaveBeenCalled();
    expect(f.indicator.style.transform).toBe("translate(180px, 0px)");
    expect(f.indicator.style.width).toBe("90px");
    expect(f.indicatorAnimations[1]!.cancel).toHaveBeenCalledOnce();
    f.select(null);
    expect(f.indicator.style.visibility).toBe("hidden");
    f.motion.dispose();
  });

  it("settles hidden documents and reduced motion without replaying on restoration", () => {
    const f = fixture();
    f.select("a");
    f.select("b", 100);
    f.document.hidden = true;
    f.document.dispatchEvent(new Event("visibilitychange"));
    expect(f.indicatorAnimations[0]!.cancel).toHaveBeenCalledOnce();
    expect(f.contentAnimations[0]!.cancel).toHaveBeenCalledOnce();
    f.select("c", 200);
    f.document.hidden = false;
    f.document.dispatchEvent(new Event("visibilitychange"));
    expect(f.indicator.style.transform).toBe("translate(200px, 0px)");
    expect(f.indicatorAnimations).toHaveLength(1);
    f.select("d", 300);
    f.media.matches = true;
    f.media.dispatchEvent(new Event("change"));
    expect(f.indicatorAnimations[1]!.cancel).toHaveBeenCalledOnce();
    expect(f.contentAnimations[1]!.cancel).toHaveBeenCalledOnce();
    f.select("e", 400);
    expect(f.indicator.style.transform).toBe("translate(400px, 0px)");
    expect(f.indicatorAnimations).toHaveLength(2);
    f.motion.dispose();
  });

  it("zero duration and disposal cancel running motion and detach event work", () => {
    const f = fixture();
    f.select("a");
    f.select("b", 100);
    f.select("b", 100, 80, 0);
    expect(f.indicatorAnimations[0]!.cancel).toHaveBeenCalledOnce();
    expect(f.contentAnimations[0]!.cancel).toHaveBeenCalledOnce();
    f.select("c", 200, 80, 0);
    expect(f.indicator.style.transform).toBe("translate(200px, 0px)");
    expect(f.contentAnimations).toHaveLength(1);
    f.select("d", 300);
    const running = f.indicatorAnimations[1]!;
    f.motion.dispose();
    expect(running.cancel).toHaveBeenCalledOnce();
    f.row.querySelector.mockClear();
    f.document.dispatchEvent(new Event("visibilitychange"));
    f.media.dispatchEvent(new Event("change"));
    f.motion.measure();
    f.select("e", 400);
    expect(f.row.querySelector).not.toHaveBeenCalled();
    expect(f.indicatorAnimations).toHaveLength(2);
  });
});
