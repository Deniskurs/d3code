/** Bounded snapshots keep native thinking visible without publishing every token. */
export class OmpReasoning {
  private text = "";
  private segment = 0;
  private lastEmittedAt = -Infinity;

  append(delta: string, now: number) {
    if (!delta) return;
    this.text = (this.text + delta).slice(-8_000);
    if (now - this.lastEmittedAt < 200) return;
    this.lastEmittedAt = now;
    return { segment: this.segment, text: this.text, completed: false };
  }

  finish() {
    if (!this.text) return;
    const snapshot = { segment: this.segment++, text: this.text, completed: true };
    this.text = "";
    this.lastEmittedAt = -Infinity;
    return snapshot;
  }
}
