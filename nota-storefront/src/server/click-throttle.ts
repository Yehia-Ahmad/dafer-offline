// Online Stage 7A: caps how many /go clicks are COUNTED per client address and campaign per window. Going over the cap never refuses or delays
// the visitor (they are always redirected, see go-redirect.ts); only the click count is skipped. Many real customers can share one address
// (mobile carriers put thousands of subscribers behind one), so nginx lets /go through almost unlimited and the cap lives here.
export class ClickThrottle {
  private readonly slots = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 20_000,
  ) {}

  /** True while the key is under its cap for the current window (and this click uses one slot); false = do not count this click. */
  allow(key: string): boolean {
    const at = this.now();
    let slot = this.slots.get(key);
    if (!slot || at - slot.start >= this.windowMs) {
      if (!slot && this.slots.size >= this.maxKeys) this.sweep(at);
      slot = { start: at, count: 0 };
      this.slots.set(key, slot);
    }
    if (slot.count >= this.limit) return false;
    slot.count += 1;
    return true;
  }

  size(): number { return this.slots.size; }

  /** Drops expired windows; if that is not enough (an attack with many addresses) forgets the oldest half, so memory stays bounded. */
  private sweep(at: number): void {
    for (const [key, slot] of this.slots) if (at - slot.start >= this.windowMs) this.slots.delete(key);
    if (this.slots.size < this.maxKeys) return;
    let drop = Math.ceil(this.slots.size / 2);
    for (const key of this.slots.keys()) { if (drop-- <= 0) break; this.slots.delete(key); }
  }
}
