import { inquiryRequestIsCurrent, updateInquiryPreview, subscribeInquiry, type InquiryRequest } from "./inquiry-session";

type FrameClock = {
  now: () => number;
  request: (callback: (time: number) => void) => number;
  cancel: (id: number) => void;
};

/** One presentation cursor per request, independent of the mounted Ask surface. */
export class InquiryReveal {
  private text = "";
  private visible = 0;
  private ends: number[] = [];
  private next = 0;
  private frame: number | null = null;
  private last = 0;
  private credit = 0;
  private deadline: number | null = null;
  private settled: (() => void) | null = null;
  private cancelled = false;
  private readonly segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  constructor(private readonly render: (text: string) => void, private readonly clock: FrameClock, private readonly immediate: () => boolean) {}

  append(text: string) {
    if (this.cancelled) return;
    this.text += text;
    this.queue();
  }

  finish(text: string): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    const compatible = text.startsWith(this.text.slice(0, this.visible));
    this.text = text;
    // Final validated content wins if it differs from the provisional preview.
    if (!compatible) { this.flush(); return Promise.resolve(); }
    this.deadline = this.clock.now() + 350;
    return new Promise(resolve => { this.settled = resolve; this.queue(); });
  }

  flush() {
    if (this.cancelled) return;
    if (this.frame !== null) this.clock.cancel(this.frame);
    this.frame = null;
    this.visible = this.text.length;
    this.ends = [];
    this.next = 0;
    this.credit = 0;
    this.render(this.text);
    this.settled?.();
    this.settled = null;
  }

  cancel() {
    this.cancelled = true;
    if (this.frame !== null) this.clock.cancel(this.frame);
    this.frame = null;
    this.settled?.();
    this.settled = null;
  }

  private queue() {
    if (this.immediate()) { this.flush(); return; }
    this.ends = Array.from(this.segmenter.segment(this.text.slice(this.visible)), part => this.visible + part.index + part.segment.length);
    // A later network delta may extend the trailing grapheme (e.g. emoji + ZWJ).
    if (this.deadline === null) this.ends.pop();
    this.next = 0;
    if (!this.ends.length) { this.settled?.(); this.settled = null; return; }
    if (this.frame === null) {
      this.last = this.clock.now();
      this.frame = this.clock.request(this.tick);
    }
  }

  private tick = (time: number) => {
    this.frame = null;
    if (this.cancelled) return;
    if (this.immediate()) { this.flush(); return; }
    const elapsed = Math.max(0, Math.min(64, time - this.last));
    this.last = time;
    const remaining = this.ends.length - this.next;
    // Small deltas read like continuous typing; bursts catch up instead of queuing seconds of animation.
    const horizon = this.deadline === null ? 250 : Math.max(1, this.deadline - time);
    this.credit += elapsed * Math.max(60 / 1000, remaining / horizon);
    const count = Math.min(remaining, Math.floor(this.credit));
    if (count > 0) {
      this.credit -= count;
      this.next += count;
      this.visible = this.ends[this.next - 1];
      this.render(this.text.slice(0, this.visible));
    }
    if (this.cancelled) return;
    if (this.next < this.ends.length) this.frame = this.clock.request(this.tick);
    else { this.credit = 0; this.settled?.(); this.settled = null; }
  };
}

/** Loaded with Ask only; the async request owns this cursor even while its surface is collapsed. */
export function createInquiryReveal(request: InquiryRequest) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const immediate = () => motion.matches || document.hidden;
  const buffer = new InquiryReveal(answer => updateInquiryPreview(request, answer), {
    now: () => performance.now(), request: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id),
  }, immediate);
  const flush = () => { if (immediate()) buffer.flush(); };
  const unsubscribe = subscribeInquiry(() => { if (!inquiryRequestIsCurrent(request)) dispose(); });
  function dispose() {
    unsubscribe(); buffer.cancel();
    motion.removeEventListener("change", flush); document.removeEventListener("visibilitychange", flush);
  }
  motion.addEventListener("change", flush); document.addEventListener("visibilitychange", flush);
  return { buffer, dispose };
}
