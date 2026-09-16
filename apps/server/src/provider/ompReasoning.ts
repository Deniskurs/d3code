/** Bounded snapshots keep native thinking visible without publishing every token. */
export class OmpReasoning {
  private text = "";
  private pending = "";
  private segment = 0;
  private lastEmittedAt = -Infinity;

  /** Call with <=8000-character records; the adapter backpressures capacity flushes. */
  append(delta: string, now: number) {
    if (!delta) return;
    if (delta.length > 8_000)
      throw new RangeError("Split reasoning deltas before accumulating them");
    this.text = (this.text + delta).slice(-8_000);
    // Do not start the preview in the middle of a surrogate pair.
    const first = this.text.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) this.text = this.text.slice(1);
    this.pending += delta;
    const delayMs = Math.max(0, 200 - (now - this.lastEmittedAt));
    if (delayMs > 0 && this.pending.length < 32_000) return;
    this.lastEmittedAt = now + delayMs;
    const historyDelta = this.pending;
    this.pending = "";
    return { segment: this.segment, text: this.text, historyDelta, delayMs, completed: false };
  }

  finish() {
    if (!this.text) return;
    const snapshot = {
      segment: this.segment++,
      text: this.text,
      historyDelta: this.pending,
      delayMs: 0,
      completed: true,
    };
    this.text = "";
    this.pending = "";
    this.lastEmittedAt = -Infinity;
    return snapshot;
  }
}
